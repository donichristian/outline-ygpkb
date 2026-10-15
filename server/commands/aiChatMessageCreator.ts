import { truncate } from "es-toolkit/compat";
import { createContext } from "@server/context";
import { NotFoundError } from "@server/errors";
import { AIChatSession } from "@server/models";
import type { User } from "@server/models";
import AIChatMessage, {
  type AIChatMessageRole,
  AIChatMessageStatus,
} from "@server/models/AIChatMessage";
import {
  retryOnUniqueConstraintError,
  sequelize,
} from "@server/storage/database";
import type { APIContext } from "@server/types";

/** The column width of `ai_chat_sessions.title`. */
const titleMaxLength = 255;

type Props = {
  /** The user appending the message, who must own the session. */
  user: User;
  /** The session to append to. */
  sessionId: string;
  /** Who authored the message. */
  role: AIChatMessageRole;
  /** The message text. */
  content: string;
  /** How generation finished, completed unless stated otherwise. */
  status?: AIChatMessageStatus;
  /** The generation run that produced the message, when known. */
  runId?: string | null;
  /**
   * The request context, supplying the authenticated type and client address.
   * Its transaction is deliberately neither read nor replaced – a streaming
   * context outlives this write and must not be left pointing at a transaction
   * that has committed.
   */
  ctx: APIContext;
};

/**
 * Appends a message to an AI chat session at the next sequence number.
 *
 * The session row is locked `FOR UPDATE` before the current maximum `seq` is
 * read, so two concurrent appends to one session serialize and cannot both
 * choose the same position. The whole transaction is retried on a unique
 * constraint violation because a violation aborts the enclosing transaction in
 * Postgres – retrying the insert alone could not recover from it.
 *
 * @param props the message to append and the session to append it to.
 * @returns the created message.
 * @throws NotFoundError when no session exists for the given id, or when it
 * belongs to another user.
 */
export default async function aiChatMessageCreator({
  user,
  sessionId,
  role,
  content,
  status = AIChatMessageStatus.Completed,
  runId,
  ctx,
}: Props) {
  return retryOnUniqueConstraintError(() =>
    sequelize.transaction(async (transaction) => {
      // A short-lived context bound to this transaction. The caller's context
      // is long-lived and must not be mutated.
      const txCtx = createContext({
        user,
        authType: ctx.state.auth?.type,
        ip: ctx.ip,
        transaction,
      });

      const session = await AIChatSession.findByPk(sessionId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
        rejectOnEmpty: true,
      });

      // Ownership is checked against the locked row rather than an earlier
      // read, so a session deleted or transferred between the request
      // starting and the lock being granted cannot slip through.
      if (session.userId !== user.id || session.teamId !== user.teamId) {
        throw NotFoundError();
      }

      // Safe only because the session row is locked for the rest of this
      // transaction – no other append can read this maximum or insert between
      // the two statements.
      const last = await AIChatMessage.findOne({
        attributes: ["seq"],
        where: { sessionId: session.id },
        order: [["seq", "DESC"]],
        transaction,
      });

      const message = await AIChatMessage.createWithCtx(txCtx, {
        sessionId: session.id,
        role,
        seq: (last?.seq ?? 0) + 1,
        content,
        status,
        runId: runId ?? null,
      });

      const updates: { title?: string } = {};

      // The title is only ever filled in once, a later turn must not rename a
      // conversation the user has already seen.
      if (!session.title) {
        updates.title = truncate(content.trim(), { length: titleMaxLength });
      }

      // An instance update rather than a static one: `save` writes only the
      // attributes `set` marked as changed (plus `updatedAt`), so the column
      // footprint is the targeted one – and unlike the static `update` it fires
      // the instance `@AfterUpdate` hook, so the timestamp bump is audited
      // instead of writing an event row for nothing at all. The row is already
      // held `FOR UPDATE` above, so no concurrent write can be clobbered.
      await session.updateWithCtx(txCtx, updates);

      return message;
    })
  );
}
