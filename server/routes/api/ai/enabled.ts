import { TeamPreference } from "@shared/types";
import env from "@server/env";
import { NotFoundError } from "@server/errors";
import type { User } from "@server/models";

/**
 * Asserts that the AI chat feature is available to the requesting user's
 * workspace. A base URL *and* a model are both required, because a base URL
 * without a model could only produce a broken upstream request. All three
 * conditions produce a 404 so an unavailable endpoint is indistinguishable from
 * one that was never registered.
 *
 * Every AI route calls this before any ownership check. A route that resolved
 * ownership first would answer 403 for a session that is not the caller's and
 * 404 for one that is, which turns the endpoint into an oracle for whether a
 * given session id exists in the workspace.
 *
 * This is the only definition of the gate: it is security-relevant, and a copy
 * in each of the two routers would let a fix to one silently miss the other.
 *
 * @param user the requesting user.
 * @throws NotFoundError when the workspace preference is off or no provider is
 * configured.
 */
export function assertAiChatEnabled(user: User) {
  if (
    !user.team.getPreference(TeamPreference.AIChat) ||
    !env.AI_CHAT_BASE_URL ||
    !env.AI_CHAT_MODEL
  ) {
    throw NotFoundError();
  }
}
