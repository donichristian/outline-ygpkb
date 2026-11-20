import Router from "@koa/router";
import { Op } from "sequelize";
import aiChatSessionCreator from "@server/commands/aiChatSessionCreator";
import aiChatSessionDestroyer from "@server/commands/aiChatSessionDestroyer";
import { NotFoundError } from "@server/errors";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import { transaction } from "@server/middlewares/transaction";
import validate from "@server/middlewares/validate";
import { AIChatMessage, AIChatSession } from "@server/models";
import { authorize } from "@server/policies";
import { presentAIChatMessage, presentAIChatSession } from "@server/presenters";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { assertAiChatEnabled } from "./enabled";
import * as T from "./schema";
import { AiChatMaxMessages, AiChatMaxSessions } from "./schema";

/**
 * The number of messages returned in a single page of history. One page is one
 * upstream prompt window, so paging through history never needs to look at more
 * than the model is ever sent.
 */
const messagesPageSize = AiChatMaxMessages;

/**
 * The number of sessions returned in a single page of the session list. A hard
 * bound: the caller may ask for fewer, never for more.
 */
const sessionsPageSize = AiChatMaxSessions;

/**
 * Encodes the position of the last session on a page as an opaque cursor.
 *
 * `updatedAt` alone is not unique, so the id breaks ties and keeps the order
 * total – two sessions saved in the same millisecond would otherwise be
 * skipped or repeated across pages.
 *
 * @param session the last session on the page.
 * @returns the cursor for the next page.
 */
function sessionCursor(session: AIChatSession): string {
  return `${session.updatedAt.toISOString()}|${session.id}`;
}

/**
 * Splits a session cursor back into the position it names. The shape is
 * validated by `AiSessionsListSchema`, so both parts are always present.
 *
 * @param cursor the cursor returned by a previous page.
 * @returns the updatedAt and id of the last row of that page.
 */
function parseSessionCursor(cursor: string): { updatedAt: Date; id: string } {
  const separator = cursor.lastIndexOf("|");

  return {
    updatedAt: new Date(cursor.slice(0, separator)),
    id: cursor.slice(separator + 1),
  };
}

const router = new Router();

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

    const { limit, after } = ctx.input.body;
    const pageSize = Math.min(limit ?? sessionsPageSize, sessionsPageSize);
    const cursor = after ? parseSessionCursor(after) : undefined;

    // The where clause is the authorization: it matches the index prefix
    // `[teamId, userId, updatedAt]` and excludes every other user's rows in one
    // read, so there is no per-row check to loop over. One row beyond the page
    // size is read so "are there older sessions?" is answered by the page
    // already fetched rather than a second query.
    const rows = await AIChatSession.findAll({
      where: {
        teamId: user.teamId,
        userId: user.id,
        ...(cursor
          ? {
              [Op.or]: [
                { updatedAt: { [Op.lt]: cursor.updatedAt } },
                { updatedAt: cursor.updatedAt, id: { [Op.lt]: cursor.id } },
              ],
            }
          : {}),
      },
      // The id breaks updatedAt ties, matching the cursor above so a page
      // boundary can never skip or repeat a row.
      order: [
        ["updatedAt", "DESC"],
        ["id", "DESC"],
      ],
      limit: pageSize + 1,
    });

    const truncated = rows.length > pageSize;
    const page = truncated ? rows.slice(0, pageSize) : rows;

    ctx.body = {
      data: {
        sessions: page.map(presentAIChatSession),
        // Older sessions exist that this page does not include.
        hasNextPage: truncated,
        // The cursor to send next is the position of the last row on this
        // page, and only exists while there is something below it to fetch.
        cursor: truncated ? sessionCursor(page[page.length - 1]) : undefined,
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

    // A session that does not exist and one belonging to someone else are the
    // same answer, so a missing row is a 404 and never the 403 `authorize`
    // would raise for a null target.
    if (!session) {
      throw NotFoundError();
    }

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

    // A session that does not exist and one belonging to someone else are the
    // same answer, so a missing row is a 404 and never the 403 `authorize`
    // would raise for a null target.
    if (!session) {
      throw NotFoundError();
    }

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
