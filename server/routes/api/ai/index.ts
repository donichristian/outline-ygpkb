import Router from "koa-router";
import ai from "./ai";
import aiSessions from "./aiSessions";

/**
 * The AI routes live in two routers: `ai.ts` holds the streaming `ai.chat`
 * endpoint and `aiSessions.ts` holds the session and message reads and writes.
 * This router composes both so the API router keeps mounting a single `ai`
 * router.
 *
 * `.use()` is called without a path argument. koa-router copies a child
 * router's layers verbatim when no path is given and only prefixes them when
 * one is, so the keys stay `ai.chat` and `ai.sessions.*` here and receive
 * their `/` prefix exactly once, from the API router that mounts this one.
 */
const router = new Router();

router.use(ai.routes());
router.use(aiSessions.routes());

export default router;
