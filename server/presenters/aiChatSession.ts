import type { AIChatMessage, AIChatSession } from "@server/models";

/**
 * Serialize a chat session to its API shape.
 *
 * `teamId` and `userId` are deliberately absent: they are ownership internals,
 * and the client already knows which user it is acting as. Exposing them would
 * invite clients to reason about ownership instead of being authorized.
 *
 * @param session the session to serialize.
 * @returns the session in API shape.
 */
export function presentAIChatSession(session: AIChatSession) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/**
 * Serialize a single chat message to its API shape.
 *
 * No ownership column is exposed: messages carry none, and permission for a
 * message is resolved through its session.
 *
 * @param message the message to serialize.
 * @returns the message in API shape.
 */
export function presentAIChatMessage(message: AIChatMessage) {
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    content: message.content,
    status: message.status,
    runId: message.runId,
    createdAt: message.createdAt,
  };
}