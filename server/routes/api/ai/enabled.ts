import { TeamPreference } from "@shared/types";
import env from "@server/env";
import { NotFoundError } from "@server/errors";
import Logger from "@server/logging/Logger";
import type { User } from "@server/models";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";

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
/**
 * The grounding probe bounds as `scope.ts` pins them. Mirrored here because
 * that module keeps both private; a boot log printing its own numbers would
 * drift the moment either pin moved.
 *
 * ponytail: export MaxProbeTerms and UntokenizableScriptRatio from `scope.ts`
 * and import them here to delete this mirror.
 */
const GroundingProbe = {
  maxProbeTerms: 8,
  untokenizableScriptRatio: 0.5,
} as const;

let groundingStateLogged = false;

/**
 * Emits the resolved AI chat grounding configuration once per boot so an
 * operator can read from the startup log whether the grounding probe runs and
 * which bounds it uses. Takes no arguments and is called at boot, never per
 * request, so no request data can reach the line.
 *
 * @returns nothing.
 */
export function logAiChatGroundingState() {
  if (groundingStateLogged) {
    return;
  }

  groundingStateLogged = true;

  const rateLimit = RateLimiterStrategy.TenPerMinute;

  Logger.info(
    "ai-chat",
    env.AI_CHAT_GROUNDING
      ? "grounding=enabled fail-closed"
      : "grounding=disabled",
    {
      grounding: env.AI_CHAT_GROUNDING,
      maxProbeTerms: GroundingProbe.maxProbeTerms,
      untokenizableScriptRatio: GroundingProbe.untokenizableScriptRatio,
      rateLimit: `${rateLimit.requests}/${rateLimit.duration}s`,
    }
  );
}

export function assertAiChatEnabled(user: User) {
  if (
    !user.team.getPreference(TeamPreference.AIChat) ||
    !env.AI_CHAT_BASE_URL ||
    !env.AI_CHAT_MODEL
  ) {
    throw NotFoundError();
  }
}
