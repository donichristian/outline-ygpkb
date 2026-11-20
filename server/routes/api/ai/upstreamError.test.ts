// @vitest-isolate true
import { TeamPreference } from "@shared/types";
import env from "@server/env";
import { AIChatSession } from "@server/models";
import AIChatMessage, {
  AIChatMessageRole,
  AIChatMessageStatus,
} from "@server/models/AIChatMessage";
import { buildDocument, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";

/**
 * The TanStack OpenAI-compatible loader is the adapter-construction seam: the
 * route asks it for the module and calls `openaiCompatibleText` on the result.
 * Making it reject is how a test makes the adapter constructor throw without
 * reaching the network.
 */
const { loadOpenaiCompatible } = vi.hoisted(() => ({
  loadOpenaiCompatible: vi.fn(),
}));

vi.mock("./tanstack", () => ({
  loadTanstack: () => import("@tanstack/ai"),
  loadOpenaiCompatible: () => loadOpenaiCompatible(),
}));

const server = getTestServer();

/** The one text the client may see for an upstream failure. */
const UpstreamUnavailableMessage =
  "The AI service is temporarily unavailable. Please try again.";

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
 * Builds a fetch `Response` that delivers one frame and then fails the body,
 * which is the shape of a provider connection dropping mid-run.
 *
 * @returns a Response whose stream errors after a single frame.
 */
function failingStreamResponse(): Response {
  let sent = false;
  let errored = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Half an "}}]}\n\n'
          )
        );
        return;
      }
      if (errored) {
        return;
      }
      errored = true;
      // Deferred by a tick so the first frame is genuinely delivered before the
      // body fails; erroring in the same batch would discard it.
      setTimeout(() => {
        controller.error(new Error("upstream socket reset"));
      }, 0);
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
 * Seeds a document the user can read, so the grounding gate has a hit.
 *
 * @param user the document's creator, and therefore a reader.
 * @param text the document body.
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
 * Parses an SSE body into its AG-UI frames.
 *
 * @param text the SSE response body.
 * @returns the parsed frames, in wire order.
 */
function parseAgUiFrames(text: string) {
  return text
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map(
      (block) =>
        JSON.parse(block.slice("data: ".length)) as {
          type: string;
          code?: string;
          message?: string;
          delta?: string;
          metadata?: { tanstack?: { finishReason?: string } };
        }
    );
}

const originalBaseUrl = env.AI_CHAT_BASE_URL;
const originalModel = env.AI_CHAT_MODEL;

beforeEach(() => {
  loadOpenaiCompatible.mockImplementation(
    () => import("@tanstack/ai-openai/compatible")
  );
});

afterEach(() => {
  env.AI_CHAT_BASE_URL = originalBaseUrl;
  env.AI_CHAT_MODEL = originalModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/ai.chat upstream failure surface", () => {
  it("scrubs a provider failure that lands mid-run into one typed RUN_ERROR", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "Retention policy is reviewed each quarter"
    );
    const session = await buildSession(user);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(failingStreamResponse()));

    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [
          { role: "user", content: "When is the retention policy reviewed?" },
        ],
      },
    });
    const text = await res.text();
    const frames = parseAgUiFrames(text);
    const errors = frames.filter((frame) => frame.type === "RUN_ERROR");

    // Headers were already out when the provider failed, so the run can only
    // report itself; the response is still a 200 stream.
    expect(res.status).toEqual(200);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toEqual("upstream_unavailable");
    expect(errors[0].message).toEqual(UpstreamUnavailableMessage);
    // The provider's own text never reaches the wire.
    expect(text).not.toContain("upstream socket reset");

    const rows = await AIChatMessage.findAll({
      where: { sessionId: session.id },
      order: [["seq", "ASC"]],
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      role: AIChatMessageRole.Assistant,
      status: AIChatMessageStatus.Error,
      content: "Half an ",
    });
  });

  it("answers a failing adapter constructor with the synthetic run and no row", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "Retention policy is reviewed each quarter"
    );
    const session = await buildSession(user);

    // The provider detail is a secret and a stack string: neither may surface.
    loadOpenaiCompatible.mockRejectedValueOnce(
      new Error("adapter exploded for key sk-test-provider-secret")
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [
          { role: "user", content: "When is the retention policy reviewed?" },
        ],
      },
    });
    const text = await res.text();
    const frames = parseAgUiFrames(text);

    // Same synthetic shape the busy path uses: a completed run over HTTP 200,
    // discriminated by the header rather than by an error status.
    expect(res.status).toEqual(200);
    expect(res.headers.get("x-ai-chat-kind")).toEqual("upstream_unavailable");
    expect(frames.map((frame) => frame.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(
      frames.find((frame) => frame.type === "TEXT_MESSAGE_CONTENT")?.delta
    ).toEqual(UpstreamUnavailableMessage);
    expect(text).not.toContain("sk-test-provider-secret");

    // Pre-stream means pre-row: the conversation is left exactly as it was.
    expect(await AIChatMessage.count({ where: { sessionId: session.id } })).toEqual(
      0
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the happy path unchanged", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "Retention policy is reviewed each quarter"
    );
    const session = await buildSession(user);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          streamingResponse([
            'data: {"choices":[{"delta":{"content":"Quarterly."},"finish_reason":"stop"}]}\n\n',
          ])
        )
    );

    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [
          { role: "user", content: "When is the retention policy reviewed?" },
        ],
      },
    });
    const text = await res.text();
    const frames = parseAgUiFrames(text);

    expect(res.status).toEqual(200);
    expect(res.headers.get("x-ai-chat-kind")).toBeNull();
    expect(frames.some((frame) => frame.type === "RUN_ERROR")).toBe(false);
    expect(frames.at(-1)?.metadata?.tanstack?.finishReason).toEqual("stop");

    const rows = await AIChatMessage.findAll({
      where: { sessionId: session.id },
      order: [["seq", "ASC"]],
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      role: AIChatMessageRole.Assistant,
      status: AIChatMessageStatus.Completed,
      content: "Quarterly.",
    });
  });
});
