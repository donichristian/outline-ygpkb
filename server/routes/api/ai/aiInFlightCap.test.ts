// @vitest-isolate true
import { t } from "i18next";
import { TeamPreference } from "@shared/types";
import env from "@server/env";
import { AIChatSession } from "@server/models";
import AIChatMessage, {
  AIChatMessageRole,
  AIChatMessageStatus,
} from "@server/models/AIChatMessage";
import { buildDocument, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import Redis from "@server/storage/redis";

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
 * A complete, grounded provider turn used by the happy-path cases.
 *
 * @returns a Response carrying one grounded answer.
 */
function groundedAnswerResponse(): Response {
  return streamingResponse([
    'data: {"choices":[{"delta":{"content":"Payments."}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ]);
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
 *
 * @returns the fetch mock and a handle on the driven stream.
 */
function stubStalledProvider() {
  let notify!: () => void;
  const contacted = new Promise<void>((resolve) => {
    notify = resolve;
  });
  let handle: ReturnType<typeof stalledStreamResponse> | undefined;

  const fetchMock = vi
    .fn()
    .mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      handle = stalledStreamResponse(init.signal);
      notify();
      return Promise.resolve(handle.response);
    });

  vi.stubGlobal("fetch", fetchMock);

  return {
    fetchMock,
    contacted,
    push: (frame: string) => handle?.push(frame),
    close: () => handle?.close(),
  };
}

/**
 * Installs a `fetch` stub that resolves a fresh grounded response per call.
 *
 * The mock must build the Response inside the implementation: a single
 * pre-built Response cannot be consumed twice, and `Readable.fromWeb` locks the
 * body, so a shared instance throws `ReadableStream is locked` on the second
 * request.
 *
 * @returns the fetch mock.
 */
function stubGroundedProvider() {
  const fetchMock = vi
    .fn()
    .mockImplementation(() => Promise.resolve(groundedAnswerResponse()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Waits until a session holds at least `expected` rows.
 *
 * The assistant turn is flushed on whichever exit fires first, always after the
 * response has been terminated, so a test that produced rows must settle before
 * it ends or its insert lands during a later test's count.
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
 * Issues one chat turn.
 *
 * @param user the requesting user.
 * @param body the request body.
 * @returns the response.
 */
function chat(user: TestUser, body: Record<string, unknown>) {
  return server.post("/api/ai.chat", user, { body });
}

/**
 * The lock key the route derives for a turn, reconstructed here so a test can
 * assert on the key's presence rather than re-importing route internals.
 *
 * @param user the requesting user.
 * @param sessionId the session.
 * @returns the Redis key.
 */
function lockKey(user: TestUser, sessionId: string) {
  return `aiChat:inflight:${user.id}:${sessionId}`;
}

/**
 * Asserts that no in-flight lock key survives for the user. Scanning the user's
 * whole key space, rather than just the one key a turn took, is what catches a
 * release that deleted the wrong key or a second key acquired on the way out.
 *
 * @param user the requesting user.
 */
async function expectNoInFlightLock(user: TestUser) {
  expect(
    await Redis.defaultClient.keys(`aiChat:inflight:${user.id}:*`)
  ).toEqual([]);
}

const groundedQuestion = "What is the payments deployment runbook?";
const groundedDocumentText =
  "The deployment runbook covers the payments service";
const groundedBody = (sessionId: string) => ({
  sessionId,
  messages: [{ role: "user", content: groundedQuestion }],
});

const originalBaseUrl = env.AI_CHAT_BASE_URL;
const originalModel = env.AI_CHAT_MODEL;

afterEach(() => {
  env.AI_CHAT_BASE_URL = originalBaseUrl;
  env.AI_CHAT_MODEL = originalModel;
  vi.unstubAllGlobals();
});

describe("POST /api/ai.chat in-flight cap", () => {
  it("acquires and releases the lock across one turn, then allows a sequential turn", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user, groundedDocumentText);
    const session = await buildSession(user);

    const provider = stubStalledProvider();

    const first = chat(user, groundedBody(session.id));
    await provider.contacted;

    // The lock is held for the whole life of the stream, under this request's
    // own runId, which is what makes the release a compare-and-delete.
    const held = await Redis.defaultClient.get(lockKey(user, session.id));
    expect(held).not.toEqual(null);

    provider.push(
      'data: {"choices":[{"delta":{"content":"Payments."},"finish_reason":"stop"}]}\n\n'
    );
    provider.close();

    const firstRes = await first;
    expect(firstRes.status).toEqual(200);
    await firstRes.text();

    // Released on the `end` exit: the key is gone without waiting for a TTL.
    expect(await Redis.defaultClient.get(lockKey(user, session.id))).toEqual(
      null
    );
    await expectNoInFlightLock(user);

    // A second, sequential turn on the same session is admitted.
    stubGroundedProvider();
    const secondRes = await chat(user, groundedBody(session.id));
    expect(secondRes.status).toEqual(200);
    await secondRes.text();

    // Settle the two assistant flushes so neither insert lands during a later
    // test's message count on the shared database.
    await waitForRows(session.id, 4);
    await expectNoInFlightLock(user);
  });

  it("refuses the second of two simultaneous turns and contacts the provider exactly once", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user, groundedDocumentText);
    const session = await buildSession(user);

    const fetchMock = stubGroundedProvider();

    const [first, second] = await Promise.all([
      chat(user, groundedBody(session.id)),
      chat(user, groundedBody(session.id)),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 200]);

    const results = await Promise.all(
      [first, second].map(async (res) => ({
        kind: res.headers.get("x-ai-chat-kind"),
        text: await res.text(),
      }))
    );
    const refused = results.filter((result) => result.kind === "busy");
    const streamed = results.filter(
      (result) =>
        result.kind === null && result.text.includes('"type":"RUN_FINISHED"')
    );

    // The header is the assertion that matters: a bare error status would leave
    // the client with no frame, and a `refusal` kind would be indistinguishable
    // from the grounding gate declining to answer.
    expect(refused).toHaveLength(1);
    expect(refused[0].text).toContain('"type":"RUN_STARTED"');
    expect(refused[0].text).toContain('"type":"RUN_FINISHED"');
    expect(results.filter((result) => result.kind === "refusal")).toHaveLength(
      0
    );

    // Exactly one turn streamed and it carried the server-authored terminal
    // frame, so the other body is the refusal rather than a second answer.
    expect(streamed).toHaveLength(1);

    // The whole point of the cap: the second turn never opened an upstream call.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // And it released, so the session is usable again afterwards.
    expect(await Redis.defaultClient.get(lockKey(user, session.id))).toEqual(
      null
    );
    await expectNoInFlightLock(user);

    // Settle the winner's assistant flush so its insert does not land during a
    // later test's message count on the shared database.
    await waitForRows(session.id, 2);
  });

  it("frames the busy refusal as a complete AG-UI run and leaves the first turn untouched", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user, groundedDocumentText);
    const session = await buildSession(user);

    const provider = stubStalledProvider();
    const first = chat(user, groundedBody(session.id));
    await provider.contacted;

    // The question row is written before the first stream starts, so it is the
    // whole of the session while that answer is still generating.
    const beforeRows = await waitForRows(session.id, 1);
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0].role).toEqual(AIChatMessageRole.User);
    const questionContent = beforeRows[0].content;

    const secondRes = await chat(user, groundedBody(session.id));
    expect(secondRes.status).toEqual(200);
    expect(secondRes.headers.get("content-type")).toContain(
      "text/event-stream"
    );
    expect(secondRes.headers.get("x-ai-chat-kind")).toEqual("busy");

    const busyText = await secondRes.text();
    const types = [...busyText.matchAll(/"type":"(\w+)"/g)].map((m) => m[1]);
    expect(types).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(busyText).toContain(
      `"delta":"${t(
        "Another answer for this conversation is still being generated"
      )}"`
    );
    expect(busyText).not.toContain('"type":"CUSTOM"');
    expect(busyText).not.toContain("event:");
    expect(busyText).not.toContain("[DONE]");

    // The busy turn wrote no row, and it must not have released the lock the
    // first turn still holds — a bare release here would un-cap the session.
    const duringRows = await AIChatMessage.findAll({
      where: { sessionId: session.id },
      order: [["seq", "ASC"]],
    });
    expect(
      duringRows.map((row) => [row.role, row.content, row.status])
    ).toEqual([
      [AIChatMessageRole.User, questionContent, AIChatMessageStatus.Completed],
    ]);
    expect(
      await Redis.defaultClient.get(lockKey(user, session.id))
    ).not.toEqual(null);

    provider.push(
      'data: {"choices":[{"delta":{"content":"Payments."},"finish_reason":"stop"}]}\n\n'
    );
    provider.close();

    const firstRes = await first;
    expect(firstRes.status).toEqual(200);
    expect(await firstRes.text()).toContain('"delta":"Payments."');

    // The first run is untouched: its question row is byte-identical and its
    // answer is the streamed text, not the busy message.
    const afterRows = await waitForRows(session.id, 2);
    expect(afterRows.map((row) => [row.role, row.content, row.status])).toEqual(
      [
        [
          AIChatMessageRole.User,
          questionContent,
          AIChatMessageStatus.Completed,
        ],
        [
          AIChatMessageRole.Assistant,
          "Payments.",
          AIChatMessageStatus.Completed,
        ],
      ]
    );
  });

  it("does not block a different session or a different user", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user, groundedDocumentText);
    const heldSession = await buildSession(user);
    const otherSession = await buildSession(user);

    const otherUser = await buildUser({ teamId: user.teamId });
    await configureAiChat(otherUser);
    await seedReadableDocument(otherUser, groundedDocumentText);
    const otherUserSession = await buildSession(otherUser);

    await Redis.defaultClient.set(
      lockKey(user, heldSession.id),
      "someone-else",
      "EX",
      60
    );
    await Redis.defaultClient.set(
      lockKey(user, otherUserSession.id),
      "someone-else",
      "EX",
      60
    );

    stubGroundedProvider();

    const sameUserRes = await chat(user, groundedBody(otherSession.id));
    expect(sameUserRes.status).toEqual(200);
    await sameUserRes.text();

    const otherUserRes = await chat(
      otherUser,
      groundedBody(otherUserSession.id)
    );
    expect(otherUserRes.status).toEqual(200);
    await otherUserRes.text();

    // Neither held lock was the one this test took, so both survive – proof the
    // cap is keyed per (user, session) rather than globally.
    expect(
      await Redis.defaultClient.get(lockKey(user, heldSession.id))
    ).toEqual("someone-else");

    await waitForRows(otherSession.id, 2);
    await waitForRows(otherUserSession.id, 2);
  });

  it("does not lock a stateless chat", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user, groundedDocumentText);

    const fetchMock = stubGroundedProvider();
    const res = await chat(user, {
      messages: [{ role: "user", content: groundedQuestion }],
    });
    expect(res.status).toEqual(200);
    await res.text();

    // No session, so nothing to key on and no lock can exist for this user.
    const keys = await Redis.defaultClient.keys(`aiChat:inflight:${user.id}:*`);
    expect(keys).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A stateless chat writes no rows at all, so there is nothing to settle.
  });

  it("releases the lock after a client abort mid-stream", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user, groundedDocumentText);
    const session = await buildSession(user);
    const provider = stubStalledProvider();

    const abort = new AbortController();
    const inflight = server
      .fetch("/api/ai.chat", user, {
        method: "POST",
        body: groundedBody(session.id),
        signal: abort.signal,
      })
      .catch(() => undefined);

    try {
      await provider.contacted;
      provider.push('data: {"choices":[{"delta":{"content":"Half an "}}]}\n\n');
      const res = await inflight;
      expect(res).toBeDefined();

      abort.abort();

      // Poll for the release: the abort exit runs on its own schedule, after
      // the socket is already gone, so there is no response left to await.
      let held: string | null = "pending";
      for (let attempt = 0; attempt < 150 && held !== null; attempt += 1) {
        held = await Redis.defaultClient.get(lockKey(user, session.id));
        if (held !== null) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(held).toEqual(null);
      await expectNoInFlightLock(user);
    } finally {
      provider.close();
    }

    // A fresh turn on the same session is admitted, which is the observable
    // proof the key was not stranded.
    stubGroundedProvider();
    const nextRes = await chat(user, groundedBody(session.id));
    expect(nextRes.status).toEqual(200);
    await nextRes.text();

    // Settle every flush this test started, including the aborted partial.
    await waitForRows(session.id, 4);
  });

  it("releases the lock after an upstream stream error", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user, groundedDocumentText);
    const session = await buildSession(user);

    const encoder = new TextEncoder();
    let sent = false;
    let errored = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
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
                // Deferred by a tick so the frame is genuinely delivered first;
                // erroring in the same batch discards the buffered chunk.
                setTimeout(() => {
                  controller.error(new Error("upstream socket reset"));
                }, 0);
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }
          )
        )
      )
    );

    const res = await chat(user, groundedBody(session.id));
    expect(res.status).toEqual(200);
    expect(await res.text()).toContain('"type":"RUN_ERROR"');

    expect(await Redis.defaultClient.get(lockKey(user, session.id))).toEqual(
      null
    );
    await expectNoInFlightLock(user);

    stubGroundedProvider();
    const nextRes = await chat(user, groundedBody(session.id));
    expect(nextRes.status).toEqual(200);
    await nextRes.text();

    // Settle both flushes: the errored partial answer and the clean answer.
    await waitForRows(session.id, 4);
  });

  it("releases the lock when the grounding gate refuses the turn", async () => {
    const user = await buildUser();
    await configureAiChat(user);
    await seedReadableDocument(user, "Unrelated onboarding steps");
    const session = await buildSession(user);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await chat(user, {
      sessionId: session.id,
      messages: [
        {
          role: "user",
          content: "How do I rotate the Kubernetes signing keys?",
        },
      ],
    });

    expect(res.status).toEqual(200);
    expect(res.headers.get("x-ai-chat-kind")).toEqual("refusal");
    await res.text();
    expect(fetchMock).not.toHaveBeenCalled();

    // The refusal returns before a stream exists, so no terminal hook runs for
    // it; the route releases in-line, and no key may survive that.
    await expectNoInFlightLock(user);

    // The release is observable: the same session admits a normal turn at once.
    stubGroundedProvider();
    const nextRes = await chat(user, groundedBody(session.id));
    expect(nextRes.status).toEqual(200);
    await nextRes.text();

    await waitForRows(session.id, 4);
  });

  it("does not lock before the ownership check rejects a foreign session", async () => {
    const owner = await buildUser();
    await configureAiChat(owner);
    const session = await buildSession(owner);

    const stranger = await buildUser({ teamId: owner.teamId });
    await configureAiChat(stranger);
    await seedReadableDocument(stranger, groundedDocumentText);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await chat(stranger, groundedBody(session.id));
    expect(res.status).toEqual(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await Redis.defaultClient.get(lockKey(stranger, session.id))
    ).toEqual(null);
  });
});
