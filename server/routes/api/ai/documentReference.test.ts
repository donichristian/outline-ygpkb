// @vitest-isolate true
import { TeamPreference } from "@shared/types";
import env from "@server/env";
import { Document } from "@server/models";
import SearchProviderManager from "@server/utils/SearchProviderManager";
import { buildDocument, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { loadServerTools, resolveDocumentReference } from "./tools";

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

const Prompt = "What does the payments deployment runbook cover?";

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

function toolCallFrames(
  name = "fetch_document",
  args: Record<string, unknown> = {}
): string[] {
  const argsJson = JSON.stringify(args).replace(/"/g, '\\"');

  return [
    `data: {"id":"cmpl-1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"${name}","arguments":"${argsJson}"}}]}}]}\n\n`,
    'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  ];
}

function answerFrames(): string[] {
  return [
    'data: {"id":"cmpl-2","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"content":"Found"}}]}\n\n',
    'data: {"id":"cmpl-2","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"content":" it in the runbook"},"finish_reason":"stop"}]}\n\n',
  ];
}

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

async function configureAiChat(user: TestUser) {
  user.team.setPreference(TeamPreference.AIChat, true);
  await user.team.save();
  env.AI_CHAT_BASE_URL = "http://localhost:20127/v1";
  env.AI_CHAT_MODEL = "test-model";
}

function seedLexicalDocument(user: TestUser) {
  return buildDocument({
    teamId: user.teamId,
    userId: user.id,
    title: "Payments deployment",
    text: "The payments deployment process is described in the runbook.",
  });
}

function seedReferencedDocument(user: TestUser) {
  return buildDocument({
    teamId: user.teamId,
    userId: user.id,
    title: "Rollback procedure",
    text: "The rollback of the billing worker is the last step of the deployment.",
  });
}

function toolMessageOf(body: string) {
  const sent = JSON.parse(body) as {
    messages: Array<{ role: string; content: string }>;
  };
  const message = sent.messages.find((entry) => entry.role === "tool");
  if (!message) {
    throw new Error("the tool result was not fed back to the model");
  }
  return JSON.parse(message.content) as {
    documentId: string;
    markdown: string;
  };
}

function parseFrames(text: string): { type: string }[] {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as { type: string });
}

const originalBaseUrl = env.AI_CHAT_BASE_URL;
const originalModel = env.AI_CHAT_MODEL;

afterEach(() => {
  env.AI_CHAT_BASE_URL = originalBaseUrl;
  env.AI_CHAT_MODEL = originalModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveDocumentReference", () => {
  it("returns undefined when the request carries no reference", async () => {
    const user = await buildUser();
    expect(await resolveDocumentReference(undefined, user)).toBeUndefined();
  });

  it("resolves a readable document to its id", async () => {
    const user = await buildUser();
    const document = await seedReferencedDocument(user);

    expect(await resolveDocumentReference(document.id, user)).toEqual(
      document.id
    );
  });

  it("raises an authorization error for a document in another workspace", async () => {
    const user = await buildUser();
    const owner = await buildUser();
    const secret = await buildDocument({
      teamId: owner.teamId,
      userId: owner.id,
      text: "CONFIDENTIAL BODY",
    });

    await expect(
      resolveDocumentReference(secret.id, user)
    ).rejects.toMatchObject({ status: 403 });
  });

  it("raises a not-found error for an archived document", async () => {
    const user = await buildUser();
    const document = await seedReferencedDocument(user);
    await document.update({ archivedAt: new Date() });

    await expect(
      resolveDocumentReference(document.id, user)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("raises a not-found error for a soft-deleted document", async () => {
    const user = await buildUser();
    const document = await seedReferencedDocument(user);
    await document.destroy();

    await expect(
      resolveDocumentReference(document.id, user)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns undefined for a reference that does not resolve", async () => {
    const user = await buildUser();

    await expect(
      resolveDocumentReference("00000000-0000-4000-8000-000000000000", user)
    ).resolves.toBeUndefined();
  });
});

describe("POST /api/ai.chat with a document reference", () => {
  it("forces the body tool on the first call and answers on the second", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedLexicalDocument(user);
    const referenced = await seedReferencedDocument(user);
    const searchForUser = vi.spyOn(
      SearchProviderManager.getProvider(),
      "searchForUser"
    );
    const requestBodies = stubProviderTwoTurns();

    const res = await server.post("/api/ai.chat", user, {
      body: {
        messages: [{ role: "user", content: Prompt }],
        documentId: referenced.id,
      },
    });

    expect(res.status).toEqual(200);
    const text = await res.text();

    expect(searchForUser).toHaveBeenCalled();
    expect(requestBodies).toHaveLength(2);

    const firstSent = JSON.parse(requestBodies[0]);
    const secondSent = JSON.parse(requestBodies[1]);

    expect(firstSent.tool_choice).toEqual({
      type: "function",
      function: { name: "fetch_document" },
    });
    expect(
      secondSent.tool_choice === undefined || secondSent.tool_choice === "auto"
    ).toBe(true);

    for (const sent of [firstSent, secondSent]) {
      expect(
        sent.tools.map((tool: { function: { name: string } }) => tool.function.name)
      ).toEqual(["search_workspace", "fetch_document", "recommend_documents"]);
    }

    const fedBack = toolMessageOf(requestBodies[1]);
    expect(fedBack.documentId).toEqual(referenced.id);
    expect(fedBack.markdown).toContain("billing worker");

    const types = parseFrames(text).map((frame) => frame.type);
    expect(types).toContain("RUN_FINISHED");
  });

  it("binds the referenced document when the model supplies no id", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedLexicalDocument(user);
    const referenced = await seedReferencedDocument(user);
    const requestBodies = stubProviderTwoTurns();

    const res = await server.post("/api/ai.chat", user, {
      body: {
        messages: [{ role: "user", content: Prompt }],
        documentId: referenced.id,
      },
    });

    expect(res.status).toEqual(200);
    await res.text();
    expect(requestBodies).toHaveLength(2);
    expect(toolMessageOf(requestBodies[1]).documentId).toEqual(referenced.id);
  });

  it("binds the referenced document when the model supplies another id", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    const lexical = await seedLexicalDocument(user);
    const referenced = await seedReferencedDocument(user);
    const requestBodies = stubProviderTwoTurns(
      toolCallFrames("fetch_document", { documentId: lexical.id })
    );

    const res = await server.post("/api/ai.chat", user, {
      body: {
        messages: [{ role: "user", content: Prompt }],
        documentId: referenced.id,
      },
    });

    expect(res.status).toEqual(200);
    await res.text();
    expect(requestBodies).toHaveLength(2);

    const fedBack = toolMessageOf(requestBodies[1]);
    expect(fedBack.documentId).toEqual(referenced.id);
    expect(fedBack.markdown).not.toContain("described in the runbook");
  });

  it("refuses an unreadable reference without contacting the provider", async () => {
    const user = await buildUser();
    const owner = await buildUser();
    await configureAiChat(user);
    await seedLexicalDocument(user);
    const secret = await buildDocument({
      teamId: owner.teamId,
      userId: owner.id,
      text: "CONFIDENTIAL BODY",
    });
    const requestBodies = stubProviderTwoTurns();

    const res = await server.post("/api/ai.chat", user, {
      body: {
        messages: [{ role: "user", content: Prompt }],
        documentId: secret.id,
      },
    });

    expect(res.status).toEqual(403);
    expect(requestBodies).toHaveLength(0);
  });

  it("refuses an archived reference without contacting the provider", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedLexicalDocument(user);
    const archived = await seedReferencedDocument(user);
    await archived.update({ archivedAt: new Date() });
    const requestBodies = stubProviderTwoTurns();

    const res = await server.post("/api/ai.chat", user, {
      body: {
        messages: [{ role: "user", content: Prompt }],
        documentId: archived.id,
      },
    });

    expect(res.status).toEqual(404);
    expect(requestBodies).toHaveLength(0);
  });

  it("refuses a soft-deleted reference without contacting the provider", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedLexicalDocument(user);
    const trashed = await seedReferencedDocument(user);
    await trashed.destroy();
    const requestBodies = stubProviderTwoTurns();

    const res = await server.post("/api/ai.chat", user, {
      body: {
        messages: [{ role: "user", content: Prompt }],
        documentId: trashed.id,
      },
    });

    expect(res.status).toEqual(404);
    expect(requestBodies).toHaveLength(0);
    expect(await Document.count({ where: { id: trashed.id } })).toEqual(0);
  });

  it("falls back to the lexical path when the reference does not resolve", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedLexicalDocument(user);
    const requestBodies = stubProviderTwoTurns(
      toolCallFrames("search_workspace", {
        query: "payments deployment runbook",
      })
    );

    const res = await server.post("/api/ai.chat", user, {
      body: {
        messages: [{ role: "user", content: Prompt }],
        documentId: "00000000-0000-4000-8000-000000000000",
      },
    });

    expect(res.status).toEqual(200);
    await res.text();
    expect(requestBodies).toHaveLength(2);
    for (const sent of requestBodies) {
      expect(sent).not.toContain("tool_choice");
    }
  });

  it("leaves the frozen allowlist, cached promise and schema unchanged", async () => {
    const user = await buildUser();
    const first = await loadServerTools();
    const second = await loadServerTools();

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.map((tool) => tool.name)).toEqual([
      "search_workspace",
      "fetch_document",
      "recommend_documents",
    ]);

    const fetchDocument = first.find((tool) => tool.name === "fetch_document");
    if (!fetchDocument) {
      throw new Error("fetch_document is missing from the allowlist");
    }
    expect(
      Object.keys(
        (fetchDocument.inputSchema as { shape?: object }).shape ?? {}
      ).sort()
    ).toEqual(["documentId", "limit", "offset", "section"]);

    const document = await seedReferencedDocument(user);
    await resolveDocumentReference(document.id, user);
    expect(await loadServerTools()).toBe(first);
  });
});
