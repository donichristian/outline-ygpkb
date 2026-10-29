import type { ChatMiddleware } from "@tanstack/ai";
import { toError } from "@shared/utils/error";
import aiChatMessageCreator from "@server/commands/aiChatMessageCreator";
import Logger from "@server/logging/Logger";
import type { User } from "@server/models";
import {
  AIChatMessageRole,
  AIChatMessageStatus,
} from "@server/models/AIChatMessage";
import { requestContext } from "@server/storage/requestContext";
import type { APIContext } from "@server/types";

/** Inputs for {@link appendTurn}. */
export type AppendTurnProps = {
  /** The user the turn belongs to, who must own the session. */
  user: User;
  /** The stored session to append to, absent for a stateless chat. */
  sessionId?: string;
  /** Who authored the turn. */
  role: AIChatMessageRole;
  /** The turn text. */
  content: string;
  /** How the turn finished. */
  status: AIChatMessageStatus;
  /** The server-minted generation run shared by both rows of the turn. */
  runId: string;
  /** The request context, supplying the authenticated type and client address. */
  ctx: APIContext;
  /** The request id used to correlate a failed write with the request. */
  requestId?: string;
};

/** Inputs for {@link createPersistenceMiddleware}. */
export type PersistenceMiddlewareProps = {
  /** The user the turn belongs to. */
  user: User;
  /** The stored session to persist into, absent for a stateless chat. */
  sessionId?: string;
  /** The server-minted generation run shared by both rows of the turn. */
  runId: string;
  /** The request context the write is attributed to. */
  ctx: APIContext;
  /** The request id used to correlate a failed write with the request. */
  requestId?: string;
  /** Releases the per-session in-flight lock, idempotently. */
  releaseInFlightLock: () => Promise<void>;
};

/** The error code the OpenAI-compatible adapter uses for a stream that ended
 * without a `finish_reason`. */
const IncompleteStreamCode = "incomplete-stream";

/**
 * Appends one row to a stored AI chat session. The single write path shared by
 * the route's pre-stream turn and the middleware's terminal hooks.
 *
 * A stateless chat has no session and writes nothing. An assistant turn with no
 * text writes nothing on every path: the row's `content` is `NOT NULL` and an
 * empty answer is a client-side placeholder, not something the user said.
 *
 * The write runs outside the request's async context. `database.ts` refuses
 * reads whose originating socket is already destroyed, so a flush after a
 * client disconnect fails its own `max(seq)` read and the turn is lost – which
 * is precisely the case the abort path exists to record. That guard exists to
 * stop spending database work on a response nobody will receive, and it is
 * registered on `beforeFind`/`beforeCount` only, so writes were never gated by
 * it: this write's deliverable is the row, not the response. Reads stay guarded
 * everywhere else.
 *
 * A turn that cannot be stored is a lost answer, never a failed request: the
 * bytes are already on the wire, so there is nothing left to report to the
 * client and the stream must still terminate.
 *
 * @param props the turn to append and the session to append it to.
 * @return a promise that resolves once the row is committed or the failure is
 *   logged.
 */
export async function appendTurn({
  user,
  sessionId,
  role,
  content,
  status,
  runId,
  ctx,
  requestId,
}: AppendTurnProps): Promise<void> {
  if (!sessionId) {
    return;
  }

  if (role === AIChatMessageRole.Assistant && !content.trim()) {
    return;
  }

  await requestContext.exit(() =>
    aiChatMessageCreator({
      user,
      sessionId,
      role,
      content,
      status,
      runId,
      ctx,
    }).catch((err) =>
      Logger.error("AI chat turn could not be persisted", toError(err), {
        requestId,
      })
    )
  );
}

/**
 * Reads the `code` an error carries, if any. The engine copies the adapter's
 * `RUN_ERROR` code onto the error it hands to `onError`.
 *
 * @param error the value to inspect.
 * @return the code, or `undefined` when the value carries none.
 */
function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return error.code;
}

/**
 * Builds the chat middleware that owns the assistant row and the in-flight
 * lock for one request.
 *
 * Every terminal hook is awaited by the engine before the SSE stream closes, so
 * awaiting the write here makes the row durable before the client sees the end
 * of the stream. Exactly one of `onFinish`/`onAbort`/`onError` runs per run, and
 * each one releases the lock, so the key is gone on every exit.
 *
 * Assistant text is accumulated from `TEXT_MESSAGE_CONTENT` chunks only, so
 * reasoning text is never stored as the answer. A run that produced no text
 * writes no row while still releasing the lock.
 *
 * The status mapping is:
 * - `onFinish` with a `finishReason` → `completed`.
 * - `onFinish` with a null `finishReason`, or an `incomplete-stream` error →
 *   `truncated`.
 * - `onAbort` → `aborted`.
 * - any other error → `error`.
 *
 * @param props the requester, storage identity, and lock-release primitive.
 * @return the persistence middleware for one `chat()` call.
 */
export function createPersistenceMiddleware({
  user,
  sessionId,
  runId,
  ctx,
  requestId,
  releaseInFlightLock,
}: PersistenceMiddlewareProps): ChatMiddleware {
  let content = "";
  // Token counts ride the terminal `RUN_FINISHED` chunk as a provider-shaped
  // value (`usage[]` per the AG-UI spec, or a TanStack object), so it is kept
  // opaque here and only logged. Shape is provider-defined; nothing branches on
  // it.
  let tokenUsage: unknown;

  /**
   * Persists the accumulated assistant text, then frees the lock. The release
   * runs even when the write fails or is skipped, so a lost row can never
   * strand the session.
   *
   * @param status how the run ended.
   */
  const persistAndRelease = async (status: AIChatMessageStatus) => {
    await appendTurn({
      user,
      sessionId,
      role: AIChatMessageRole.Assistant,
      content,
      status,
      runId,
      ctx,
      requestId,
    });

    // Deliberate: cost is observable but not enforced. Nothing caps spend yet,
    // so the numbers are logged for an operator to read rather than stored.
    if (tokenUsage) {
      Logger.info("http", "AI chat token usage", {
        requestId,
        sessionId,
        runId,
        status,
        usage: tokenUsage,
      });
    }

    await releaseInFlightLock();
  };

  return {
    name: "ai-chat-persist",
    onChunk(_hookCtx, chunk) {
      if (chunk.type === "TEXT_MESSAGE_CONTENT") {
        content += chunk.delta;
      }

      if (chunk.type === "RUN_FINISHED") {
        tokenUsage = chunk.usage;
      }
    },
    async onFinish(_hookCtx, info) {
      await persistAndRelease(
        info.finishReason
          ? AIChatMessageStatus.Completed
          : AIChatMessageStatus.Truncated
      );
    },
    async onAbort() {
      await persistAndRelease(AIChatMessageStatus.Aborted);
    },
    async onError(_hookCtx, info) {
      // The real cause stays server-side; the wire carries a generic message so
      // a provider failure never leaks upstream detail to the client.
      Logger.error("AI chat stream failed", toError(info.error), {
        requestId,
      });

      await persistAndRelease(
        errorCode(info.error) === IncompleteStreamCode
          ? AIChatMessageStatus.Truncated
          : AIChatMessageStatus.Error
      );
    },
  };
}
