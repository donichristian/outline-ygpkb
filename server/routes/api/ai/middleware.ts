import type { ChatMiddleware, StreamChunk, ToolChoice } from "@tanstack/ai";
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
import { fenceRetrievedData, unfenceRetrievedData } from "./prompt";
import { ToolBudgetExhausted } from "./tools";

/**
 * Decodes a tool-result payload into the value the model received. A string is
 * returned as-is; a content-part array yields its first text part, parsed as
 * JSON when it is one.
 *
 * @param content the `TOOL_CALL_RESULT` chunk content.
 * @return the decoded payload, or undefined when it cannot be decoded.
 */
function parseToolResultContent(
  content: Extract<StreamChunk, { type: "TOOL_CALL_RESULT" }>["content"]
): unknown {
  let text: unknown = content;
  if (Array.isArray(content)) {
    const part = content.find(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && typeof item.text === "string"
    );
    text = part?.text;
  }
  if (typeof text !== "string") {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Reports whether a tool-result payload is the budget-refusal sentinel. Only
 * the payload itself counts: either the bare sentinel string or an object
 * whose `error` equals it.
 *
 * @param content the `TOOL_CALL_RESULT` chunk content.
 * @return true when this result is the budget refusal.
 */
function isToolBudgetExhaustedResult(
  content: Extract<StreamChunk, { type: "TOOL_CALL_RESULT" }>["content"]
): boolean {
  const payload = parseToolResultContent(content);
  if (payload === ToolBudgetExhausted) {
    return true;
  }
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as { error?: unknown }).error === ToolBudgetExhausted
  );
}

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
  /**
   * Reject with a {@link PersistenceFailedError} when the row cannot be stored,
   * instead of logging and resolving. Set only by the terminal hook: the
   * pre-stream user turn stays a best-effort write, while an accepted assistant
   * turn that is lost has to reach the client (todo 14).
   */
  surfaceFailure?: boolean;
  /**
   * The prompt tokens the provider reported for the run, or `null` when it
   * reported no usage. Persisted as-is; never estimated here.
   */
  promptTokens?: number | null;
  /**
   * The completion tokens the provider reported for the run, or `null` when it
   * reported no usage. Persisted as-is; never estimated here.
   */
  completionTokens?: number | null;
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
  /**
   * Tool choice forced on the first upstream model call when a document is
   * bound to the request, or `undefined` to leave the default (auto).
   */
  toolChoice?: ToolChoice;
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
  events?: ToolCallDigestEvent[];
};

/** A typed event the turn records next to its tool calls. */
export type ToolCallDigestEvent = {
  /** The turn's tool budget was exhausted and further calls were refused. */
  type: "tool-call-budget-exhausted";
};

/**
 * Builds the body-free digest persisted with the turn, adding the typed budget
 * event when a tool call was refused at the turn's cap.
 *
 * @param toolCalls the tool calls the turn attempted, in order.
 * @param toolBudgetExhausted whether a call was refused at the cap.
 * @return the digest to persist, or undefined when no tool ran.
 */
export function buildToolCallDigest(
  toolCalls: ToolCallDigestEntry[],
  toolBudgetExhausted: boolean
): Record<string, unknown> | undefined {
  if (toolCalls.length === 0) {
    return undefined;
  }

  return toolBudgetExhausted
    ? { toolCalls, events: [{ type: "tool-call-budget-exhausted" }] }
    : { toolCalls };
}

/** The error code the OpenAI-compatible adapter uses for a stream that ended
 * without a `finish_reason`. */
export const IncompleteStreamCode = "incomplete-stream";

/** The error code a client matches to tell a lost answer from a failed run. */
export const PersistenceFailedCode = "persistence-failed";

/**
 * The `RUN_ERROR` code the server stamps on any upstream failure – provider
 * error, timeout, or quota rejection mid-run – so the client can tell "ask
 * again in a moment" from a plain stream failure. The provider's own body never
 * travels with it; `onError` logs the cause server-side.
 */
export const UpstreamUnavailableCode = "upstream_unavailable";

/**
 * Raised by the terminal hook when an accepted assistant turn could not be
 * stored. The engine turns a rejected terminal hook into a trailing
 * `RUN_ERROR` frame, which is the only way a client learns that the answer it
 * just read was never recorded.
 */
class PersistenceFailedError extends Error {
  /** The wire code identifying a lost assistant turn. */
  readonly code = PersistenceFailedCode;

  /** Builds the error with a message that is safe to put on the wire. */
  constructor() {
    super("The assistant turn could not be persisted");
    this.name = "PersistenceFailedError";
  }
}

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
 * client and the stream must still terminate. `surfaceFailure` is the one
 * exception: with it set the caller has decided that a lost answer must not
 * look like a successful run, and the failure is rethrown.
 *
 * @param props the turn to append and the session to append it to.
 * @return a promise that resolves once the row is committed or the failure is
 *   logged.
 * @throws {PersistenceFailedError} when the write fails and `surfaceFailure` is
 *   set.
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
  promptTokens,
  completionTokens,
  surfaceFailure,
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
      promptTokens,
      completionTokens,
    }).catch((err) => {
      Logger.error("AI chat turn could not be persisted", toError(err), {
        requestId,
      });

      if (surfaceFailure) {
        throw new PersistenceFailedError();
      }
    })
  );
}

/** The provider-reported token counts persisted on an assistant turn. */
type PersistedTokenUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
};

/**
 * Reads a token count off a provider-shaped value.
 *
 * @param value the value the provider put where a count belongs.
 * @return the count, or `null` when it is not a token count.
 */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Normalizes the usage a terminal `RUN_FINISHED` chunk carries into the two
 * counts the assistant row stores. The shape is provider-defined: the AG-UI
 * spec defines a `usage[]` array whose entries carry `inputTokens`/
 * `outputTokens`, while the chat-completions adapter attaches a TanStack
 * `TokenUsage` object with `promptTokens`/`completionTokens`. Both are summed
 * per run, because a run may report one entry per upstream model call.
 *
 * A count the provider did not report stays `null`. A fabricated number in a
 * cost column is worse than a missing one, so nothing is estimated here.
 *
 * @param usage the `RUN_FINISHED` usage payload, in any provider shape.
 * @return the two counts, `null` where the provider reported none.
 */
function normalizeTokenUsage(usage: unknown): PersistedTokenUsage {
  if (Array.isArray(usage)) {
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;

    for (const entry of usage) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const spec = entry as { inputTokens?: unknown; outputTokens?: unknown };
      const input = tokenCount(spec.inputTokens);
      const output = tokenCount(spec.outputTokens);

      if (input !== null) {
        promptTokens = (promptTokens ?? 0) + input;
      }
      if (output !== null) {
        completionTokens = (completionTokens ?? 0) + output;
      }
    }

    return { promptTokens, completionTokens };
  }

  if (usage && typeof usage === "object") {
    const object = usage as {
      promptTokens?: unknown;
      completionTokens?: unknown;
      inputTokens?: unknown;
      outputTokens?: unknown;
    };

    return {
      promptTokens: tokenCount(object.promptTokens ?? object.inputTokens),
      completionTokens: tokenCount(
        object.completionTokens ?? object.outputTokens
      ),
    };
  }

  return { promptTokens: null, completionTokens: null };
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
 * Result fields that identify a document rather than carry its text. They stay
 * byte-identical so a citation resolves to the real link, and so the digest
 * keeps storing identifiers the citation-miss check can match.
 */
const UnfencedResultKeys = new Set(["documentId", "url"]);

/**
 * Frames every third-party string inside a tool result with the data
 * sentinels. Identifiers stay bare, scalars are kept as they are, and the
 * result keeps its shape so the engine can still serialize it back to JSON.
 *
 * @param value the tool result value to walk.
 * @param key the field name `value` was stored under, when known.
 * @return the same shape with every text field framed.
 */
function fenceThirdPartyText(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key && UnfencedResultKeys.has(key)
      ? value
      : fenceRetrievedData(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => fenceThirdPartyText(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        fenceThirdPartyText(entryValue, entryKey),
      ])
    );
  }
  return value;
}

/** Absolute links an answer may carry. Trailing punctuation is trimmed after
 * the match so a link at the end of a sentence still compares byte-identical. */
const AbsoluteUrlPattern = /https?:\/\/[^\s<>"'`)\]}]+/gi;

/** Citation-shaped markers an answer can carry without an absolute URL: a
 * footnote number, a source or reference label, a markdown link, or a link
 * path. A conversational answer carries none of these. */
const SourceMarkerPattern =
  /\[\^?\d+\]|(?:^|\n)\s*(?:sources?|references?)\s*:|!?\[[^\]]*\]\([^)]+\)|(?:^|[\s(])\/[a-z0-9]/i;

/**
 * Reports whether an answer names a source without citing an absolute URL.
 *
 * @param text the accumulated assistant text.
 * @return true when the text carries a source-like marker.
 */
function hasSourceMarker(text: string): boolean {
  return SourceMarkerPattern.test(text);
}

/**
 * Extracts the absolute URLs an answer cites.
 *
 * @param text the accumulated assistant text.
 * @return every absolute URL in the text, without trailing punctuation.
 */
function extractAbsoluteUrls(text: string): string[] {
  return (text.match(AbsoluteUrlPattern) ?? []).map((url) =>
    url.replace(/[.,;:!?]+$/, "")
  );
}

/**
 * Builds the set of links the turn's tool results actually returned.
 *
 * @param toolCalls the tool calls recorded for the turn.
 * @return the links any tool returned.
 */
function toolReturnedLinks(toolCalls: ToolCallDigestEntry[]): Set<string> {
  const links = new Set<string>();
  for (const call of toolCalls) {
    for (const link of call.links) {
      links.add(link);
    }
  }
  return links;
}

/**
 * Whether an absolute URL in the answer maps to a link a tool returned. Tools
 * commonly return a workspace-relative link, so the path is compared as well.
 *
 * @param url the absolute URL the answer cites.
 * @param links the links the turn's tools returned.
 * @return true when the URL is backed by a tool result.
 */
function isToolReturnedUrl(url: string, links: Set<string>): boolean {
  if (links.has(url)) {
    return true;
  }
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  for (const link of links) {
    if (link.startsWith("/") && link === path) {
      return true;
    }
  }
  return false;
}

/**
 * Removes the given URLs from the answer, keeping the surrounding sentence.
 *
 * @param text the answer text.
 * @param urls the URLs to remove.
 * @return the text without those URLs.
 */
function removeUrls(text: string, urls: string[]): string {
  let result = text;
  for (const url of urls) {
    result = result.split(url).join("");
  }
  return result;
}

/**
 * Keeps only the absolute URLs this turn's tools returned. A URL no tool
 * returned is stripped so it cannot auto-link, and the answer turns into a
 * citation miss. An answer that was nothing but a rejected URL keeps a
 * placeholder, because an empty assistant turn is dropped by {@link appendTurn}.
 *
 * Never throws: a validation failure strips every URL instead, so no
 * unvalidated link reaches a persisted row.
 *
 * @param text the accumulated assistant text.
 * @param toolCalls the tool calls recorded for the turn.
 * @return the validated text, the number of URLs removed, and whether the
 *   engine failed closed.
 */
function validateAnswerCitations(
  text: string,
  toolCalls: ToolCallDigestEntry[]
): { content: string; stripped: number; failed: boolean } {
  try {
    const cited = extractAbsoluteUrls(text);
    if (cited.length === 0) {
      return { content: text, stripped: 0, failed: false };
    }
    const links = toolReturnedLinks(toolCalls);
    const rejected = cited.filter((url) => !isToolReturnedUrl(url, links));
    if (rejected.length === 0) {
      return { content: text, stripped: 0, failed: false };
    }
    const content = removeUrls(text, rejected);
    return {
      content: content.trim() ? content : "[citation removed]",
      stripped: rejected.length,
      failed: false,
    };
  } catch {
    const stripped = (text.match(AbsoluteUrlPattern) ?? []).length;
    const content = text.replace(AbsoluteUrlPattern, "");
    return {
      content: content.trim() ? content : "[citation removed]",
      stripped,
      failed: true,
    };
  }
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
  toolChoice,
}: PersistenceMiddlewareProps): ChatMiddleware {
  let content = "";
  const toolResultIdentifiers: Set<string> = new Set();
  const toolCalls: ToolCallDigestEntry[] = [];
  const toolCallIndex = new Map<string, ToolCallDigestEntry>();
  const toolCallArguments = new Map<string, string>();
  const toolCallNames = new Map<string, string>();
  let toolBudgetExhausted = false;


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
            // The digest is metadata, so it stores the title without framing.
            titles.push(unfenceRetrievedData(identifier.title));
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

    // Framing is not payload, so the digest measures what the tool returned.
    const characterCount =
      typeof chunk.content === "string"
        ? unfenceRetrievedData(chunk.content).length
        : Array.isArray(chunk.content)
        ? chunk.content.reduce(
            (sum, part) =>
              sum +
               (part && typeof part === "object" && "text" in part
                 ? (typeof (part as { text?: unknown }).text === "string"
                     ? unfenceRetrievedData((part as { text: string }).text)
                         .length
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
   * produced without a tool ever returning it does not count as sourced, and
   * a run that called no tool is a miss only when the answer itself names a
   * source – a plain conversational reply is not a citation miss.
   *
   * @return true when no tool-returned identifier is present in the answer.
   */
  const isCitationMiss = (): boolean => {
    if (toolResultIdentifiers.size === 0) {
      return hasSourceMarker(content);
    }
    for (const identifier of toolResultIdentifiers) {
      if (content.includes(identifier)) {
        return false;
      }
    }
    return true;
  };

  // Token counts ride the terminal `RUN_FINISHED` chunk as a provider-shaped
  // value, normalized on arrival into the two columns the turn row stores so
  // that the row and the log line below cannot disagree. Stays undefined until
  // a run reports usage at all, which is the only case worth logging.
  let tokenUsage: PersistedTokenUsage | undefined;

  /**
   * Persists the accumulated assistant text, then frees the lock. The release
   * runs even when the write fails or is skipped, so a lost row can never
   * strand the session.
   *
   * @param status how the run ended.
   * @param citationMiss whether the answer carried no tool-returned source.
   * @param surfaceFailure whether a failed write has to reach the client.
   * @throws {PersistenceFailedError} when the write fails and `surfaceFailure`
   *   is set.
   */
  const persistAndRelease = async (
    status: AIChatMessageStatus,
    citationMiss: boolean,
    toolCallDigest: Record<string, unknown> | undefined,
    surfaceFailure = false
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

    // The persistence boundary keeps only the absolute URLs this turn's tools
    // returned. One log line per turn reports a rejection; the turn itself is
    // always written, never dropped for a stripped link.
    const validated = validateAnswerCitations(content, toolCalls);
    if (validated.stripped > 0) {
      Logger.info("http", "AI chat citation rejected", {
        requestId,
        runId,
        strippedUrls: validated.stripped,
        ...(validated.failed ? { reason: "validation-failed" } : {}),
      });
    }

    try {
      await appendTurn({
        user,
        sessionId,
        role: AIChatMessageRole.Assistant,
        content: validated.content,
        status,
        runId,
        ctx,
        requestId,
        citationMiss: citationMiss || validated.stripped > 0,
        toolCallDigest: digest,
        promptTokens: tokenUsage?.promptTokens ?? null,
        completionTokens: tokenUsage?.completionTokens ?? null,
        surfaceFailure,
      });
    } finally {
      // Deliberate: cost is observable but not enforced. Nothing caps spend
      // yet, so the numbers are logged for an operator to read. They are the
      // values the row above just persisted, so the log and the column agree,
      // and a surfaced failure still reports its cost before the error leaves
      // this hook.
      if (tokenUsage) {
        Logger.info("http", "AI chat token usage", {
          requestId,
          sessionId,
          runId,
          status,
          promptTokens: tokenUsage.promptTokens,
          completionTokens: tokenUsage.completionTokens,
        });
      }

      await releaseInFlightLock();
    }
  };

  return {
    name: "ai-chat-persist",
    onConfig(hookCtx, _config) {
      // Force the named body tool on the first upstream model call only, when a
      // document is bound to the request. Subsequent calls fall back to the
      // default (auto) so the model can decide whether to call again.
      if (toolChoice && hookCtx.iteration === 0) {
        return { toolChoice };
      }
      return undefined;
    },
    onAfterToolCall(_hookCtx, info) {
      // Every tool result is third-party text, so it reaches the model framed.
      // An error result carries no document text, and callers read it verbatim,
      // so it is passed through untouched.
      if (!info.ok) {
        return undefined;
      }
      return {
        type: "replaceResult" as const,
        result: fenceThirdPartyText(info.result),
      };
    },
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
        // A refused tool call still reaches the model as a result chunk
        // carrying the sentinel; the turn ended at the cap, so the digest
        // records the typed event alongside the calls that did run.
        if (isToolBudgetExhaustedResult(chunk.content)) {
          toolBudgetExhausted = true;
        }
        collectToolResultIdentifiers(chunk);
      } else if (chunk.type === "RUN_FINISHED") {
        // A run that reports no usage leaves the columns null rather than zero.
        if (chunk.usage !== undefined) {
          tokenUsage = normalizeTokenUsage(chunk.usage);
        }
      }
    },
    async onFinish(_hookCtx, info) {
      await persistAndRelease(
        info.finishReason
          ? AIChatMessageStatus.Completed
          : AIChatMessageStatus.Truncated,
        isCitationMiss(),
        buildToolCallDigest(toolCalls, toolBudgetExhausted),
        // The accepted answer is already on the wire, so a row that could not
        // be written has to fail the run instead of passing for a flushed one.
        true
      );
    },
    async onAbort() {
      await persistAndRelease(
        AIChatMessageStatus.Aborted,
        isCitationMiss(),
        buildToolCallDigest(toolCalls, toolBudgetExhausted)
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
        buildToolCallDigest(toolCalls, toolBudgetExhausted)
      );
    },
  };
}
