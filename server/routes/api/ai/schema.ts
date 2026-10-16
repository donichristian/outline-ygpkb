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
 * The maximum number of characters accepted in a session title.
 */
export const AiChatMaxSessionTitleLength = 200;

/**
 * A single message in the conversation. Only `user` and `assistant` roles are
 * accepted from the client – the `system` role is intentionally rejected so a
 * caller cannot override the server-side instructions.
 */
const AiChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(AiChatMaxMessageLength),
});

export type AiChatMessageInput = z.infer<typeof AiChatMessageSchema>;

export const AiChatSchema = BaseSchema.extend({
  body: z
    .object({
      /**
       * The ordered conversation to send to the AI chat provider. Optional only
       * when `sessionId` is given, because in that case the conversation is
       * loaded from the stored session rather than supplied by the client.
       */
      messages: z
        .array(AiChatMessageSchema)
        .min(1)
        .max(AiChatMaxMessages)
        .optional(),
      /** The stored conversation to append this turn to. */
      sessionId: z.uuid().optional(),
    })
    .refine(
      (body) => body.messages !== undefined || body.sessionId !== undefined,
      {
        message: "messages is required when sessionId is not provided",
        // Relative to `body`: zod prepends the parent path, so "body" here
        // again would yield ["body", "body", "messages"].
        path: ["messages"],
      }
    ),
});

export type AiChatSchemaReq = z.infer<typeof AiChatSchema>;

export const AiSessionsCreateSchema = BaseSchema.extend({
  body: z.object({
    /** An optional name for the conversation. */
    title: z.string().min(1).max(AiChatMaxSessionTitleLength).optional(),
  }),
});

export type AiSessionsCreateReq = z.infer<typeof AiSessionsCreateSchema>;

export const AiSessionsListSchema = BaseSchema.extend({
  body: z.object({}),
});

export type AiSessionsListReq = z.infer<typeof AiSessionsListSchema>;

export const AiSessionsDeleteSchema = BaseSchema.extend({
  body: z.object({
    id: z.uuid(),
  }),
});

export type AiSessionsDeleteReq = z.infer<typeof AiSessionsDeleteSchema>;

export const AiMessagesListSchema = BaseSchema.extend({
  body: z.object({
    sessionId: z.uuid(),
    /** The exclusive upper bound cursor – messages are returned from here downwards. */
    beforeSeq: z.number().int().min(0).optional(),
  }),
});

export type AiMessagesListReq = z.infer<typeof AiMessagesListSchema>;
