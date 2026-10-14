import Logger from "@server/logging/Logger";
import { traceFunction } from "@server/logging/tracing";
import type { User } from "@server/models";
import { AIChatSession } from "@server/models";

/**
 * Permanently deletes the AI chat data owned by a soft-deleted user.
 *
 * Users are soft deleted, so `users.deletedAt` alone never removes anything:
 * the `ai_chat_sessions.userId` foreign key has no `ON DELETE` clause, meaning
 * a hard delete of the `users` row would be rejected while chat sessions still
 * reference it. Purging here, rather than on the `users.delete` event, also
 * means a recoverable delete keeps its chat history.
 *
 * Idempotent – re-running against an already purged user deletes nothing.
 *
 * @param user the soft-deleted user whose AI chat data to destroy.
 * @throws if the user is not in a deleted state.
 */
async function userPermanentDeleter(user: User) {
  if (!user.deletedAt) {
    throw new Error(
      `Cannot permanently delete ${user.id} user. Please delete it and try again.`
    );
  }

  const userId = user.id;

  Logger.info(
    "commands",
    `Permanently destroying AI chat sessions for user ${userId}`
  );

  // Messages need no explicit handling, the `ai_chat_messages.sessionId`
  // foreign key cascades on delete.
  await AIChatSession.destroy({
    where: { userId },
    force: true,
  });
}

export default traceFunction({
  spanName: "userPermanentDeleter",
})(userPermanentDeleter);