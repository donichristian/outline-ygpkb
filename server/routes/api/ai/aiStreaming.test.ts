// @vitest-isolate true
import { TeamPreference } from "@shared/types";
import env from "@server/env";
import Logger from "@server/logging/Logger";
import { AIChatSession } from "@server/models";
import AIChatMessage, {
  AIChatMessageRole,
  AIChatMessageStatus,
} from "@server/models/AIChatMessage";
import { buildDocument, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { OutOfScopeRefusal } from "./scope";

const server = getTestServer();

type TestUser = Awaited<ReturnType<typeof buildUser>>;

/**
 * Builds a fetch `Response` that streams the supplied SSE frames and closes.
 *
 * @param chunks the raw SSE frame strings.
 * @param status the response status.
 * @returns a resolved Response with a readable stream body.
 */
function streamingResponse(chunks: string[], status = 200): Response {
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
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Builds a fetch `Response` that fails mid-flight after one frame, as a
 * provider connection reset would.
 *
 * @returns a Response whose stream errors after emitting a single frame.
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
      // Deferred by a tick so the frame is genuinely delivered first. Erroring
      // in the same batch discards the still-buffered chunk, and a connection
      // that drops before delivering anything has no partial answer to record.
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
 * Builds a fetch `Response` over a stream the test drives by hand, so a client
 * disconnect can land between two frames instead of after the provider is done.
 *
 * `signal` is honoured the way a real `fetch` honours it: aborting errors the
 * body stream. Without that, the route's `ac.abort()` reaches a mock that
 * ignores it and the abort exit is never exercised.
 *
 * @param signal the abort signal from the route's `fetch` options.
 */
function stalledStreamResponse(signal: AbortSignal | null | undefined) {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  if (signal) {
    const onAbort = () => {
      if (!closed) {
        closed = true;
        try {
          controller?.error(new Error("The operation was aborted"));
        } catch {
          closed = true;
        }
      }
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort);
    }
  }

  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    push(frame: string) {
      if (!closed && controller) {
        controller.enqueue(encoder.encode(frame));
      }
    },
    close() {
      // The consumer may already have cancelled the stream when the client
      // disconnected, which closes it out from under this handle.
      if (!closed && controller) {
        closed = true;
        try {
          controller.close();
        } catch {
          closed = true;
        }
      }
    },
  };
}

/**
 * Stubs `fetch` with a provider stream the test drives, and exposes a promise
 * that resolves once the route has contacted it.
 *
 * The stream is only built when `fetch` is called, because the route's abort
 * signal does not exist until then — and a mock that ignores that signal never
 * lets the route's own `ac.abort()` reach the stream, which is exactly the
 * path under test.
 */
function stubStalledProvider() {
  let notify!: () => void;
  const contacted = new Promise<void>((resolve) => {
    notify = resolve;
  });
  let handle: ReturnType<typeof stalledStreamResponse> | undefined;

  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
        handle = stalledStreamResponse(init.signal);
        notify();
        return Promise.resolve(handle.response);
      })
  );

  return {
    contacted,
    push: (frame: string) => handle?.push(frame),
    close: () => handle?.close(),
  };
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
 * Seeds a document the user can read, so the grounding gate has a hit. `title`
 * is indexed alongside the body, so it is kept free of any word a negative
 * test expects NOT to match.
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
 * Reads a session's messages back through the public RPC endpoint, which is how
 * a client reopening a conversation sees them.
 *
 * @param user the owning user.
 * @param sessionId the session to read.
 * @returns the messages, newest first, as the API presents them.
 */
async function listMessages(user: TestUser, sessionId: string) {
  const res = await server.post("/api/ai.messages.list", user, {
    body: { sessionId },
  });
  const body = await res.json();
  return body.data.messages;
}

/**
 * Waits until a session holds at least `expected` rows. Only the disconnect
 * tests need this: there the socket is already gone, so there is no response
 * left to await, and the flush completes on its own schedule.
 *
 * @param sessionId the session to poll.
 * @param expected the row count to wait for.
 * @returns the rows once the count is reached, or after the budget expires.
 */
async function waitForRows(sessionId: string, expected: number) {
  const read = () =>
    AIChatMessage.findAll({ where: { sessionId }, order: [["seq", "ASC"]] });

  for (let attempt = 0; attempt < 150; attempt += 1) {
    const rows = await read();
    if (rows.length >= expected) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return read();
}

/**
 * Resolves once the route has contacted the provider, so a test knows the
 * server is committed to streaming before it pulls the client's plug.
 */
function providerContacted() {
  let notify!: () => void;
  const contacted = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const fetchMock = vi.fn().mockImplementation(() => {
    notify();
    return Promise.resolve(
      streamingResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );
  });
  return { fetchMock, contacted };
}

const originalBaseUrl = env.AI_CHAT_BASE_URL;
const originalModel = env.AI_CHAT_MODEL;

afterEach(() => {
  env.AI_CHAT_BASE_URL = originalBaseUrl;
  env.AI_CHAT_MODEL = originalModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/ai.chat turn persistence", () => {
  it("writes the question and the answer in seq order, sharing one runId", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);

    const { fetchMock } = providerContacted();
    vi.stubGlobal("fetch", fetchMock);

    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [
          { role: "user", content: "What is the payments deployment runbook?" },
        ],
      },
    });

    expect(res.status).toEqual(200);
    await res.text();

    const messages = await listMessages(user, session.id);
    expect(messages).toHaveLength(2);

    const [assistant, question] = messages;
    expect(question).toMatchObject({
      seq: 1,
      role: AIChatMessageRole.User,
      content: "What is the payments deployment runbook?",
      status: AIChatMessageStatus.Completed,
    });
    expect(assistant).toMatchObject({
      seq: 2,
      role: AIChatMessageRole.Assistant,
      content: "Hi there",
      status: AIChatMessageStatus.Completed,
    });

    // F4: one run mints one id and both rows of the turn carry it.
    expect(typeof assistant.runId).toEqual("string");
    expect(question.runId).toEqual(assistant.runId);
  });

  it("sends the newest client turn upstream exactly once", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);

    const { fetchMock } = providerContacted();
    vi.stubGlobal("fetch", fetchMock);

    await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [
          { role: "user", content: "What is the payments deployment runbook?" },
        ],
      },
    });

    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse((init as { body: string }).body).messages;
    const question = "What is the payments deployment runbook?";

    // The committed window already holds the turn, so forwarding `pendingTurn`
    // alongside it would send the question twice and bill the provider for it.
    expect(
      sent.filter((m: { content: string }) => m.content === question)
    ).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ role: "user", content: question });
  });

  it("authors a terminal complete frame derived from finish_reason", async () => {
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
            "data: [DONE]\n\n",
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

    // The client received `[DONE]` from the provider, so a sentinel-driven
    // implementation would be indistinguishable here; only the server-authored
    // frame says anything.
    expect(text).toContain("event: complete");
    expect(text).toContain('"finishReason":"stop"');
    expect(text).not.toContain("event: truncated");
  });

  it("stores the question and the refusal for a refused prompt", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user, "Unrelated onboarding steps");
    const session = await buildSession(user);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const question = "How do I rotate the Kubernetes signing keys?";
    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [{ role: "user", content: question }],
      },
    });
    const text = await res.text();

    expect(text).toContain(
      'data: {"error":"' + OutOfScopeRefusal + '","kind":"refusal"}'
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const messages = await listMessages(user, session.id);
    expect(messages).toHaveLength(2);

    // A question, then a response – not an orphan refusal the user cannot
    // reconstruct.
    const [refusal, storedQuestion] = messages;
    expect(storedQuestion).toMatchObject({
      seq: 1,
      role: AIChatMessageRole.User,
      content: question,
    });
    expect(refusal).toMatchObject({
      seq: 2,
      role: AIChatMessageRole.Assistant,
      content: OutOfScopeRefusal,
      status: AIChatMessageStatus.Completed,
    });
    expect(storedQuestion.runId).toEqual(refusal.runId);
  });

  it("stores the partial answer as aborted when the client disconnects mid-stream", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);
    const provider = stubStalledProvider();

    const abort = new AbortController();
    const inflight = server
      .fetch("/api/ai.chat", user, {
        // `server.fetch` defaults to GET, which this route does not serve.
        method: "POST",
        body: {
          sessionId: session.id,
          messages: [
            {
              role: "user",
              content: "What is the payments deployment runbook?",
            },
          ],
        },
        signal: abort.signal,
      })
      .catch(() => undefined);

    try {
      await provider.contacted;
      provider.push('data: {"choices":[{"delta":{"content":"Half an "}}]}\n\n');

      // Resolving the response headers proves koa wrote the first chunk, which
      // proves the server has already inspected it.
      const res = await inflight;
      expect(res).toBeDefined();

      abort.abort();

      const rows = await waitForRows(session.id, 2);
      expect(rows).toHaveLength(2);

      const answer = rows[1];
      expect(answer.role).toEqual(AIChatMessageRole.Assistant);
      // The status is the assertion that matters: an `error`-path flush would
      // also leave a row, and "a row exists" would not catch that.
      expect(answer.status).toEqual(AIChatMessageStatus.Aborted);
      expect(answer.content).toEqual("Half an ");
      expect(rows[0].role).toEqual(AIChatMessageRole.User);
    } finally {
      provider.close();
    }
  });

  it("stores the user turn and no assistant row when the client aborts before the first token", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);
    const provider = stubStalledProvider();

    const abort = new AbortController();
    const inflight = server
      .fetch("/api/ai.chat", user, {
        // `server.fetch` defaults to GET, which this route does not serve.
        method: "POST",
        body: {
          sessionId: session.id,
          messages: [
            {
              role: "user",
              content: "What is the payments deployment runbook?",
            },
          ],
        },
        signal: abort.signal,
      })
      .catch(() => undefined);

    try {
      await provider.contacted;
      abort.abort();
      await inflight;

      const rows = await waitForRows(session.id, 1);
      // The question survives the disconnect; nothing was generated, so there
      // is no assistant row to store – `content` is NOT NULL and the client
      // optimistically appends an empty one.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        seq: 1,
        role: AIChatMessageRole.User,
        content: "What is the payments deployment runbook?",
      });
    } finally {
      provider.close();
    }
  });

  it("stores the partial answer as errored when the upstream fails mid-flight", async () => {
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

    expect(text).toContain('{"error":"The AI chat stream failed"}');

    const rows = await waitForRows(session.id, 2);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      role: AIChatMessageRole.Assistant,
      // An abort would also leave a row, so the status is the discriminator.
      status: AIChatMessageStatus.Error,
      content: "Half an ",
    });
  });

  it.each([
    [
      "completed",
      'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\n',
      "event: complete",
    ],
    [
      "truncated",
      'data: {"choices":[{"delta":{"content":"Cut off"}}]}\n\n',
      "event: truncated",
    ],
  ])("records a stream that ends with %s", async (status, frame, event) => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(streamingResponse([frame, "data: [DONE]\n\n"]))
    );

    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [
          {
            role: "user",
            content: "What is the payments deployment runbook?",
          },
        ],
      },
    });
    const text = await res.text();

    // `data: [DONE]` is present in both cases, so only the server-authored
    // frame can tell them apart.
    expect(text).toContain("data: [DONE]");
    expect(text).toContain(event);

    const rows = await waitForRows(session.id, 2);
    expect(rows).toHaveLength(2);
    expect(rows[1].status).toEqual(status);
  });

  it("survives a malformed upstream frame without losing the turn", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          streamingResponse([
            "data: {not json at all\n\n",
            'data: {"choices":[{"delta":{"content":"Still "},"finish_reason":"stop"}]}\n\n',
          ])
        )
    );

    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [
          { role: "user", content: "What is the payments deployment runbook?" },
        ],
      },
    });
    expect(await res.text()).toContain("event: complete");

    const rows = await waitForRows(session.id, 2);
    expect(rows[1]).toMatchObject({
      content: "Still ",
      status: AIChatMessageStatus.Completed,
    });
  });

  it("writes nothing and leaves the stream byte-identical without a sessionId", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          streamingResponse([
            'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
            "data: [DONE]\n\n",
          ])
        )
    );

    // The test database is shared and not empty, so the invariant is a delta
    // rather than an absolute count.
    const messagesBefore = await AIChatMessage.count();
    const sessionsBefore = await AIChatSession.count();

    const res = await server.post("/api/ai.chat", user, {
      body: {
        messages: [
          { role: "user", content: "What is the payments deployment runbook?" },
        ],
      },
    });

    // Byte-for-byte what the route produced before turns were stored: no
    // terminal frame, no row.
    expect(await res.text()).toEqual(
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
        "data: [DONE]\n\n"
    );

    expect(await AIChatMessage.count()).toEqual(messagesBefore);
    expect(await AIChatSession.count()).toEqual(sessionsBefore);
  });

  it("writes nothing and never contacts the provider for another user's session", async () => {
    const owner = await buildUser();
    await configureAiChat(owner);
    const session = await buildSession(owner);

    const stranger = await buildUser({ teamId: owner.teamId });
    await configureAiChat(stranger);
    await seedReadableDocument(
      stranger,
      "The deployment runbook covers the payments service"
    );

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await server.post("/api/ai.chat", stranger, {
      body: {
        sessionId: session.id,
        messages: [
          { role: "user", content: "What is the payments deployment runbook?" },
        ],
      },
    });

    expect(res.status).toEqual(404);
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
    expect(fetchMock).not.toHaveBeenCalled();

    const rows = await AIChatMessage.findAll({
      where: { sessionId: session.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("writes the turn inside a transaction", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(
      user,
      "The deployment runbook covers the payments service"
    );
    const session = await buildSession(user);

    const { fetchMock } = providerContacted();
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(Logger, "warn").mockImplementation(() => {});

    const res = await server.post("/api/ai.chat", user, {
      body: {
        sessionId: session.id,
        messages: [
          { role: "user", content: "What is the payments deployment runbook?" },
        ],
      },
    });
    await res.text();

    // `ai.chat` carries no `transaction()` middleware, so the flush has to open
    // and commit its own. A warning here would mean the audit Event was dropped.
    expect(
      warnSpy.mock.calls.filter(
        ([warning]) => warning === "No transaction provided to insertEvent"
      )
    ).toHaveLength(0);
  });
});
