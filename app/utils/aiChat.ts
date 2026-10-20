import {
  fetchServerSentEvents,
  type ResumableConnectConnectionAdapter,
} from "@tanstack/ai-client";
import { debounce } from "es-toolkit/compat";
import EDITOR_VERSION from "@shared/editor/version";
import { CSRF } from "@shared/constants";
import { getCSRFToken } from "./csrf";

const aiChatUrl = "/api/ai.chat";
const aiChatKindHeader = "X-AI-Chat-Kind";

/**
 * A single message in an AI chat conversation. Mirrors the server schema in
 * `server/routes/api/ai/schema.ts`; only `user` and `assistant` roles are
 * accepted by the API.
 */
export interface AiChatMessage {
  /** The author of the message. */
  role: "user" | "assistant";
  /** The message body. */
  content: string;
}

/**
 * A chunk of assistant output received from the provider stream. Each frame
 * carries the incremental text delta produced since the previous frame.
 */
export interface AiChatDelta {
  /** Discriminator identifying an incremental text chunk. */
  type: "delta";
  /** The text produced since the previous chunk. */
  text: string;
}

/**
 * A chunk of the model's reasoning ("thinking") output. Hermes streams it as a
 * standard chunk with `choices[0].delta.reasoning_content` — the DeepSeek-style
 * field Open WebUI and the Vercel AI SDK render as a thinking block — so it
 * never becomes answer text: the server accumulates only `content`, and the
 * panel shows reasoning behind a disclosure rather than as the reply.
 */
export interface AiChatReasoning {
  /** Discriminator identifying an incremental reasoning chunk. */
  type: "reasoning";
  /** The reasoning text produced since the previous chunk. */
  text: string;
}

/**
 * Discriminates the category of an {@link AiChatError} so the UI can render an
 * appropriate message and decide whether retrying is meaningful.
 */
export type AiChatErrorKind =
  /** The request was rejected before streaming began (non-OK response). */
  | "http"
  /** The provider failed mid-stream, surfaced as an in-band `event: error`. */
  | "stream"
  /** The request was refused by the grounding gate before the provider was contacted. */
  | "refusal"
  /** Another turn for this session is still streaming; asking again may succeed. */
  | "busy"
  /** The stream ended without the server confirming a finished answer. */
  | "truncated"
  /** The caller aborted the request – a deliberate Stop, not a failure. */
  | "aborted"
  /** The transport failed underneath the request. */
  | "network"
  /** A response frame could not be parsed as expected. */
  | "malformed";

/**
 * How a turn ended, as recorded by the server on each assistant message.
 * `aborted` and `error` are terminal states rather than answers: they describe a
 * turn that stopped without producing a whole reply.
 */
export type AiChatTurnStatus =
  /** The provider sent a finish reason; the answer is whole. */
  | "completed"
  /** The user stopped the turn before it finished. */
  | "aborted"
  /** The turn failed mid-stream. */
  | "error"
  /** The stream ended with no finish reason; the answer may be incomplete. */
  | "truncated";

/**
 * A single event decoded from the chat SSE stream: either incremental output or
 * the server's terminal frame. The terminal frame is authoritative – a stream
 * that ends without one did not finish, no matter how much text it produced.
 */
export type AiChatStreamEvent =
  /** An incremental chunk of assistant output. */
  | { type: "delta"; text: string }
  /** An incremental chunk of the model's reasoning, shown as a disclosure. */
  | { type: "reasoning"; text: string }
  /** The server's terminal frame, closing the stream. */
  | {
      type: "terminal";
      /** Whether the provider reported a finish reason. */
      outcome: "complete" | "truncated";
      /** The server's run identifier, when the frame carried one. */
      runId: string | undefined;
      /** The provider's finish reason, or null when it never sent one. */
      finishReason: string | null;
    };

/** Options accepted by {@link streamAiChat}. */
export interface AiChatOptions {
  /**
   * An abort signal that cancels the underlying request. Aborting rejects the
   * in-flight `fetch` and terminates iteration of the returned generator with
   * an {@link AiChatError} of kind `aborted`.
   */
  signal?: AbortSignal;
  /**
   * The stored conversation to append this turn to, sent in the request body.
   * When supplied, the server rebuilds the prompt window from committed rows;
   * `messages` is still sent, carrying the new turn the server appends.
   */
  sessionId?: string;
}

/**
 * The error type thrown by {@link streamAiChat} for every failure mode. Callers
 * can branch on {@link AiChatError.kind} – in particular a rejected request
 * carries `kind: "http"` and the HTTP {@link AiChatError.status}, so a 403 is
 * distinguishable from a 404 or a mid-stream failure.
 */
export class AiChatError extends Error {
  /** The category of failure, used to drive UI behavior. */
  readonly kind: AiChatErrorKind;

  /** The HTTP status code for a rejected request, when applicable. */
  readonly status?: number;

  /**
   * Creates an AI chat error.
   *
   * @param message the human-readable error description.
   * @param kind the failure category.
   * @param status the HTTP status code, when the failure was a rejected request.
   */
  constructor(message: string, kind: AiChatErrorKind, status?: number) {
    super(message);
    this.name = "AiChatError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * The discriminator a refused turn may carry on the `X-AI-Chat-Kind` response
 * header: `refusal` is the grounding gate declining, `busy` is transient
 * contention with a turn already streaming, and `null` is an ordinary answer.
 */
export type AiChatKind = "refusal" | "busy" | null;

/** Options accepted by {@link createAiChatConnection}. */
export interface AiChatConnectionOptions {
  /** Overrides the global `fetch`, for tests and instrumentation. */
  fetchClient?: typeof globalThis.fetch;
  /** Called with each response's `X-AI-Chat-Kind` value, `null` when absent. */
  onKind?: (kind: AiChatKind) => void;
}

/**
 * Creates the TanStack SSE connection for `POST /api/ai.chat`, carrying the
 * CSRF and editor-version headers the API requires and reporting each
 * response's `X-AI-Chat-Kind` discriminator through `onKind`.
 *
 * Headers are built per request so a rotated CSRF cookie is reflected without
 * a reload, and an absent token omits the header rather than sending an empty
 * one. No `tools` or `forwardedProps` are ever derived from client state: the
 * library sends `tools: []` and `forwardedProps: {}` by default, which is what
 * the server expects.
 *
 * @param options the fetch override and kind observer.
 * @returns the connection adapter consumed by the chat client.
 */
export function createAiChatConnection(
  options: AiChatConnectionOptions = {}
): ResumableConnectConnectionAdapter {
  const observeFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await (options.fetchClient ?? fetch)(input, init);
    options.onKind?.(readKind(response));

    if (!response.ok) {
      throw await toHttpError(response);
    }

    return response;
  };

  const connection = fetchServerSentEvents(aiChatUrl, () => ({
    credentials: "same-origin",
    headers: aiChatHeaders(),
    fetchClient: observeFetch,
  }));

  return {
    ...connection,
    connect: async function* (messages, data, abortSignal, runContext) {
      try {
        yield* connection.connect(messages, data, abortSignal, runContext);
      } catch (error) {
        // The library wraps anything `fetchClient` throws in a StreamReadError
        // whose `cause` is the original, so a rejected request is unwrapped to
        // its AiChatError here rather than surfacing as an opaque read failure.
        throw unwrapHttpError(error) ?? error;
      }
    },
  };
}

/**
 * Builds the per-request headers for the chat endpoint. The CSRF token is read
 * at call time, and omitted when no cookie is present.
 *
 * @returns the headers to send.
 */
function aiChatHeaders(): Record<string, string> {
  const token = getCSRFToken();

  return {
    "Content-Type": "application/json",
    ...(token ? { [CSRF.headerName]: token } : {}),
    "x-editor-version": EDITOR_VERSION,
  };
}

/**
 * Reads a response's `X-AI-Chat-Kind` discriminator, mapping anything other
 * than the two known values to `null`.
 *
 * @param response the response to inspect.
 * @returns the discriminator, or `null` for an ordinary answer.
 */
function readKind(response: Response): AiChatKind {
  const kind = response.headers.get(aiChatKindHeader);

  return kind === "refusal" || kind === "busy" ? kind : null;
}

/**
 * Extracts an {@link AiChatError} wrapped as the `cause` of a library read
 * error, so a rejected request keeps its HTTP status and `http` kind.
 *
 * @param error the error propagated by the connection.
 * @returns the wrapped chat error, or undefined when there is none.
 */
function unwrapHttpError(error: unknown): AiChatError | undefined {
  if (!(error instanceof Error) || !("cause" in error)) {
    return undefined;
  }

  const cause = (error as Error & { cause?: unknown }).cause;

  return cause instanceof AiChatError ? cause : undefined;
}

/**
 * The shape of an incremental chat-completions frame as forwarded by the
 * server. Only `choices[].delta.content` is read; every field is optional
 * because providers vary and intermediate frames may carry no content.
 */
interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
}

/**
 * Extracts the incremental text from a single decoded SSE `data:` payload.
 * Frames that carry no content (role-only openers, keep-alives, finish markers)
 * yield an empty string so the caller can skip them.
 *
 * @param payload the parsed `data:` JSON payload.
 * @returns the text delta, or an empty string when the frame carries no content.
 */
function extractDelta(payload: unknown): string {
  const chunk = payload as ChatCompletionChunk;
  const choice = chunk.choices?.[0];
  const content = choice?.delta?.content;

  return typeof content === "string" ? content : "";
}

/**
 * Extracts the incremental reasoning from a single decoded SSE `data:` payload.
 * Hermes sends it as `choices[0].delta.reasoning_content`, alongside — never
 * inside — the answer's `content`.
 *
 * @param payload the parsed `data:` JSON payload.
 * @returns the reasoning delta, or an empty string when the frame carries none.
 */
function extractReasoning(payload: unknown): string {
  const chunk = payload as ChatCompletionChunk;
  const choice = chunk.choices?.[0];
  const reasoning = choice?.delta?.reasoning_content;

  return typeof reasoning === "string" ? reasoning : "";
}

/**
 * Parses a byte stream of Server-Sent Events frames into typed events. Data lines
 * are buffered across chunk boundaries, so a frame split mid-way through a
 * `read()` never corrupts accumulation.
 *
 * A `data: [DONE]` frame terminates the generator without yielding. A terminal
 * `event: complete` or `event: truncated` frame is yielded and then ends
 * iteration, so a caller that consumes to exhaustion has always seen whether the
 * answer was whole. An `event: error` frame throws an {@link AiChatError},
 * carrying the producer's message when the payload is JSON: of kind `stream` by
 * default, or the payload's own `kind` when it is `refusal` (the grounding gate
 * declining) or `busy` (another turn still streaming).
 *
 * @param body the response body reader's stream.
 * @returns an async generator of decoded stream events.
 * @throws {AiChatError} when an in-band error frame is received.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<AiChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Frames that arrive only partially
      // stay in the buffer until their terminator is seen.
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        const event = parseFrame(frame);
        if (event !== undefined) {
          if (event.terminal !== undefined) {
            yield {
              type: "terminal",
              outcome: event.terminal,
              runId: event.runId,
              finishReason: event.finishReason ?? null,
            };
            return;
          }

          // Reasoning rides the same chunk shape as content, on its own
          // `reasoning_content` field, and is checked first so a chunk carrying
          // both never reports the thinking as the answer.
          const reasoning = extractReasoning(event.data);
          if (reasoning) {
            yield { type: "reasoning", text: reasoning };
          } else {
            // Role-only openers, keep-alives and finish markers carry no text.
            const text = extractDelta(event.data);
            if (text) {
              yield { type: "delta", text };
            }
          }
        }

        separator = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The result of parsing one SSE frame: a decoded payload or a server-authored
 * terminal frame.
 */
interface ParsedFrame {
  /** The decoded `data:` payload, or `undefined` for a terminator. */
  data?: unknown;
  /** The outcome named by a server-authored terminal frame. */
  terminal?: "complete" | "truncated";
  /** The run identifier carried by a terminal frame, when present. */
  runId?: string;
  /** The finish reason carried by a terminal frame, when present. */
  finishReason?: string | null;
}

/**
 * Parses a single raw SSE frame into its event name and payload. Unknown lines
 * (comments, `id:`, `retry:`) are ignored per the SSE specification.
 *
 * @param frame the raw frame text, without its trailing blank line.
 * @returns the parsed frame, or undefined when the frame carried no data.
 * @throws {AiChatError} when an `event: error` frame is received.
 */
function parseFrame(frame: string): ParsedFrame | undefined {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      // A single leading space after the colon is stripped, per the spec.
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  const raw = dataLines.join("\n");

  if (event === "error") {
    throw new AiChatError(errorMessage(raw), errorKind(raw));
  }

  if (event === "complete" || event === "truncated") {
    return { terminal: event, ...terminalFields(raw) };
  }

  // The upstream `[DONE]` sentinel is skipped, not treated as the end. It is
  // forwarded ahead of the server's own terminal frame, so returning here would
  // stop iteration one frame short and every session-backed answer would look
  // truncated. Skipping it lets the read continue to that frame, or to the
  // socket closing for a stateless turn that has no terminal frame at all.
  if (raw === "[DONE]") {
    return undefined;
  }

  try {
    return { data: JSON.parse(raw) };
  } catch {
    throw new AiChatError("Received a malformed response frame", "malformed");
  }
}

/**
 * Reads the terminal frame's `runId` and `finishReason`. A payload that is not
 * JSON, or that omits the fields, still yields a terminal frame: refusing to
 * end iteration would leave the caller unable to distinguish a completed answer
 * from a cut-off one, which is the exact confusion the frame exists to remove.
 *
 * @param raw the raw terminal payload text.
 * @returns the run identifier and finish reason carried by the frame.
 */
function terminalFields(
  raw: string
): Pick<ParsedFrame, "runId" | "finishReason"> {
  try {
    const parsed = JSON.parse(raw) as {
      runId?: unknown;
      finishReason?: unknown;
    };
    return {
      runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
      finishReason:
        typeof parsed.finishReason === "string" ? parsed.finishReason : null,
    };
  } catch {
    return { runId: undefined, finishReason: null };
  }
}

/**
 * Extracts a human-readable message from an error frame payload, falling back to
 * a generic description when the payload is absent or not JSON.
 *
 * @param raw the raw error payload text.
 * @returns the error message to surface.
 */
function errorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) {
      return parsed.error;
    }
  } catch {
    // The payload was not JSON; fall through to the generic message.
  }

  return "The AI chat stream failed";
}

/**
 * Discriminates an `event: error` frame by its payload `kind` field. `refusal`
 * is the grounding gate declining and `busy` is transient contention with a
 * turn already streaming; the two want opposite UI, so they stay distinct.
 * Every other producer — and any payload that fails to parse — yields
 * `"stream"`, so a malformed or untagged error is never mistaken for either.
 *
 * @param raw the raw error payload text.
 * @returns the error kind to surface.
 */
function errorKind(raw: string): "refusal" | "busy" | "stream" {
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown };
    if (parsed.kind === "refusal" || parsed.kind === "busy") {
      return parsed.kind;
    }
  } catch {
    // The payload was not JSON; treat it as a failure, never a refusal.
  }

  return "stream";
}

// ponytail: retired in todo 10 when the panel moves to useChat
/**
 * Opens a streaming chat request against `POST /api/ai.chat` and yields the
 * incremental assistant output as it arrives. The request carries the CSRF and
 * editor-version headers the API requires; passes `options.signal` to cancel.
 *
 * A non-OK response is parsed into an {@link AiChatError} of kind `http` before
 * the stream is read, so callers can distinguish a 403 (missing CSRF token)
 * from a 404 (feature disabled) or a 5xx provider failure.
 *
 * A session-backed turn is only complete once the server says so. The generator
 * consumes the stream to exhaustion and then raises `kind: "truncated"` unless a
 * terminal `event: complete` frame arrived — an answer that simply stops
 * mid-sentence is never reported as a finished one, however much text it
 * produced. A stateless turn has no terminal frame to wait for (see the check
 * below), so it completes whenever the stream ends.
 *
 * @param messages the conversation to send, oldest first. With a
 * `options.sessionId` the server rebuilds the prompt window from committed rows
 * and uses only the last message as the turn to append, so this array must still
 * carry the question being asked.
 * @param options additional request options.
 * @returns an async generator of assistant text deltas.
 * @throws {AiChatError} when the request is rejected, the stream fails, the
 * caller aborts, or the answer ends without being confirmed complete.
 */
export async function* streamAiChat(
  messages: AiChatMessage[],
  options: AiChatOptions = {}
): AsyncGenerator<AiChatDelta | AiChatReasoning> {
  let res: Response;

  try {
    res = await fetch(aiChatUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        [CSRF.headerName]: getCSRFToken(),
        "x-editor-version": EDITOR_VERSION,
      },
      // The new turn is sent even with a `sessionId`. The server rebuilds the
      // prompt window from committed rows and takes only the *last* message as
      // the turn to append, so dropping `messages` here left it with nothing to
      // write and an empty prompt – the question being asked must travel with
      // the session.
      body: JSON.stringify(
        options.sessionId === undefined
          ? { messages }
          : { messages, sessionId: options.sessionId }
      ),
      signal: options.signal,
    });
  } catch {
    if (options.signal?.aborted) {
      throw new AiChatError("The AI chat request was cancelled", "aborted");
    }

    throw new AiChatError("A network error occurred, try again?", "network");
  }

  if (!res.ok) {
    throw await toHttpError(res);
  }

  if (!res.body) {
    throw new AiChatError("The AI chat response was empty", "malformed");
  }

  let complete = false;

  try {
    for await (const event of parseSSEStream(res.body)) {
      if (event.type === "delta" || event.type === "reasoning") {
        yield event;
        continue;
      }

      complete = event.outcome === "complete";
    }
  } catch (err) {
    // Errors deliberately thrown by the parser (stream/refusal/busy/malformed)
    // pass through unchanged; anything else is the reader rejecting.
    if (err instanceof AiChatError) {
      throw err;
    }

    if (options.signal?.aborted) {
      throw new AiChatError("The AI chat request was cancelled", "aborted");
    }

    throw new AiChatError("The AI chat stream failed", "network");
  }

  // A terminal frame is only demanded of a session-backed turn. The server
  // authors one exclusively for those: `finish()` in
  // `server/routes/api/ai/ai.ts` early-returns on `if (!ownedSession)` without
  // writing a frame, because a stateless chat is a pure byte proxy that must
  // stay byte-identical to the pre-turns wire format. The two sides of this
  // contract depend on each other — demanding the frame unconditionally reports
  // every stateless answer as truncated, and that is the first turn of every new
  // conversation, sent before a session exists.
  const sessionBacked = options.sessionId !== undefined;

  // The stream ended without the server confirming a finished answer. The
  // socket dropping, a proxy cutting the response, and the terminal frame
  // arriving unread all land here, and none of them produced a whole reply.
  if (sessionBacked && !complete) {
    throw new AiChatError(
      "The AI chat answer stopped before it finished",
      "truncated"
    );
  }
}

/**
 * Builds an {@link AiChatError} from a rejected response, parsing the API's
 * JSON error envelope when present so the message matches what a normal
 * `ApiClient` call would surface.
 *
 * @param res the rejected response.
 * @returns the error to throw.
 */
async function toHttpError(res: Response): Promise<AiChatError> {
  let message = "";

  try {
    const parsed = (await res.json()) as {
      message?: string;
    };
    message = parsed.message ?? "";
  } catch {
    // The body was empty or not JSON; fall back to a status-based message.
  }

  if (!message) {
    message = `The AI chat request failed (${res.status})`;
  }

  return new AiChatError(message, "http", res.status);
}

/** The `localStorage` key prefix a composer draft is stored under. */
const draftKeyPrefix = "aiChat.draft.";

/** The key holding a draft typed before the session it belongs to exists. */
const pendingDraftKey = `${draftKeyPrefix}pending`;

/** How long typing settles before the draft is written, in milliseconds. */
const draftWriteDelayMs = 500;

/** Drafts queued by `writeDraft` and not yet committed to storage. */
const queuedDrafts = new Map<string, string>();

const commitDrafts = debounce(() => {
  for (const [key, text] of queuedDrafts) {
    writeItem(key, text);
  }
  queuedDrafts.clear();
}, draftWriteDelayMs);

/**
 * The `localStorage` key a draft for the given session is stored under. Omitting
 * the session addresses the pre-create window, where no session exists to key
 * against yet.
 *
 * @param sessionId the session, or undefined before one has been created.
 * @returns the storage key.
 */
export function draftKey(sessionId?: string): string {
  return sessionId === undefined
    ? pendingDraftKey
    : `${draftKeyPrefix}${sessionId}`;
}

/**
 * Reads the stored draft for a session.
 *
 * @param sessionId the session, or undefined for the pre-create draft.
 * @returns the draft text, or an empty string when there is none or storage is
 * unavailable.
 */
export function readDraft(sessionId?: string): string {
  try {
    return window.localStorage?.getItem(draftKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Queues a draft for storage. Writes are debounced so a fast typist does not
 * write once per keystroke; call {@link flushDrafts} to commit immediately.
 * Empty text clears the draft rather than storing an empty one.
 *
 * @param text the current composer contents.
 * @param sessionId the session, or undefined for the pre-create draft.
 */
export function writeDraft(text: string, sessionId?: string): void {
  if (!text) {
    clearDraft(sessionId);
    return;
  }

  queuedDrafts.set(draftKey(sessionId), text);
  commitDrafts();
}

/** Writes every queued draft to storage now and cancels the pending timer. */
export function flushDrafts(): void {
  commitDrafts.flush();
}

/**
 * Discards a session's draft, both the stored value and any queued write. This
 * runs on send, and on session delete, so a draft cannot resurrect into a
 * conversation it was not written for.
 *
 * @param sessionId the session, or undefined for the pre-create draft.
 */
export function clearDraft(sessionId?: string): void {
  const key = draftKey(sessionId);
  queuedDrafts.delete(key);

  // Nothing left to write: drop the timer so a debounced writer cannot outlive
  // the work that scheduled it.
  if (queuedDrafts.size === 0) {
    commitDrafts.cancel();
  }

  try {
    window.localStorage?.removeItem(key);
  } catch {
    // Storage is unavailable or refusing; a draft is never worth failing over.
  }
}

/**
 * Writes a storage item, swallowing any failure. Every draft access goes through
 * a guard like this one: private browsing, a full quota, or blocked storage
 * degrades to "no draft" and must never reach the send path as an exception.
 *
 * @param key the storage key.
 * @param value the value to store.
 */
function writeItem(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Storage is unavailable or refusing; a draft is never worth failing over.
  }
}
