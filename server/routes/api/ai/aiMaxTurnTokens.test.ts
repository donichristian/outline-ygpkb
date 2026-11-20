// @vitest-isolate true
import { TeamPreference } from "@shared/types";
import env from "@server/env";
import { AIChatSession } from "@server/models";
import AIChatMessage from "@server/models/AIChatMessage";
import {
  AIChatMessageRole,
  AIChatMessageStatus,
} from "@server/models/AIChatMessage";
import { buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";

vi.mock("./tanstack", () => ({
  loadTanstack: () => import("@tanstack/ai"),
}));

vi.mock("./adapter", () => ({
  createAiChatAdapter: () =>
    import("@tanstack/ai-openai/compatible").then((mod) =>
      mod.openaiCompatibleText("test-model", {
        api: "chat-completions" as const,
        baseURL: "http://localhost:20127/v1",
        apiKey: "test-key",
      })
    ),
}));

const server = getTestServer();

type TestUser = Awaited<ReturnType<typeof buildUser>>;

/**
 * Builds a fetch `Response` that streams the supplied SSE frames and closes.
 *
 * @param chunks the raw SSE frame strings.
 * @returns a resolved Response with a readable stream body.
 */
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Stubs `fetch` with the given provider stream.
 *
 * @param chunks the provider SSE frames the stub replays.
 * @returns the parsed JSON bodies the route handed to the provider.
 */
function stubProvider(chunks: string[]) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url: string, init: { body?: unknown }) => {
      if (typeof init.body === "string") {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return Promise.resolve(streamingResponse(chunks));
    })
  );
  return bodies;
}

/**
 * Enables the workspace preference and the provider env vars for a test.
 *
 * @param user the user whose workspace is configured.
 */
async function configureAiChat(user: TestUser) {
  user.team.setPreference(TeamPreference.AIChat, true);
  await user.team.save();
  env.AI_CHAT_BASE_URL = "http://localhost:20127/v1";
  env.AI_CHAT_MODEL = "test-model";
  env.AI_CHAT_GROUNDING = false;
}

/**
 * Creates a stored session owned by the user.
 *
 * @param user the owner.
 * @returns the created session.
 */
function buildSession(user: TestUser) {
  return AIChatSession.create({
    teamId: user.teamId,
    userId: user.id,
  });
}

const originalBaseUrl = env.AI_CHAT_BASE_URL;
const originalModel = env.AI_CHAT_MODEL;
const originalReasoning = env.AI_CHAT_REASONING;
const originalGrounding = env.AI_CHAT_GROUNDING;
const originalMaxTurnTokens = env.AI_CHAT_MAX_TURN_TOKENS;

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  env.AI_CHAT_BASE_URL = originalBaseUrl;
  env.AI_CHAT_MODEL = originalModel;
  env.AI_CHAT_REASONING = originalReasoning;
  env.AI_CHAT_GROUNDING = originalGrounding;
  env.AI_CHAT_MAX_TURN_TOKENS = originalMaxTurnTokens;
  vi.unstubAllGlobals();
});

describe("POST /api/ai.chat per-turn token ceiling", () => {
  it("refuses an over-ceiling turn before any upstream call", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    const session = await buildSession(user);
    env.AI_CHAT_MAX_TURN_TOKENS = 10;

    const bodies = stubProvider([
      'data: {"choices":[{"delta":{"content":"never sent"},"finish_reason":"stop"}]}\n\n',
    ]);

    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [
          {
            role: "user",
            content:
              "Summarize the deployment runbook for the payments service in detail.",
          },
        ],
      },
    });

    expect(res.status).toEqual(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-ai-chat-kind")).toEqual("over_ceiling");

    const text = await res.text();
    const types = [...text.matchAll(/"type":"(\w+)"/g)].map((m) => m[1]);
    expect(types).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(text).not.toContain("never sent");
    expect(bodies).toHaveLength(0);

    const rows = await AIChatMessage.findAll({
      where: { sessionId: session.id },
      order: [["seq", "ASC"]],
    });
    expect(rows.map((row) => row.role)).toEqual([
      AIChatMessageRole.User,
      AIChatMessageRole.Assistant,
    ]);
    expect(rows[1].status).toEqual(AIChatMessageStatus.Completed);
    expect(text).toContain(JSON.stringify(rows[1].content));
  });

  it("sends the ceiling as max_tokens beside stream_options", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    const session = await buildSession(user);
    env.AI_CHAT_MAX_TURN_TOKENS = 1234;

    const bodies = stubProvider([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
    ]);

    await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [{ role: "user", content: "hi" }],
      },
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_tokens).toEqual(1234);
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
  });

  it("clamps a ceiling above the provider maximum to 32000", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    const session = await buildSession(user);
    env.AI_CHAT_MAX_TURN_TOKENS = 40000;

    const bodies = stubProvider([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
    ]);

    await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [{ role: "user", content: "hi" }],
      },
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_tokens).toEqual(32000);
  });

  it("sends the documented default of 4096 when that is the configured ceiling", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    const session = await buildSession(user);
    env.AI_CHAT_MAX_TURN_TOKENS = 4096;

    const bodies = stubProvider([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
    ]);

    await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [{ role: "user", content: "hi" }],
      },
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_tokens).toEqual(4096);
  });

  it("leaves the provider body unchanged when the ceiling is unset", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    const session = await buildSession(user);
    env.AI_CHAT_MAX_TURN_TOKENS = undefined;

    const bodies = stubProvider([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
    ]);

    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [{ role: "user", content: "a".repeat(4000) }],
      },
    });

    expect(res.headers.get("x-ai-chat-kind")).toBeNull();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_tokens).toBeUndefined();
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
  });

  it("treats a zero ceiling as unlimited", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    const session = await buildSession(user);
    env.AI_CHAT_MAX_TURN_TOKENS = 0;

    const bodies = stubProvider([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
    ]);

    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [{ role: "user", content: "a".repeat(4000) }],
      },
    });

    expect(res.headers.get("x-ai-chat-kind")).toBeNull();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_tokens).toBeUndefined();
  });
});
