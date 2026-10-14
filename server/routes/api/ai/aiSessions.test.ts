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

type PresentedMessage = { seq: number; content: string };

type MessagePage = {
  messages: PresentedMessage[];
  truncated: boolean;
  cursor?: number;
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

  it("returns only the requested session's rows", async () => {
    const user = await buildUser();
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

    expect([403, 404]).toContain(res.status);
    expect(await countRows(session.id)).toEqual(before);
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

    expect([403, 404]).toContain(res.status);
    expect(await AIChatSession.findByPk(session.id)).not.toBeNull();
  });
});

describe("feature gate", () => {
  const routes = [
    { path: "/api/ai.sessions.create", body: {} },
    { path: "/api/ai.sessions.list", body: {} },
    { path: "/api/ai.messages.list", body: { sessionId: unknownSessionId } },
    { path: "/api/ai.sessions.delete", body: { id: unknownSessionId } },
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

    // The grounding gate refuses before the provider is contacted, which is
    // enough to prove the route resolved rather than 404ing as unregistered.
    expect(res.status).toEqual(200);
    expect(await res.text()).toContain("event: error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
