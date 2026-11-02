// @vitest-isolate true
import { TeamPreference } from "@shared/types";
import env from "@server/env";
import { buildDocument, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { SearchQuery } from "@server/models";
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
 * A raw agent turn: the model immediately calls the supplied tool.
 *
 * @param name the tool to call.
 * @param args the tool arguments.
 * @returns the SSE frames for the tool-call turn.
 */
function toolCallFrames(
  name = "search_workspace",
  args: Record<string, unknown> = { query: "payments deployment runbook" }
): string[] {
  const argsJson = JSON.stringify(args).replace(/"/g, '\\"');

  return [
    `data: {"id":"cmpl-1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"${name}","arguments":"${argsJson}"}}]}}]}\n\n`,
    'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
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
  ];
}

/**
 * Stubs `fetch` with the two agent turns and records every request body the
 * route sent to the provider, so a test can assert on what actually crossed
 * the stub boundary.
 *
 * @param frames the SSE frames for the tool-call turn.
 * @returns the recorded request bodies, in call order.
 */
function stubProviderTwoTurns(frames = toolCallFrames()) {
  const toolFrames = frames;
  const answer = answerFrames();
  const requestBodies: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        (_url: unknown, init: { body?: string } | undefined) => {
          requestBodies.push(init?.body ?? "");
          return Promise.resolve(
            streamingResponse(requestBodies.length === 1 ? toolFrames : answer)
          );
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
    .map(
      (frame) => JSON.parse(frame.slice("data: ".length)) as { type: string }
    );
}

interface FetchDocumentInput {
  documentId?: string;
  section?: string;
  offset?: number;
  limit?: number;
}

interface FetchDocumentOutput {
  documentId: string;
  title: string;
  url: string;
  markdown: string;
  characters: number;
  truncated: boolean;
}

type ServerTools = Awaited<ReturnType<typeof loadServerTools>>;

/**
 * Narrows the allowlist to the `fetch_document` member for direct execution.
 *
 * @param tools the loaded server allowlist.
 * @returns the tool, typed for its input and output.
 */
function getFetchDocumentTool(tools: ServerTools) {
  const tool = tools.find((candidate) => candidate.name === "fetch_document");

  if (!tool) {
    throw new Error("fetch_document is not registered");
  }

  return tool as unknown as {
    execute: (
      input: FetchDocumentInput,
      context: never
    ) => Promise<FetchDocumentOutput>;
  };
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
  it("returns a frozen array of read-only server tools", async () => {
    const tools = await loadServerTools();

    expect(Object.isFrozen(tools)).toBe(true);
    expect(tools).toHaveLength(3);
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      "search_workspace",
      "fetch_document",
      "recommend_documents",
    ]);
    for (const tool of tools) {
      expect(typeof tool.description).toEqual("string");
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.execute).toEqual("function");
    }
  });
});

describe("fetch_document tool", () => {
  it("returns the real body and canonical link for a document uuid", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      title: "Payments runbook",
      text: "The deployment runbook covers the payments service",
    });
    const fetchDocument = getFetchDocumentTool(await loadServerTools());

    const result = await fetchDocument.execute({ documentId: document.id }, {
      context: { user },
    } as never);

    expect(result).toEqual({
      documentId: document.id,
      title: "Payments runbook",
      url: document.url,
      markdown: expect.stringContaining(
        "The deployment runbook covers the payments service"
      ),
      characters: result.markdown.length,
      truncated: false,
    });
  });

  it("accepts a url slug and resolves the same document", async () => {
    const user = await buildUser();
    const document = await seedReadableDocument(user);
    const fetchDocument = getFetchDocumentTool(await loadServerTools());
    const context = { context: { user } } as never;

    const byId = await fetchDocument.execute(
      { documentId: document.id },
      context
    );
    const bySlug = await fetchDocument.execute(
      { documentId: document.url.split("/").pop() },
      context
    );

    expect(bySlug.documentId).toEqual(byId.documentId);
    expect(bySlug.url).toEqual(byId.url);
    expect(bySlug.markdown).toEqual(byId.markdown);
  });

  it("returns only the requested heading section, case-insensitively", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      text: "# Deployment\nRun the deployment steps\n\n# Rollback\nRun the rollback steps",
    });
    const fetchDocument = getFetchDocumentTool(await loadServerTools());

    const result = await fetchDocument.execute(
      { documentId: document.id, section: "ROLLBACK" },
      { context: { user } } as never
    );

    expect(result.markdown).toContain("Run the rollback steps");
    expect(result.markdown).not.toContain("Run the deployment steps");
    expect(result.truncated).toBe(false);
  });

  it("authorizes before returning any body text", async () => {
    const owner = await buildUser();
    const intruder = await buildUser();
    const document = await buildDocument({
      teamId: owner.teamId,
      userId: owner.id,
      text: "CONFIDENTIAL BODY TEXT THAT MUST NOT LEAK",
    });
    const fetchDocument = getFetchDocumentTool(await loadServerTools());

    await expect(
      fetchDocument.execute({ documentId: document.id }, {
        context: { user: intruder },
      } as never)
    ).rejects.toThrow("Authorization error");
  });

  it("refuses an archived document instead of returning its body", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      archivedAt: new Date(),
      text: "ARCHIVED BODY TEXT",
    });
    const fetchDocument = getFetchDocumentTool(await loadServerTools());

    await expect(
      fetchDocument.execute({ documentId: document.id }, {
        context: { user },
      } as never)
    ).rejects.toThrow(/archived and cannot be read/i);
  });

  it("refuses a soft-deleted document instead of returning its body", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      text: "DELETED BODY TEXT",
    });
    await document.destroy();
    const fetchDocument = getFetchDocumentTool(await loadServerTools());

    await expect(
      fetchDocument.execute({ documentId: document.id }, {
        context: { user },
      } as never)
    ).rejects.toThrow(/deleted and cannot be read/i);
  });

  it("truncates a long body and never exceeds the chunk ceiling", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      text: "a".repeat(70000),
    });
    const fetchDocument = getFetchDocumentTool(await loadServerTools());
    const context = { context: { user } } as never;

    const defaultSlice = await fetchDocument.execute(
      { documentId: document.id },
      context
    );
    expect(defaultSlice.characters).toEqual(20000);
    expect(defaultSlice.markdown).toHaveLength(20000);
    expect(defaultSlice.truncated).toBe(true);

    const cappedSlice = await fetchDocument.execute(
      { documentId: document.id, limit: 90000 },
      context
    );
    expect(cappedSlice.characters).toEqual(60000);
    expect(cappedSlice.markdown.length).toBeLessThanOrEqual(60000);
    expect(cappedSlice.truncated).toBe(true);
  });

  it("errors without an identifier instead of reading anything", async () => {
    const user = await buildUser();
    const fetchDocument = getFetchDocumentTool(await loadServerTools());

    await expect(
      fetchDocument.execute({}, { context: { user } } as never)
    ).rejects.toThrow(/No document identifier was supplied/i);
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
      firstSent.tools.map(
        (t: { function: { name: string } }) => t.function.name
      )
    ).toEqual(["search_workspace", "fetch_document", "recommend_documents"]);
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

  it("records the search tool's query in the search audit table under the ai source", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user);

    stubProviderTwoTurns();

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
    const text = await res.text();

    expect(res.status).toEqual(200);
    expect(text).toContain(" it in the runbook");

    const recorded = await SearchQuery.findAll({
      where: {
        teamId: user.teamId,
        userId: user.id,
        query: "payments deployment runbook",
      },
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].source).toEqual("ai");
    expect(recorded[0].query).toEqual("payments deployment runbook");
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
      firstSent.tools.map(
        (t: { function: { name: string } }) => t.function.name
      )
    ).toEqual(["search_workspace", "fetch_document", "recommend_documents"]);

    // The injected tool was not merged in one of them later either: the run is
    // the same two-turn loop as the clean path, ending in a real answer.
    const types = parseFrames(text).map((frame) => frame.type);
    expect(types).toContain("TOOL_CALL_RESULT");
    expect(types).toContain("RUN_FINISHED");
  });

  it("turns another team's document into a tool error without streaming its body", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user);

    const owner = await buildUser();
    const secret = await buildDocument({
      teamId: owner.teamId,
      userId: owner.id,
      title: "Secret notes",
      text: "CONFIDENTIAL BODY TEXT THAT MUST NOT LEAK",
    });
    const requestBodies = stubProviderTwoTurns(
      toolCallFrames("fetch_document", { documentId: secret.id })
    );

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
    const text = await res.text();

    // A tool error is a tool result, never an HTTP failure: the run continues.
    expect(res.status).toEqual(200);
    expect(requestBodies.length).toEqual(2);

    const secondSent = JSON.stringify(JSON.parse(requestBodies[1]).messages);
    const toolMessage = (
      JSON.parse(requestBodies[1]).messages as Array<{
        role: string;
        content: string;
      }>
    ).find((message) => message.role === "tool");

    if (!toolMessage) {
      throw new Error("the tool error was not fed back to the model");
    }

    // A tool error is fed back as an error result, so the run continues.
    const toolResult: unknown = JSON.parse(toolMessage.content);
    expect(toolResult).toEqual({ error: "Authorization error" });
    expect(secondSent).not.toContain("CONFIDENTIAL BODY TEXT");
    expect(text).not.toContain("CONFIDENTIAL BODY TEXT");
  });
});
