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
 * The error type thrown by the chat connection for every failure mode. Callers
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
