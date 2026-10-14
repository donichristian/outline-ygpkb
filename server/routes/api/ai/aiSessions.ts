import Router from "koa-router";
import { Op } from "sequelize";
import { TeamPreference } from "@shared/types";
import aiChatSessionCreator from "@server/commands/aiChatSessionCreator";
import aiChatSessionDestroyer from "@server/commands/aiChatSessionDestroyer";
import env from "@server/env";
import { NotFoundError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import { transaction } from "@server/middlewares/transaction";
import validate from "@server/middlewares/validate";
import { AIChatMessage, AIChatSession } from "@server/models";
import type { User } from "@server/models";
import { authorize } from "@server/policies";
import { presentAIChatMessage, presentAIChatSession } from "@server/presenters";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import * as T from "./schema";
import { AiChatMaxMessages } from "./schema";

/**
 * The number of messages returned in a single page of history. One page is one
 * upstream prompt window, so paging through history never needs to look at more
 * than the model is ever sent.
 */
const messagesPageSize = AiChatMaxMessages;

const router = new Router();

/**
 * Asserts that the AI chat feature is available to the requesting user's
 * workspace. Mirrors the gate on `ai.chat`: a base URL *and* a model are both
 * required, because a base URL without a model could only produce a broken
 * upstream request. All three conditions produce a 404 so an unavailable
 * endpoint is indistinguishable from one that was never registered.
 *
 * Every route here calls this before any ownership check. A route that resolved
 * ownership first would answer 403 for a session that is not the caller's and
 * 404 for one that is, which turns the endpoint into an oracle for whether a
 * given session id exists in the workspace.
 *
 * @param user the requesting user.
 * @throws NotFoundError when the workspace preference is off or no provider is
 * configured.
 */
function assertAiChatEnabled(user: User) {
  if (
    !user.team.getPreference(TeamPreference.AIChat) ||
    !env.AI_CHAT_BASE_URL ||
    !env.AI_CHAT_MODEL
  ) {
    throw NotFoundError();
  }
}

router.post(
  "ai.sessions.create",
  auth(),
  // Keyed on the client address for anonymous requests and on the user id for
  // session-token requests (middlewares/rateLimiter.ts:30-52) — so this is
  // per-address for unauthenticated traffic, per-user otherwise.
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  validate(T.AiSessionsCreateSchema),
  transaction(),
  async (ctx: APIContext<T.AiSessionsCreateReq>) => {
    const { user } = ctx.state.auth;
    assertAiChatEnabled(user);

    const { title } = ctx.input.body;
    const session = await aiChatSessionCreator({ user, title, ctx });

    ctx.body = {
      data: presentAIChatSession(session),
    };
  }
);

router.post(
  "ai.sessions.list",
  auth(),
  // IP-scoped, see above.
  rateLimiter(RateLimiterStrategy.OneHundredPerMinute),
  validate(T.AiSessionsListSchema),
  async (ctx: APIContext<T.AiSessionsListReq>) => {
    const { user } = ctx.state.auth;
    assertAiChatEnabled(user);

    // The where clause is the authorization: it matches the index prefix
    // `[teamId, userId, updatedAt]` and excludes every other user's rows in one
    // read, so there is no per-row check to loop over.
    const sessions = await AIChatSession.findAll({
      where: {
        teamId: user.teamId,
        userId: user.id,
      },
      order: [["updatedAt", "DESC"]],
    });

    ctx.body = {
      data: {
        sessions: sessions.map(presentAIChatSession),
      },
    };
  }
);

router.post(
  "ai.sessions.delete",
  auth(),
  // IP-scoped, see above.
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  validate(T.AiSessionsDeleteSchema),
  transaction(),
  async (ctx: APIContext<T.AiSessionsDeleteReq>) => {
    const { user } = ctx.state.auth;
    assertAiChatEnabled(user);

    const { id } = ctx.input.body;
    const session = await AIChatSession.findOwned(ctx, id, user);
    authorize(user, "delete", session);

    await aiChatSessionDestroyer({ session, ctx });

    ctx.body = {
      success: true,
    };
  }
);

router.post(
  "ai.messages.list",
  auth(),
  // IP-scoped, see above.
  rateLimiter(RateLimiterStrategy.OneHundredPerMinute),
  validate(T.AiMessagesListSchema),
  async (ctx: APIContext<T.AiMessagesListReq>) => {
    const { user } = ctx.state.auth;
    assertAiChatEnabled(user);

    const { sessionId, beforeSeq } = ctx.input.body;

    // Permission for a message is resolved through its session: the message
    // carries no owner column and has no policy of its own.
    const session = await AIChatSession.findOwned(ctx, sessionId, user);
    authorize(user, "read", session);

    // One row beyond the page size is read so that "are there older messages?"
    // is answered by the page already fetched rather than a second query.
    const rows = await AIChatMessage.findAll({
      where: {
        sessionId: session.id,
        ...(beforeSeq === undefined ? {} : { seq: { [Op.lt]: beforeSeq } }),
      },
      order: [["seq", "DESC"]],
      limit: messagesPageSize + 1,
    });

    const truncated = rows.length > messagesPageSize;
    const page = truncated ? rows.slice(0, messagesPageSize) : rows;

    ctx.body = {
      data: {
        messages: page.map(presentAIChatMessage),
        // Older messages exist that this page does not include.
        truncated,
        // The cursor to send next is the oldest `seq` on this page, and only
        // exists while there is something below it to fetch. Paging by this
        // cursor rather than by offset keeps the window stable while a turn is
        // appended concurrently, which an offset would shift underneath.
        cursor: truncated ? page[page.length - 1].seq : undefined,
      },
    };
  }
);

export default router;
