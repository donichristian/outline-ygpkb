// @vitest-isolate true
import { TeamPreference } from "@shared/types";
import env from "@server/env";
import { AIChatSession } from "@server/models";
import AIChatMessage, {
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
 * @param frames the raw SSE frame strings.
 * @returns a resolved Response with a readable stream body.
 */
function streamingResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
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
 * Enables the workspace preference and the provider env vars for a test.
 *
 * @param user the user whose workspace is configured.
 */
async function configureAiChat(user: TestUser) {
  user.team.setPreference(TeamPreference.AIChat, true);
  await user.team.save();
  env.AI_CHAT_BASE_URL = "http://localhost:20127/v1";
  env.AI_CHAT_MODEL = "test-model";
}

/**
 * Creates a stored session owned by the user.
 *
 * @param user the owner.
 * @returns the created session.
 */
async function buildSession(user: TestUser) {
  return AIChatSession.create({
    teamId: user.teamId,
    userId: user.id,
  });
}

/**
 * Stubs `fetch` with a provider stream so a turn runs without a gateway.
 *
 * @param frames the SSE frames the provider streams back.
 */
function stubProvider(frames: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => Promise.resolve(streamingResponse(frames)))
  );
}

/**
 * Runs one chat turn through the route and returns the rows it wrote.
 *
 * @param user the requesting user.
 * @param sessionId the session to write into.
 * @returns the session's rows, oldest first.
 */
async function runTurn(user: TestUser, sessionId: string) {
  const res = await server.post("/api/ai.chat", user, {
    body: {
      sessionId,
      messages: [{ role: "user", content: "hi" }],
    },
  });

  expect(res.status).toEqual(200);
  await res.text();

  return AIChatMessage.findAll({
    where: { sessionId },
    order: [["seq", "ASC"]],
  });
}

const originalBaseUrl = env.AI_CHAT_BASE_URL;
const originalModel = env.AI_CHAT_MODEL;

afterEach(() => {
  env.AI_CHAT_BASE_URL = originalBaseUrl;
  env.AI_CHAT_MODEL = originalModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AI chat token usage persistence", () => {
  it("stores the provider's token counts on the assistant row", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    const session = await buildSession(user);

    // The wire shape a gateway sends with `stream_options.include_usage`: the
    // counts arrive on a trailing chunk with no choices.
    stubProvider([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n',
    ]);

    const rows = await runTurn(user, session.id);
    expect(rows).toHaveLength(2);

    const assistant = rows[1];
    expect(assistant.role).toEqual(AIChatMessageRole.Assistant);
    expect(assistant.status).toEqual(AIChatMessageStatus.Completed);

    // Reloaded from the database, so the assertion is about the stored column
    // rather than the instance the writer left in memory.
    await assistant.reload();
    expect(assistant.promptTokens).toEqual(11);
    expect(assistant.completionTokens).toEqual(7);
  });

  it("leaves the token columns null when the provider reports no usage", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    const session = await buildSession(user);

    // A provider that ignored `include_usage` sends no trailing usage chunk.
    stubProvider([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
    ]);

    const rows = await runTurn(user, session.id);
    expect(rows).toHaveLength(2);

    const assistant = rows[1];
    expect(assistant.status).toEqual(AIChatMessageStatus.Completed);

    // Null, not zero: a zero would read as "this turn was free".
    await assistant.reload();
    expect(assistant.promptTokens).toEqual(null);
    expect(assistant.completionTokens).toEqual(null);
  });

  it("keeps the token counts off the messages endpoint", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    const session = await buildSession(user);

    stubProvider([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
    ]);

    await runTurn(user, session.id);

    const res = await server.post("/api/ai.messages.list", user, {
      body: { sessionId: session.id },
    });
    const body = await res.json();
    const assistant = body.data.messages.find(
      (message: { role: string }) => message.role === AIChatMessageRole.Assistant
    );

    expect(assistant).toBeDefined();
    expect(assistant).not.toHaveProperty("promptTokens");
    expect(assistant).not.toHaveProperty("completionTokens");
  });
});
