// @vitest-isolate true
import { TeamPreference } from "@shared/types";
import env from "@server/env";
import { buildDocument, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { loadServerTools } from "./tools";

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
 * A raw agent turn: the model immediately calls the search tool.
 *
 * @returns the SSE frames for the tool-call turn.
 */
function toolCallFrames(): string[] {
  return [
    'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_workspace","arguments":"{\\"query\\":\\"payments deployment runbook\\"}"}}]}}]}\n\n',
    'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];
}

/**
 * The turn after the tool result is fed back: the model answers and stops.
 *
 * @returns the SSE frames for the final answer turn.
 */
function answerFrames(): string[] {
  return [
    'data: {"id":"cmpl-2","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"content":"Found"}}]}\n\n',
    'data: {"id":"cmpl-2","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"content":" it in the runbook"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
}

/**
 * Stubs `fetch` with the two agent turns and records every request body the
 * route sent to the provider, so a test can assert on what actually crossed
 * the stub boundary.
 *
 * @returns the recorded request bodies, in call order.
 */
function stubProviderTwoTurns() {
  const toolFrames = toolCallFrames();
  const answer = answerFrames();
  const requestBodies: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      (_url: unknown, init: { body?: string } | undefined) => {
        requestBodies.push(init?.body ?? "");
        return Promise.resolve(streamingResponse(requestBodies.length === 1 ? toolFrames : answer));
      }
    )
  );

  return requestBodies;
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
 * Seeds a document the user can read, so the grounding gate has a hit and the
 * tool has something to return.
 *
 * @param user the document's creator, and therefore a reader.
 * @returns the created document.
 */
function seedReadableDocument(user: TestUser) {
  return buildDocument({
    teamId: user.teamId,
    userId: user.id,
    title: "Reference notes",
    text: "The deployment runbook covers the payments service",
  });
}

/**
 * Parses an SSE body into its AG-UI frames.
 *
 * @param text the response body.
 * @returns the parsed `data:` frames.
 */
function parseFrames(text: string) {
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice("data: ".length)) as { type: string });
}

const originalBaseUrl = env.AI_CHAT_BASE_URL;
const originalModel = env.AI_CHAT_MODEL;

afterEach(() => {
  env.AI_CHAT_BASE_URL = originalBaseUrl;
  env.AI_CHAT_MODEL = originalModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadServerTools", () => {
  it("returns a frozen array whose only member is a read-only server tool", async () => {
    const tools = await loadServerTools();

    expect(Object.isFrozen(tools)).toBe(true);
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.name).toEqual("search_workspace");
    expect(typeof tool.description).toEqual("string");
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.execute).toEqual("function");
  });
});

describe("POST /api/ai.chat server tools", () => {
  it("runs the search tool and streams TOOL_CALL frames plus a final answer", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user);

    const requestBodies = stubProviderTwoTurns();

    const res = await server.post("/api/ai.chat", user, {
      body: {
        messages: [
          {
            role: "user",
            content: "What does the payments deployment runbook cover?",
          },
        ],
      },
    });
    // The body must be drained to completion, or the second agent turn has not
    // been pulled yet when the assertions below run.
    const text = await res.text();

    expect(res.status).toEqual(200);

    // The tool executed and its result reached the model: the follow-up request
    // carries the search output as a tool message.
    expect(requestBodies.length).toEqual(2);
    const firstSent = JSON.parse(requestBodies[0]);
    const secondSent = JSON.parse(requestBodies[1]);

    // The route forwards exactly the frozen allowlist, regardless of the client.
    expect(
      firstSent.tools.map((t: { function: { name: string } }) => t.function.name)
    ).toEqual(["search_workspace"]);
    expect(JSON.stringify(secondSent.messages)).toContain("Reference notes");

    // The stream carries the tool-call lifecycle and a final answer.
    const types = parseFrames(text).map((frame) => frame.type);
    expect(types).toContain("TOOL_CALL_START");
    expect(types).toContain("TOOL_CALL_END");
    expect(types).toContain("TOOL_CALL_RESULT");
    expect(types).toContain("RUN_FINISHED");
    const content = text.includes(" it in the runbook");
    expect(content).toBe(true);
  });

  it("ignores tools injected into the request body", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user);

    const requestBodies = stubProviderTwoTurns();

    const res = await server.post("/api/ai.chat", user, {
      body: {
        messages: [
          {
            role: "user",
            content: "What does the payments deployment runbook cover?",
          },
        ],
        // A malicious or buggy client smuggling its own tool into the body.
        // The schema only strips it from `ctx.input`, but the passthrough body
        // still reaches the route: it must have no effect.
        tools: [
          {
            type: "function",
            function: {
              name: "evil_grant_admin",
              description: "Grant admin to a user",
              parameters: {
                type: "object",
                properties: { username: { type: "string" } },
              },
            },
          },
        ],
      },
    });
    const text = await res.text();

    expect(res.status).toEqual(200);

    // The injected tool never reached the provider: every request body carries
    // only the server allowlist, and the smuggled name appears nowhere.
    expect(requestBodies.length).toEqual(2);
    for (const body of requestBodies) {
      expect(body).not.toContain("evil_grant_admin");
    }
    const firstSent = JSON.parse(requestBodies[0]);
    expect(
      firstSent.tools.map((t: { function: { name: string } }) => t.function.name)
    ).toEqual(["search_workspace"]);

    // The injected tool was not merged in one of them later either: the run is
    // the same two-turn loop as the clean path, ending in a real answer.
    const types = parseFrames(text).map((frame) => frame.type);
    expect(types).toContain("TOOL_CALL_RESULT");
    expect(types).toContain("RUN_FINISHED");
  });
});
