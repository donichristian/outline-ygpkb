// @vitest-isolate true
import { TeamPreference } from "@shared/types";
import env from "@server/env";
import AIChatSession from "@server/models/AIChatSession";
import { AIChatMessageRole } from "@server/models/AIChatMessage";
import { buildDocument, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import type * as AiChatMessageCreatorModule from "@server/commands/aiChatMessageCreator";

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

// `vi.fn(implementation)` keeps its implementation across `vi.restoreAllMocks`,
// so the injected write failure is switched per case through a hoisted flag
// instead of being restored.
const persistFailure = vi.hoisted(() => ({ failAssistantTurn: true }));

// The assistant-turn write is the persistence call under test. It is stubbed to
// reject for the assistant row while `persistFailure` is set, so the question
// still commits and the run itself completes; the successful-run case switches
// the failure off and reaches the real writer.
vi.mock("@server/commands/aiChatMessageCreator", async (importOriginal) => {
  const actual = await importOriginal<typeof AiChatMessageCreatorModule>();
  const { AIChatMessageRole: Role } = await import(
    "@server/models/AIChatMessage"
  );

  return {
    default: vi.fn(async (props: Parameters<typeof actual.default>[0]) => {
      if (persistFailure.failAssistantTurn && props.role === Role.Assistant) {
        throw new Error("assistant turn persistence unavailable");
      }
      return actual.default(props);
    }),
  };
});

const server = getTestServer();

type TestUser = Awaited<ReturnType<typeof buildUser>>;

/** One decoded AG-UI frame as it appears on the SSE wire. */
interface AgUiFrame {
  type: string;
  code?: string;
  delta?: string;
  message?: string;
}

/**
 * Builds a fetch Response that streams the supplied SSE frames and closes.
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
 * Stubs `fetch` with a provider stream that finishes normally, so the run
 * reaches its terminal hook with an answer worth persisting.
 *
 * @returns the fetch mock.
 */
function providerFetch() {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(
      streamingResponse([
        'data: {"choices":[{"delta":{"content":"The payments "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"deployment runbook "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"covers it."},"finish_reason":"stop"}]}\n\n',
      ])
    )
  );
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
function buildSession(user: TestUser) {
  return AIChatSession.create({
    teamId: user.teamId,
    userId: user.id,
  });
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
 * Parses an SSE body into its AG-UI frames, asserting the wire shape as it
 * goes: every block is an unlabelled `data:` line carrying one JSON event.
 *
 * @param text the SSE response body.
 * @returns the parsed frames, in wire order.
 */
function parseAgUiFrames(text: string): AgUiFrame[] {
  return text
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      expect(block.startsWith("data: ")).toBe(true);
      return JSON.parse(block.slice("data: ".length)) as AgUiFrame;
    });
}

/**
 * Drives one stored-session turn through the real route and returns its AG-UI
 * frames.
 *
 * @param user the requesting user.
 * @param sessionId the session to persist into.
 * @returns the frames the client received.
 */
async function runTurn(user: TestUser, sessionId: string) {
  vi.stubGlobal("fetch", providerFetch());

  const res = await server.post("/api/ai.chat", user, {
    body: {
      sessionId,
      messages: [
        { role: "user", content: "What is the payments deployment runbook?" },
      ],
    },
  });

  expect(res.status).toEqual(200);
  const text = await res.text();
  return parseAgUiFrames(text);
}

/**
 * Asserts the run surfaced the persistence failure: exactly one `RUN_ERROR`
 * frame carrying `code: "persistence-failed"`. The frame is appended by the
 * stream encoder as the run fails, so this asserts presence and uniqueness, not
 * a position among the frames the run already emitted.
 *
 * @param frames the frames the client received.
 */
function expectPersistenceFailureFramed(frames: AgUiFrame[]) {
  const failures = frames.filter(
    (frame) => frame.type === "RUN_ERROR" && frame.code === "persistence-failed"
  );
  expect(failures).toHaveLength(1);
}

const originalBaseUrl = env.AI_CHAT_BASE_URL;
const originalModel = env.AI_CHAT_MODEL;

afterEach(() => {
  env.AI_CHAT_BASE_URL = originalBaseUrl;
  env.AI_CHAT_MODEL = originalModel;
  persistFailure.failAssistantTurn = true;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("AI chat persistence failure surfacing", () => {
  it(
    "emits RUN_ERROR persistence-failed when the assistant turn cannot be persisted",
    async () => {
      const user = await buildUser();
      await configureAiChat(user);
      await seedReadableDocument(
        user,
        "The deployment runbook covers the payments service"
      );
      const session = await buildSession(user);

      const frames = await runTurn(user, session.id);

      expectPersistenceFailureFramed(frames);
    },
    30_000
  );

  it("emits no persistence-failed frame when the turn persists", async () => {
    persistFailure.failAssistantTurn = false;
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);

    vi.stubGlobal("fetch", providerFetch());
    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [
          { role: "user", content: "What is the payments deployment runbook?" },
        ],
      },
    });

    expect(res.status).toEqual(200);
    const frames = parseAgUiFrames(await res.text());

    expect(
      frames.filter(
        (frame) =>
          frame.type === "RUN_ERROR" && frame.code === "persistence-failed"
      )
    ).toHaveLength(0);
    expect(
      frames.some((frame) => frame.type === "TEXT_MESSAGE_CONTENT")
    ).toBe(true);

    // The turn persisted exactly once, through the single write path: had the
    // write failed a frame would have been emitted above.
    const { default: aiChatMessageCreator } = await import(
      "@server/commands/aiChatMessageCreator"
    );
    expect(
      vi
        .mocked(aiChatMessageCreator)
        .mock.calls.filter(
          ([props]) => props.role === AIChatMessageRole.Assistant
        )
    ).toHaveLength(1);
  }, 30_000);
});
