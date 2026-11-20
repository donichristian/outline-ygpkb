// @vitest-isolate true
import { TeamPreference } from "@shared/types";
import aiChatMessageCreator from "@server/commands/aiChatMessageCreator";
import aiChatSessionCreator from "@server/commands/aiChatSessionCreator";
import { createContext } from "@server/context";
import env from "@server/env";
import { AIChatMessage, AIChatSession } from "@server/models";
import type { User } from "@server/models";
import {
  AIChatMessageRole,
  AIChatMessageStatus,
} from "@server/models/AIChatMessage";
import { buildUser } from "@server/test/factories";
import { getTestServer, withAPIContext } from "@server/test/support";
import type { APIContext } from "@server/types";

const server = getTestServer();

/** One page of history is one upstream prompt window. */
const pageSize = 50;

/** A well-formed session id that belongs to nobody, used to exercise the gate. */
const unknownSessionId = "d4f7c3ba-4f5e-4c5b-9c2a-3e1f0a2b6c7d";

type PresentedSession = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
};

type PresentedMessage = {
  seq: number;
  content: string;
  toolCallDigest?: unknown;
  citationMiss?: boolean;
};

type MessagePage = {
  messages: PresentedMessage[];
  truncated: boolean;
  cursor?: number;
};

type SessionPage = {
  sessions: PresentedSession[];
  hasNextPage: boolean;
  cursor?: string;
};

type TestResponse = Awaited<ReturnType<typeof server.post>>;

/**
 * Enables the AI chat workspace preference and configures the provider env vars
 * for the duration of a test.
 *
 * @param team the team to enable the feature for.
 */
async function configureAiChat(team: User["team"]) {
  team.setPreference(TeamPreference.AIChat, true);
  await team.save();
  env.AI_CHAT_BASE_URL = "http://localhost:20127/v1";
  env.AI_CHAT_MODEL = "test-model";
}

/**
 * Builds a committed session, the way the create route does.
 *
 * @param user the owner of the session.
 * @returns the created session.
 */
function buildSession(user: User) {
  return withAPIContext(user, (ctx) => aiChatSessionCreator({ user, ctx }));
}

/**
 * Builds a context shaped like the streaming route's, which does not run the
 * transaction middleware.
 *
 * @param user the session owner.
 * @returns the context.
 */
function streamingCtx(user: User): APIContext {
  return {
    ...createContext({ user }),
    request: { ip: "127.0.0.1" },
  } as APIContext;
}

/**
 * Appends one user turn to a session.
 *
 * @param user the session owner.
 * @param sessionId the session to append to.
 * @param content the message text.
 * @returns the created message.
 */
function appendMessage(user: User, sessionId: string, content: string) {
  return aiChatMessageCreator({
    user,
    sessionId,
    role: AIChatMessageRole.User,
    content,
    ctx: streamingCtx(user),
  });
}

/**
 * Seeds `count` consecutive turns in one statement. The append command opens a
 * transaction and locks the session row per turn, which is far too slow for the
 * volume the pagination test needs.
 *
 * @param sessionId the session to seed.
 * @param count how many turns to write, numbered from 1.
 */
async function seedMessages(sessionId: string, count: number) {
  await AIChatMessage.bulkCreate(
    Array.from({ length: count }, (_, index) => ({
      sessionId,
      seq: index + 1,
      role: AIChatMessageRole.User,
      content: `turn ${index + 1}`,
      status: AIChatMessageStatus.Completed,
      runId: null,
    }))
  );
}

/**
 * Seeds `count` sessions owned by `user`, one second apart so the list order is
 * unambiguous, newest last.
 *
 * @param user the owner of the seeded sessions.
 * @param count how many sessions to write.
 * @returns the ids in newest-first order, which is the order the list returns.
 */
async function seedSessions(user: User, count: number) {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const rows = await AIChatSession.bulkCreate(
    Array.from({ length: count }, (_, index) => ({
      teamId: user.teamId,
      userId: user.id,
      title: `Session ${index + 1}`,
      createdAt: new Date(base + index * 1000),
      updatedAt: new Date(base + index * 1000),
    }))
  );

  return rows.map((row) => row.id).reverse();
}

/**
 * Counts the rows stored against a session, read outside the request so a
 * handler that wrote something despite denying access would be caught.
 *
 * @param sessionId the session to count rows for.
 * @returns the number of stored rows.
 */
function countRows(sessionId: string) {
  return AIChatMessage.count({ where: { sessionId } });
}

/**
 * Reads the `data` envelope of a JSON response body.
 *
 * @param res the response to read.
 * @returns the parsed `data` object.
 */
async function data(res: TestResponse) {
  return (await res.json()) as { data: Record<string, unknown> };
}

const originalBaseUrl = env.AI_CHAT_BASE_URL;
const originalModel = env.AI_CHAT_MODEL;

afterEach(() => {
  env.AI_CHAT_BASE_URL = originalBaseUrl;
  env.AI_CHAT_MODEL = originalModel;
  vi.unstubAllGlobals();
});

describe("POST /api/ai.sessions.create", () => {
  it("requires authentication", async () => {
    const res = await server.post("/api/ai.sessions.create", { body: {} });
    expect(res.status).toEqual(401);
  });

  it("returns the presented session", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);

    const res = await server.post("/api/ai.sessions.create", user, {
      body: { title: "Payments runbook" },
    });

    expect(res.status).toEqual(200);
    const session = (await data(res)).data as PresentedSession;
    expect(session.id).toEqual(expect.any(String));
    expect(session.title).toEqual("Payments runbook");
    expect(session.createdAt).toEqual(expect.any(String));
    expect(session.updatedAt).toEqual(expect.any(String));

    // Ownership internals are never exposed – the client already knows which
    // user it is acting as, and answering ownership questions invites it to
    // reason about them instead of being authorized.
    expect(session).not.toHaveProperty("teamId");
    expect(session).not.toHaveProperty("userId");
  });

  it("creates a session owned by the requesting user", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);

    const res = await server.post("/api/ai.sessions.create", user, {
      body: {},
    });

    const session = (await data(res)).data as PresentedSession;
    expect(await AIChatSession.findByPk(session.id)).toMatchObject({
      userId: user.id,
      teamId: user.teamId,
    });
  });
});

describe("POST /api/ai.sessions.list", () => {
  it("requires authentication", async () => {
    const res = await server.post("/api/ai.sessions.list", { body: {} });
    expect(res.status).toEqual(401);
  });

  it("returns the requesting user's sessions and no one else's", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const session = await buildSession(user);

    const stranger = await buildUser({ teamId: user.teamId });
    const foreignSession = await buildSession(stranger);

    const res = await server.post("/api/ai.sessions.list", user, { body: {} });

    expect(res.status).toEqual(200);
    const { sessions } = (await data(res)).data as {
      sessions: PresentedSession[];
    };
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain(session.id);
    expect(ids).not.toContain(foreignSession.id);
  });

  it("returns nothing for a user with no sessions", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);

    const res = await server.post("/api/ai.sessions.list", user, { body: {} });

    const { sessions } = (await data(res)).data as { sessions: unknown[] };
    expect(sessions).toEqual([]);
  });

  it("returns at most one page when the user has more sessions than the bound", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const newestFirst = await seedSessions(user, 500);

    const res = await server.post("/api/ai.sessions.list", user, { body: {} });
    const page = (await data(res)).data as SessionPage;

    expect(res.status).toEqual(200);
    expect(page.sessions).toHaveLength(100);
    // Newest first and contiguous, so the window is the top of the list.
    expect(page.sessions.map((session) => session.id)).toEqual(
      newestFirst.slice(0, 100)
    );
    expect(page.hasNextPage).toBe(true);
    expect(page.cursor).toEqual(expect.any(String));
  });

  it("does not let a caller raise the bound with a larger limit", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    await seedSessions(user, 500);

    const res = await server.post("/api/ai.sessions.list", user, {
      body: { limit: 5000 },
    });
    const page = (await data(res)).data as SessionPage;

    expect(res.status).toEqual(200);
    expect(page.sessions).toHaveLength(100);
  });

  it("resumes from the cursor with no gap and no repeat", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const newestFirst = await seedSessions(user, 250);

    const seen: string[] = [];
    let after: string | undefined;

    do {
      const res = await server.post("/api/ai.sessions.list", user, {
        body: after ? { after } : {},
      });
      const page = (await data(res)).data as SessionPage;

      expect(res.status).toEqual(200);
      expect(page.sessions.length).toBeLessThanOrEqual(100);
      // A page that claims more rows must hand out the cursor to reach them.
      expect(page.hasNextPage).toBe(page.cursor !== undefined);

      seen.push(...page.sessions.map((session) => session.id));
      after = page.cursor;
    } while (after);

    expect(seen).toEqual(newestFirst);
    expect(new Set(seen).size).toEqual(250);
  });

  it("pages sessions that share one updatedAt without a gap or a repeat", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    // Every row has the same sort key, so only the id tiebreaker in the cursor
    // can keep the boundary total: without it the rest of the group is skipped
    // as soon as the first page ends inside it.
    const shared = new Date("2026-02-01T00:00:00.000Z");
    const seeded = await AIChatSession.bulkCreate(
      Array.from({ length: 5 }, (_, index) => ({
        teamId: user.teamId,
        userId: user.id,
        title: `Tie ${index + 1}`,
        createdAt: shared,
        updatedAt: shared,
      }))
    );
    const newestFirst = seeded.map((row) => row.id).sort().reverse();

    const seen: string[] = [];
    let after: string | undefined;

    do {
      const res = await server.post("/api/ai.sessions.list", user, {
        body: after ? { after, limit: 2 } : { limit: 2 },
      });
      const page = (await data(res)).data as SessionPage;

      expect(res.status).toEqual(200);
      expect(page.sessions.length).toBeLessThanOrEqual(2);

      seen.push(...page.sessions.map((session) => session.id));
      after = page.cursor;
    } while (after);

    expect(seen).toEqual(newestFirst);
    expect(new Set(seen).size).toEqual(5);
  });

  it("returns the last page without a cursor", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const newestFirst = await seedSessions(user, 3);

    const res = await server.post("/api/ai.sessions.list", user, { body: {} });
    const page = (await data(res)).data as SessionPage;

    expect(page.sessions.map((session) => session.id)).toEqual(newestFirst);
    expect(page.hasNextPage).toBe(false);
    expect(page.cursor).toBeUndefined();
  });

  it("rejects a malformed cursor", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);

    const res = await server.post("/api/ai.sessions.list", user, {
      body: { after: "not-a-cursor" },
    });

    expect(res.status).toEqual(400);
  });
});

describe("POST /api/ai.messages.list", () => {
  it("requires authentication", async () => {
    const res = await server.post("/api/ai.messages.list", {
      body: { sessionId: unknownSessionId },
    });
    expect(res.status).toEqual(401);
  });

  it("returns an empty page for an empty session", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const session = await buildSession(user);

    const res = await server.post("/api/ai.messages.list", user, {
      body: { sessionId: session.id },
    });

    expect(res.status).toEqual(200);
    const page = (await data(res)).data as MessagePage;
    expect(page.messages).toEqual([]);
    expect(page.truncated).toBe(false);
    expect(page.cursor).toBeUndefined();
  });

  it("returns only the requested session's rows", async () => {    const user = await buildUser();
    await configureAiChat(user.team);
    const session = await buildSession(user);
    const other = await buildSession(user);
    await appendMessage(user, session.id, "mine");
    await appendMessage(user, other.id, "theirs");

    const res = await server.post("/api/ai.messages.list", user, {
      body: { sessionId: session.id },
    });

    const page = (await data(res)).data as MessagePage;
    expect(page.messages.map((m) => m.content)).toEqual(["mine"]);
  });

  it("returns the body-free digest and the miss flag for a stored turn", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const session = await buildSession(user);
    const digest = {
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "fetch_document",
          documentIds: ["doc-1"],
          titles: ["Onboarding"],
          characterCount: 120,
          truncated: false,
        },
      ],
    };
    await aiChatMessageCreator({
      user,
      sessionId: session.id,
      role: AIChatMessageRole.Assistant,
      content: "See Onboarding.",
      toolCallDigest: digest,
      citationMiss: false,
      ctx: streamingCtx(user),
    });

    const res = await server.post("/api/ai.messages.list", user, {
      body: { sessionId: session.id },
    });

    const page = (await data(res)).data as MessagePage;
    expect(page.messages[0].toolCallDigest).toEqual(digest);
    expect(page.messages[0].citationMiss).toBe(false);
    expect(JSON.stringify(page.messages[0].toolCallDigest)).not.toContain(
      "document text"
    );
  });

  it("omits the digest for a turn with no tool calls", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const session = await buildSession(user);
    await appendMessage(user, session.id, "plain question");

    const res = await server.post("/api/ai.messages.list", user, {
      body: { sessionId: session.id },
    });

    const page = (await data(res)).data as MessagePage;
    expect(page.messages[0].toolCallDigest).toBeNull();
    expect(page.messages[0].citationMiss).toBe(false);
  });

  it("denies another user's session without writing a row", async () => {
    const owner = await buildUser();
    await configureAiChat(owner.team);
    const session = await buildSession(owner);
    await appendMessage(owner, session.id, "private");
    const before = await countRows(session.id);

    const stranger = await buildUser({ teamId: owner.teamId });
    const res = await server.post("/api/ai.messages.list", stranger, {
      body: { sessionId: session.id },
    });

    expect(res.status).toEqual(404);
    expect(await countRows(session.id)).toEqual(before);
  });

  it("answers 404, not 403, for a session that does not exist", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);

    const res = await server.post("/api/ai.messages.list", user, {
      body: { sessionId: unknownSessionId },
    });

    expect(res.status).toEqual(404);
  });

  it("pages by cursor rather than by offset", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const session = await buildSession(user);
    await seedMessages(session.id, pageSize + 1);

    const first = (
      await data(
        await server.post("/api/ai.messages.list", user, {
          body: { sessionId: session.id },
        })
      )
    ).data as MessagePage;

    expect(first.truncated).toBe(true);
    expect(first.messages).toHaveLength(pageSize);
    // Strictly descending and contiguous, newest turn first.
    const firstSeqs = first.messages.map((m) => m.seq);
    expect(firstSeqs).toEqual(
      Array.from({ length: pageSize }, (_, i) => pageSize + 1 - i)
    );
    // The cursor is the oldest seq on this page, not an offset.
    expect(first.cursor).toEqual(2);

    // A turn appended mid-paging must not shift the window an offset would.
    await appendMessage(user, session.id, "appended mid-paging");

    const second = (
      await data(
        await server.post("/api/ai.messages.list", user, {
          body: { sessionId: session.id, beforeSeq: first.cursor },
        })
      )
    ).data as MessagePage;

    expect(second.truncated).toBe(false);
    expect(second.cursor).toBeUndefined();
    expect(second.messages.map((m) => m.seq)).toEqual([1]);

    // No overlap and no gap across the two pages.
    const secondSeqs = second.messages.map((m) => m.seq);
    expect(new Set([...firstSeqs, ...secondSeqs])).toEqual(
      new Set(Array.from({ length: pageSize + 1 }, (_, i) => i + 1))
    );
  });

  it("pages a 500-turn history in bound-sized pages with no gap or repeat", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const session = await buildSession(user);
    await seedMessages(session.id, 500);

    const seen: number[] = [];
    let beforeSeq: number | undefined;

    for (;;) {
      const page = (
        await data(
          await server.post("/api/ai.messages.list", user, {
            body: { sessionId: session.id, beforeSeq },
          })
        )
      ).data as MessagePage;

      expect(page.messages.length).toBeLessThanOrEqual(pageSize);
      seen.push(...page.messages.map((message) => message.seq));
      // Fails instead of spinning if a page ever repeats its own cursor.
      expect(seen.length).toBeLessThanOrEqual(500);

      if (!page.truncated) {
        break;
      }

      expect(page.cursor).toEqual(expect.any(Number));
      beforeSeq = page.cursor;
    }

    // Every turn exactly once, newest first.
    expect(seen).toEqual(Array.from({ length: 500 }, (_, index) => 500 - index));
  });

  it("returns an empty page for a cursor at the oldest message", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const session = await buildSession(user);
    await seedMessages(session.id, 3);

    const res = await server.post("/api/ai.messages.list", user, {
      body: { sessionId: session.id, beforeSeq: 1 },
    });

    const page = (await data(res)).data as MessagePage;
    expect(page.messages).toEqual([]);
    expect(page.truncated).toBe(false);
  });

  it("returns an empty page for a cursor of zero", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const session = await buildSession(user);
    await seedMessages(session.id, 3);

    const res = await server.post("/api/ai.messages.list", user, {
      body: { sessionId: session.id, beforeSeq: 0 },
    });

    expect(res.status).toEqual(200);
    const page = (await data(res)).data as MessagePage;
    expect(page.messages).toEqual([]);
  });

  it("rejects a session id that is not a uuid", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);

    const res = await server.post("/api/ai.messages.list", user, {
      body: { sessionId: "not-a-uuid" },
    });

    expect(res.status).toEqual(400);
  });
});

describe("POST /api/ai.sessions.delete", () => {
  it("requires authentication", async () => {
    const res = await server.post("/api/ai.sessions.delete", {
      body: { id: unknownSessionId },
    });
    expect(res.status).toEqual(401);
  });

  it("deletes the session and its messages", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const session = await buildSession(user);
    await appendMessage(user, session.id, "hello");

    const res = await server.post("/api/ai.sessions.delete", user, {
      body: { id: session.id },
    });

    expect(res.status).toEqual(200);
    expect(await res.json()).toMatchObject({ success: true, ok: true });
    expect(await AIChatSession.findByPk(session.id)).toBeNull();
    expect(await countRows(session.id)).toEqual(0);
  });

  it("leaves another user's session in place", async () => {
    const owner = await buildUser();
    await configureAiChat(owner.team);
    const session = await buildSession(owner);

    const stranger = await buildUser({ teamId: owner.teamId });
    const res = await server.post("/api/ai.sessions.delete", stranger, {
      body: { id: session.id },
    });

    expect(res.status).toEqual(404);
    expect(await AIChatSession.findByPk(session.id)).not.toBeNull();
  });

  it("answers 404, not 403, for a session that does not exist", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);

    const res = await server.post("/api/ai.sessions.delete", user, {
      body: { id: unknownSessionId },
    });

    expect(res.status).toEqual(404);
  });
});

describe("feature gate", () => {
  // Every AI route, including the streaming one in `ai.ts`. The gate is one
  // exported definition, so a route that answered anything but 404 here would
  // mean it bypassed it.
  const routes = [
    { path: "/api/ai.sessions.create", body: {} },
    { path: "/api/ai.sessions.list", body: {} },
    { path: "/api/ai.messages.list", body: { sessionId: unknownSessionId } },
    { path: "/api/ai.sessions.delete", body: { id: unknownSessionId } },
    {
      path: "/api/ai.chat",
      body: { messages: [{ role: "user", content: "hi" }] },
    },
  ];

  it.each(routes)(
    "returns 404 for $path when the workspace preference is off",
    async ({ path, body }) => {
      const user = await buildUser();
      env.AI_CHAT_BASE_URL = "http://localhost:20127/v1";
      env.AI_CHAT_MODEL = "test-model";

      const res = await server.post(path, user, { body });

      expect(res.status).toEqual(404);
    }
  );

  it.each(routes)(
    "returns 404 for $path when no provider is configured",
    async ({ path, body }) => {
      const user = await buildUser();
      user.team.setPreference(TeamPreference.AIChat, true);
      await user.team.save();
      env.AI_CHAT_BASE_URL = undefined;
      env.AI_CHAT_MODEL = undefined;

      const res = await server.post(path, user, { body });

      expect(res.status).toEqual(404);
    }
  );

  it.each(routes)(
    "returns 404 for $path when a provider has no model",
    async ({ path, body }) => {
      const user = await buildUser();
      user.team.setPreference(TeamPreference.AIChat, true);
      await user.team.save();
      env.AI_CHAT_BASE_URL = "http://localhost:20127/v1";
      env.AI_CHAT_MODEL = undefined;

      const res = await server.post(path, user, { body });

      expect(res.status).toEqual(404);
    }
  );

  it("answers 404, never 403, for a foreign session while the feature is off", async () => {
    // The point of checking the gate first: resolving ownership first would
    // fail this with 403 and prove that the session id exists at all.
    const owner = await buildUser();
    const session = await buildSession(owner);
    const before = await countRows(session.id);

    const stranger = await buildUser({ teamId: owner.teamId });
    env.AI_CHAT_BASE_URL = "http://localhost:20127/v1";
    env.AI_CHAT_MODEL = "test-model";

    const res = await server.post("/api/ai.messages.list", stranger, {
      body: { sessionId: session.id },
    });

    expect(res.status).toEqual(404);
    expect(await countRows(session.id)).toEqual(before);
  });

  it("does not create a session while the preference is off", async () => {
    const user = await buildUser();
    env.AI_CHAT_BASE_URL = "http://localhost:20127/v1";
    env.AI_CHAT_MODEL = "test-model";

    const before = await AIChatSession.count({ where: { userId: user.id } });
    const res = await server.post("/api/ai.sessions.create", user, {
      body: {},
    });

    expect(res.status).toEqual(404);
    expect(await AIChatSession.count({ where: { userId: user.id } })).toEqual(
      before
    );
  });

  it("does not delete a session while the preference is off", async () => {
    const owner = await buildUser();
    const session = await buildSession(owner);

    const res = await server.post("/api/ai.sessions.delete", owner, {
      body: { id: session.id },
    });

    expect(res.status).toEqual(404);
    expect(await AIChatSession.findByPk(session.id)).not.toBeNull();
  });
});

describe("ai.chat after the router is composed", () => {
  it("still resolves the streaming route", async () => {
    const user = await buildUser();
    await configureAiChat(user.team);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await server.post("/api/ai.chat", user, {
      body: { messages: [{ role: "user", content: "How do I rotate keys?" }] },
    });

    // The provider is never reached, and the refusal still arrives in band as a
    // synthetic run header, which is enough to prove the route resolved rather
    // than 404ing as unregistered.
    expect(res.status).toEqual(200);
    expect(res.headers.get("x-ai-chat-kind")).toEqual("upstream_unavailable");
    expect(await res.text()).toContain('"type":"RUN_FINISHED"');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
