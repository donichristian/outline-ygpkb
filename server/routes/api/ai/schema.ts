import { z } from "zod";
import { BaseSchema } from "@server/routes/api/schema";

/**
 * The maximum number of messages accepted in a single chat request. Bounds the
 * prompt size that is forwarded to the upstream provider.
 */
export const AiChatMaxMessages = 50;

/**
 * The maximum number of characters accepted per message. Bounds the prompt size
 * that is forwarded to the upstream provider.
 */
export const AiChatMaxMessageLength = 8000;

/**
 * A single message in the conversation. Only `user` and `assistant` roles are
 * accepted from the client – the `system` role is intentionally rejected so a
 * caller cannot override the server-side instructions.
 */
const AiChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(AiChatMaxMessageLength),
});

export const AiChatSchema = BaseSchema.extend({
  body: z.object({
    /** The ordered conversation to send to the AI chat provider. */
    messages: z.array(AiChatMessageSchema).min(1).max(AiChatMaxMessages),
  }),
});

export type AiChatSchemaReq = z.infer<typeof AiChatSchema>;
