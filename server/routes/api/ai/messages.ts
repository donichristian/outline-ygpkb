/**
 * One part of an AG-UI message. Only `type` is required: a text part carries its
 * text in `content`, a `thinking` part does the same but must never become
 * answer text, and tool parts carry their own fields. The extra fields are
 * deliberately untyped here – the flattener reads exactly one of them, so
 * declaring the whole tool-call surface would only couple this module to a
 * schema the provider owns.
 */
export type MessagePart = {
  /** The part kind, for example `text`, `thinking` or `tool-call`. */
  readonly type: string;
  /** The part payload, a `string` for the part kinds that carry text. */
  readonly content?: unknown;
  /** Any other field the part kind defines, carried but never read here. */
  readonly [field: string]: unknown;
};

/**
 * The two message shapes that reach the server's flattening points: the legacy
 * `{ role, content }` request body and the AG-UI `{ id, role, parts }` one.
 * `role` is optional because a caller may have already narrowed or dropped it.
 */
export type MessageLike = {
  /** Author of the message, checked separately against the forward allow-list. */
  readonly role?: string;
  /** Legacy text payload. When non-empty it wins over `parts`. */
  readonly content?: string;
  /** AG-UI parts, flattened in array order. */
  readonly parts?: readonly MessagePart[];
};

/**
 * Flattens a message to the text a provider, the grounding gate or the
 * `ai_chat_messages.content` column consumes.
 *
 * A non-empty legacy `content` is used as-is, which keeps every stored row
 * byte-identical to what it was before the AG-UI shape existed. Otherwise the
 * `content` of every `text` part is concatenated in array order. `thinking`
 * parts are skipped on purpose: reasoning is not answer text, and mixing it into
 * the prompt would both leak it and change the conversation's meaning.
 *
 * @param message the message to flatten, in either accepted shape.
 * @returns the concatenated text, or an empty string when the message carries
 *   no text at all.
 */
export function messageText(message: MessageLike): string {
  if (typeof message.content === "string" && message.content.length > 0) {
    return message.content;
  }

  if (!message.parts) {
    return "";
  }

  let text = "";

  for (const part of message.parts) {
    if (part.type === "text" && typeof part.content === "string") {
      text += part.content;
    }
  }

  return text;
}
