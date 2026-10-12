import EDITOR_VERSION from "@shared/editor/version";
import { CSRF } from "@shared/constants";
import { getCSRFToken } from "./csrf";

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
 * Discriminates the category of an {@link AiChatError} so the UI can render an
 * appropriate message and decide whether retrying is meaningful.
 */
export type AiChatErrorKind =
  /** The request was rejected before streaming began (non-OK response). */
  | "http"
  /** The provider failed mid-stream, surfaced as an in-band `event: error`. */
  | "stream"
  /** The transport failed, or the request was aborted. */
  | "network"
  /** A response frame could not be parsed as expected. */
  | "malformed";

/** Options accepted by {@link streamAiChat}. */
export interface AiChatOptions {
  /**
   * An abort signal that cancels the underlying request. Aborting rejects the
   * in-flight `fetch` and terminates iteration of the returned generator.
   */
  signal?: AbortSignal;
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
 * The shape of an incremental chat-completions frame as forwarded by the
 * server. Only `choices[].delta.content` is read; every field is optional
 * because providers vary and intermediate frames may carry no content.
 */
interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string };
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
 * Parses a byte stream of Server-Sent Events frames, yielding a decoded payload
 * for each `data:` field. Data lines are buffered across chunk boundaries, so a
 * frame split mid-way through a `read()` never corrupts accumulation.
 *
 * A `data: [DONE]` frame terminates the generator without yielding. An
 * `event: error` frame throws an {@link AiChatError} of kind `stream`, carrying
 * the provider's message when the payload is JSON.
 *
 * @param body the response body reader's stream.
 * @returns an async generator of decoded SSE payloads.
 * @throws {AiChatError} when an in-band error frame is received.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<unknown> {
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
          if (event.done) {
            return;
          }
          yield event.data;
        }

        separator = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The result of parsing one SSE frame: either a decoded payload or a terminal
 * `[DONE]` sentinel.
 */
interface ParsedFrame {
  /** The decoded `data:` payload, or `undefined` for a `[DONE]` sentinel. */
  data?: unknown;
  /** Whether the frame was a `data: [DONE]` terminator. */
  done: boolean;
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
    throw new AiChatError(errorMessage(raw), "stream");
  }

  if (raw === "[DONE]") {
    return { done: true };
  }

  try {
    return { data: JSON.parse(raw), done: false };
  } catch {
    throw new AiChatError("Received a malformed response frame", "malformed");
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
 * Opens a streaming chat request against `POST /api/ai.chat` and yields the
 * incremental assistant output as it arrives. The request carries the CSRF and
 * editor-version headers the API requires; passes `options.signal` to cancel.
 *
 * A non-OK response is parsed into an {@link AiChatError} of kind `http` before
 * the stream is read, so callers can distinguish a 403 (missing CSRF token)
 * from a 404 (feature disabled) or a 5xx provider failure.
 *
 * @param messages the conversation to send, oldest first.
 * @param options additional request options.
 * @returns an async generator of assistant text deltas.
 * @throws {AiChatError} when the request is rejected or the stream fails.
 */
export async function* streamAiChat(
  messages: AiChatMessage[],
  options: AiChatOptions = {}
): AsyncGenerator<AiChatDelta> {
  let res: Response;

  try {
    res = await fetch("/api/ai.chat", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        [CSRF.headerName]: getCSRFToken(),
        "x-editor-version": EDITOR_VERSION,
      },
      body: JSON.stringify({ messages }),
      signal: options.signal,
    });
  } catch {
    if (options.signal?.aborted) {
      throw new AiChatError("The AI chat request was cancelled", "network");
    }

    throw new AiChatError("A network error occurred, try again?", "network");
  }

  if (!res.ok) {
    throw await toHttpError(res);
  }

  if (!res.body) {
    throw new AiChatError("The AI chat response was empty", "malformed");
  }

  try {
    for await (const payload of parseSSEStream(res.body)) {
      const text = extractDelta(payload);
      if (text) {
        yield { type: "delta", text };
      }
    }
  } catch (err) {
    // Errors deliberately thrown by the parser (stream/malformed) pass through
    // unchanged; anything else is the reader rejecting, which an abort causes.
    if (err instanceof AiChatError) {
      throw err;
    }

    if (options.signal?.aborted) {
      throw new AiChatError("The AI chat request was cancelled", "network");
    }

    throw new AiChatError("The AI chat stream failed", "network");
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
