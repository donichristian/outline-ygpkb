import type { AIChatSession } from "@server/models";
import type { APIContext } from "@server/types";

type Props = {
  /** The session to delete. */
  session: AIChatSession;
  /** The request context, supplying the transaction to write within. */
  ctx: APIContext;
};

/**
 * Deletes an AI chat session and, by way of the foreign key on
 * `ai_chat_messages.sessionId`, every message in it. Sessions are not soft
 * deleted, so this is a permanent removal.
 *
 * @param props the session to delete and the request context.
 * @returns the deleted session.
 */
export default async function aiChatSessionDestroyer({ session, ctx }: Props) {
  return session.destroyWithCtx(ctx);
}
