// @vitest-isolate true
import { TeamPreference } from "@shared/types";
import env from "@server/env";
import { AIChatSession } from "@server/models";
import AIChatMessage from "@server/models/AIChatMessage";
import { buildDocument, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";

// The real loader is ESM-only and cannot resolve outside the server runtime;
// the test replaces it with the same packages at the module boundary, so the
// route builds the genuine adapter and the provider wire format is real.
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
}

/**
 * Seeds a document the user can read, so the grounding gate has a hit.
 *
 * @param user the document's creator, and therefore a reader.
 * @param text the document body.
 * @returns the created document.
 */
function seedReadableDocument(user: TestUser, text: string) {
  return buildDocument({
    teamId: user.teamId,
    userId: user.id,
    title: "Reference notes",
    text,
  });
}

/**
 * Sends one grounded question through the public RPC endpoint.
 *
 * @param user the requesting user.
 * @param sessionId the stored conversation to append to.
 * @param extraBody additional body fields the test wants on the wire.
 * @returns the SSE response text.
 */
async function ask(
  user: TestUser,
  sessionId: string,
  extraBody: Record<string, unknown> = {}
) {
  const res = await server.post("/api/ai.chat", user, {
    body: {
      sessionId,
      messages: [
        { role: "user", content: "What is the payments deployment runbook?" },
      ],
      ...extraBody,
    },
  });
  expect(res.status).toEqual(200);
  return res.text();
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

/**
 * Waits for the assistant row, which the terminal middleware commits after the
 * stream's last frame.
 *
 * @param sessionId the session to poll.
 * @returns the rows in seq order.
 */
async function waitForRows(sessionId: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const rows = await AIChatMessage.findAll({
      where: { sessionId },
      order: [["seq", "ASC"]],
    });
    if (rows.length >= 2) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return AIChatMessage.findAll({
    where: { sessionId },
    order: [["seq", "ASC"]],
  });
}

/**
 * Parses the AG-UI frames out of an SSE response body.
 *
 * @param text the response body.
 * @returns the parsed frames.
 */
function framesOf(text: string) {
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map(
      (frame) =>
        JSON.parse(frame.slice("data: ".length)) as {
          type: string;
          delta?: string;
        }
    );
}

const reasoningKeys = (body: Record<string, unknown>) =>
  Object.keys(body).filter((key) => /reasoning/i.test(key));

const originalBaseUrl = env.AI_CHAT_BASE_URL;
const originalModel = env.AI_CHAT_MODEL;
const originalReasoning = env.AI_CHAT_REASONING;

beforeEach(async () => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  env.AI_CHAT_BASE_URL = originalBaseUrl;
  env.AI_CHAT_MODEL = originalModel;
  env.AI_CHAT_REASONING = originalReasoning;
  vi.unstubAllGlobals();
});

describe("POST /api/ai.chat reasoning", () => {
  it("sends reasoning_effort from AI_CHAT_REASONING", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    env.AI_CHAT_REASONING = "medium";
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);

    const bodies = stubProvider([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    await ask(user, session.id);

    expect(bodies).toHaveLength(1);
    const sent = bodies[0];
    expect(sent.reasoning_effort).toEqual("medium");
    // The whole reasoning family is checked, so a renamed wire field cannot
    // slip through under a second name.
    expect(reasoningKeys(sent)).toEqual(["reasoning_effort"]);
  });

  it("sends no reasoning field when reasoning is unconfigured", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    env.AI_CHAT_REASONING = undefined;
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);

    const bodies = stubProvider([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    await ask(user, session.id);

    expect(bodies).toHaveLength(1);
    expect(reasoningKeys(bodies[0])).toEqual([]);
  });

  it("ignores a reasoning level supplied in the request body", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    env.AI_CHAT_REASONING = "high";
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);

    const bodies = stubProvider([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    await ask(user, session.id, {
      // A client attempt to steer the provider's reasoning. The schema is
      // passthrough for forward compatibility, so these reach the handler —
      // the assertion is that they never reach the provider body.
      reasoning: "low",
      reasoning_effort: "minimal",
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].reasoning_effort).toEqual("high");
    expect(bodies[0].reasoning).toBeUndefined();
  });

  it("surfaces reasoning_content as reasoning frames and keeps it out of the answer", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    env.AI_CHAT_REASONING = "medium";
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);

    stubProvider([
      'data: {"choices":[{"delta":{"reasoning_content":"The runbook covers payments."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"The payments deployment runbook is indexed."},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const text = await ask(user, session.id);
    const frames = framesOf(text);
    const types = frames.map((frame) => frame.type);

    // The adapter's reasoning hook fires; the engine turns it into the AG-UI
    // reasoning lifecycle. This is the wire contract a client maps onto a
    // thinking part — recorded here, not faked.
    const start = types.indexOf("REASONING_MESSAGE_START");
    const content = types.indexOf("REASONING_MESSAGE_CONTENT");
    const end = types.indexOf("REASONING_MESSAGE_END");
    const answer = types.indexOf("TEXT_MESSAGE_CONTENT");
    expect(start).toBeGreaterThan(-1);
    expect(content).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(content);
    expect(answer).toBeGreaterThan(end);
    expect(frames[content]).toMatchObject({
      delta: "The runbook covers payments.",
    });

    // Reasoning is live-only: the stored answer is the text channel alone.
    const rows = await waitForRows(session.id);
    expect(rows.map((row) => row.content)).toEqual([
      "What is the payments deployment runbook?",
      "The payments deployment runbook is indexed.",
    ]);
  });
});
