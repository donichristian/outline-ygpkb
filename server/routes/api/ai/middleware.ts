import type { ChatMiddleware, StreamChunk } from "@tanstack/ai";
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
  /**
   * True when the stored answer carries no document link or identifier that a
   * tool returned in the same run. The turn writer persists it (todo 10).
   */
  citationMiss?: boolean;
  /**
   * Body-free digest of the tool calls made while generating this turn, when
   * any. Persisted into the `toolCallDigest` column. Absent means no tool was
   * called, which lets the empty-text guard drop a turn that produced nothing.
   */
  toolCallDigest?: Record<string, unknown>;
};
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

/** Body-free digest of one tool call made while generating an assistant turn. */
export type ToolCallDigestEntry = {
  /** The tool call identifier within the run. */
  toolCallId: string;
  /** The server tool that ran. */
  toolName: string;
  /** The tool's declared scalar input fields, never a result or body blob. */
  arguments: Record<string, unknown>;
  /** The document identifiers the tool result returned. */
  documentIds: string[];
  /** The document titles the tool result returned. */
  titles: string[];
  /** The document links the tool result returned. */
  links: string[];
  /** The number of characters the tool returned, without the text itself. */
  characterCount: number;
  /** Whether the returned body was truncated. */
  truncated: boolean;
};

/** The body-free tool-call digest persisted with an assistant turn. */
export type ToolCallDigest = {
  toolCalls: ToolCallDigestEntry[];
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
  citationMiss,
  toolCallDigest,
}: AppendTurnProps): Promise<void> {
  if (!sessionId) {
    return;
  }

  // A turn with no text is still written when it carries a tool-call digest,
  // so a run that read a document and then produced no text does not lose the
  // read. Otherwise an empty assistant turn stays a client-side placeholder.
  if (role === AIChatMessageRole.Assistant && !content.trim() && !toolCallDigest) {
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
      citationMiss,
      toolCallDigest,
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
 * Tool-returned document identifiers are collected from `TOOL_CALL_RESULT`
 * chunks, and at the terminal hook the accumulated answer is checked against
 * them: an answer that carries none is a citation miss, logged once and passed
 * to the turn writer so it can be persisted. The check is measure-and-warn
 * only — it never blocks, buffers, or alters the streamed answer.
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
  const toolResultIdentifiers: Set<string> = new Set();
  const toolCalls: ToolCallDigestEntry[] = [];
  const toolCallIndex = new Map<string, ToolCallDigestEntry>();
  const toolCallArguments = new Map<string, string>();
  const toolCallNames = new Map<string, string>();

  /**
   * Parses the tool result a `TOOL_CALL_RESULT` chunk carries and collects its
   * document identifiers (link and id) for the citation-miss check. The
   * engine serializes a tool's structured output into `content` as JSON, so a
   * string payload is parsed back before reading the `results` array.
   *
   * @param chunk the `TOOL_CALL_RESULT` chunk.
   */
  const collectToolResultIdentifiers = (
    chunk: Extract<StreamChunk, { type: "TOOL_CALL_RESULT" }>
  ): void => {
    let result: unknown;
    if (typeof chunk.content === "string") {
      try {
        result = JSON.parse(chunk.content);
      } catch {
        result = undefined;
      }
    } else if (Array.isArray(chunk.content)) {
      // ContentPart array; tool results serialize into the first text part.
      const textPart = chunk.content.find(
        (part): part is { type: "text"; text: string } =>
          part.type === "text" && typeof part.text === "string"
      );
      result = textPart?.text;
      if (typeof result === "string") {
        try {
          result = JSON.parse(result);
        } catch {
          result = undefined;
        }
      } else {
        result = undefined;
      }
    }

    const items =
      result && typeof result === "object" && "results" in result
        ? (result as { results?: unknown }).results
        : undefined;

    const documentIds: string[] = [];
    const titles: string[] = [];
    const links: string[] = [];

    if (Array.isArray(items)) {
      for (const item of items) {
        if (item && typeof item === "object") {
          const identifier = item as {
            documentId?: unknown;
            title?: unknown;
            url?: unknown;
          };
          if (
            typeof identifier.documentId === "string" &&
            identifier.documentId
          ) {
            toolResultIdentifiers.add(identifier.documentId);
            documentIds.push(identifier.documentId);
          }
          if (typeof identifier.title === "string" && identifier.title) {
            titles.push(identifier.title);
          }
          if (typeof identifier.url === "string" && identifier.url) {
            toolResultIdentifiers.add(identifier.url);
            links.push(identifier.url);
          }
        }
      }
    }

    const truncated =
      (result && typeof result === "object" && "truncated" in result
        ? (result as { truncated?: unknown }).truncated === true
        : false) ||
      (Array.isArray(items)
        ? items.some(
            (item) =>
              item &&
              typeof item === "object" &&
              "truncated" in item &&
              (item as { truncated?: unknown }).truncated === true
          )
        : false);

    const characterCount =
      typeof chunk.content === "string"
        ? chunk.content.length
        : Array.isArray(chunk.content)
        ? chunk.content.reduce(
            (sum, part) =>
              sum +
               (part && typeof part === "object" && "text" in part
                 ? (typeof (part as { text?: unknown }).text === "string"
                     ? ((part as { text: string }).text.length)
                     : 0)
                 : 0),
            0
          )
        : 0;

    let entry = toolCallIndex.get(chunk.toolCallId);
    if (!entry) {
      let args: Record<string, unknown> = {};
      const accumulated = toolCallArguments.get(chunk.toolCallId);
      if (accumulated) {
        try {
          const parsed = JSON.parse(accumulated);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          // ignore
        }
      }
      entry = {
        toolCallId: chunk.toolCallId,
        toolName: toolCallNames.get(chunk.toolCallId) ?? "",
        arguments: args,
        documentIds: [],
        titles: [],
        links: [],
        characterCount: 0,
        truncated: false,
      };
      toolCallIndex.set(chunk.toolCallId, entry);
      toolCalls.push(entry);
    } else if (Object.keys(entry.arguments).length === 0) {
      const accumulated = toolCallArguments.get(chunk.toolCallId);
      if (accumulated) {
        try {
          const parsed = JSON.parse(accumulated);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            entry.arguments = parsed as Record<string, unknown>;
          }
        } catch {
          // ignore
        }
      }
      if (!entry.toolName) {
        entry.toolName = toolCallNames.get(chunk.toolCallId) ?? "";
      }
    }
    entry.documentIds = documentIds;
    entry.titles = titles;
    entry.links = links;
    entry.characterCount = characterCount;
    entry.truncated = truncated;
  };

  /**
   * The citation-miss check: grounded only when the accumulated answer text
   * contains an identifier some tool returned in this run. A link the model
   * produced without a tool ever returning it does not count as sourced.
   *
   * @return true when no tool-returned identifier is present in the answer.
   */
  const isCitationMiss = (): boolean => {
    if (toolResultIdentifiers.size === 0) {
      return true;
    }
    for (const identifier of toolResultIdentifiers) {
      if (content.includes(identifier)) {
        return false;
      }
    }
    return true;
  };

  /**
   * Persists the accumulated assistant text, then frees the lock. The release
   * runs even when the write fails or is skipped, so a lost row can never
   * strand the session.
   *
   * @param status how the run ended.
   * @param citationMiss whether the answer carried no tool-returned source.
   */
  const persistAndRelease = async (
    status: AIChatMessageStatus,
    citationMiss: boolean,
    toolCallDigest: Record<string, unknown> | undefined
  ) => {
    if (citationMiss) {
      Logger.warn("AI chat answer carries no tool-returned source", {
        requestId,
        runId,
        reason: "citation-miss",
      });
    }

    const digest =
      toolCallDigest && toolCallDigest.toolCalls
        ? toolCallDigest
        : undefined;

    await appendTurn({
      user,
      sessionId,
      role: AIChatMessageRole.Assistant,
      content,
      status,
      runId,
      ctx,
      requestId,
      citationMiss,
      toolCallDigest: digest,
    });
    await releaseInFlightLock();
  };

  return {
    name: "ai-chat-persist",
     onChunk(_hookCtx, chunk) {
       if (chunk.type === "TEXT_MESSAGE_CONTENT") {
         content += chunk.delta;
       } else if (chunk.type === "TOOL_CALL_START") {
         const start = chunk as Extract<
           StreamChunk,
           { type: "TOOL_CALL_START" }
         >;
         toolCallNames.set(start.toolCallId, start.toolCallName);
         const entry: ToolCallDigestEntry = {
           toolCallId: start.toolCallId,
           toolName: start.toolCallName,
           arguments: {},
           documentIds: [],
           titles: [],
           links: [],
           characterCount: 0,
           truncated: false,
         };
         toolCallIndex.set(start.toolCallId, entry);
         toolCalls.push(entry);
       } else if (chunk.type === "TOOL_CALL_ARGS") {
         const args = chunk as Extract<
           StreamChunk,
           { type: "TOOL_CALL_ARGS" }
         >;
         const prev = toolCallArguments.get(args.toolCallId) ?? "";
         toolCallArguments.set(args.toolCallId, prev + args.delta);
         const entry = toolCallIndex.get(args.toolCallId);
         if (entry) {
           try {
             const parsed = JSON.parse(toolCallArguments.get(args.toolCallId) ?? "");
             if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
               entry.arguments = parsed as Record<string, unknown>;
             }
           } catch {
             // arguments may still be streaming; keep the accumulated string
           }
         }
       } else if (chunk.type === "TOOL_CALL_RESULT") {
         collectToolResultIdentifiers(chunk);
       }
     },
    async onFinish(_hookCtx, info) {
      await persistAndRelease(
        info.finishReason
          ? AIChatMessageStatus.Completed
          : AIChatMessageStatus.Truncated,
        isCitationMiss(),
        toolCalls.length > 0 ? { toolCalls } : undefined
      );
    },
    async onAbort() {
      await persistAndRelease(
        AIChatMessageStatus.Aborted,
        isCitationMiss(),
        toolCalls.length > 0 ? { toolCalls } : undefined
      );
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
          : AIChatMessageStatus.Error,
        isCitationMiss(),
        toolCalls.length > 0 ? { toolCalls } : undefined
      );
    },
  };
}
