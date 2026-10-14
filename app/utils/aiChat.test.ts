import { client } from "~/utils/ApiClient";
import {
  AiChatError,
  clearDraft,
  createSession,
  deleteSession,
  flushDrafts,
  listMessages,
  listSessions,
  parseSSEStream,
  readDraft,
  streamAiChat,
  writeDraft,
  type AiChatMessage,
} from "./aiChat";

/**
 * Builds a `ReadableStream` that emits the given byte chunks verbatim. Chunk
 * boundaries are preserved so tests can simulate frames split mid-flight.
 *
 * @param chunks the byte chunks to emit.
 * @returns a readable stream of the concatenated chunks.
 */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/**
 * Encodes a list of SSE frame strings into the byte chunks a stream would emit.
 *
 * @param frames the raw frame strings.
 * @returns the encoded chunks.
 */
function encodeFrames(frames: string[]): Uint8Array[] {
  return frames.map((frame) => new TextEncoder().encode(frame));
}

/**
 * Collects every value yielded by an async generator into an array.
 *
 * @param generator the generator to drain.
 * @returns the yielded values, in order.
 */
async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of generator) {
    values.push(value);
  }
  return values;
}

/** The refusal text the server sends, including its typographic apostrophe. */
const refusalText =
  "This assistant only answers from this workspace’s knowledge base";

describe("#parseSSEStream", () => {
  test("should yield a delta event for each content frame", async () => {
    const stream = streamOf(
      encodeFrames([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );

    const events = await collect(parseSSEStream(stream));

    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
    ]);
  });

  test("should reassemble a frame split across chunk boundaries", async () => {
    const full =
      'data: {"choices":[{"delta":{"content":"split"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\n' +
      "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(full);

    // Slice the byte stream at awkward offsets so frames span boundaries.
    const chunks = [bytes.slice(0, 5), bytes.slice(5, 33), bytes.slice(33)];
    const events = await collect(parseSSEStream(streamOf(chunks)));

    expect(events).toEqual([
      { type: "delta", text: "split" },
      { type: "delta", text: "!" },
    ]);
  });

  test("should stop iterating at the [DONE] terminator", async () => {
    const stream = streamOf(
      encodeFrames([
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        "data: [DONE]\n\n",
        'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
      ])
    );

    expect(await collect(parseSSEStream(stream))).toHaveLength(1);
  });

  test("should throw a typed error for an event: error frame", async () => {
    const stream = streamOf(
      encodeFrames([
        'event: error\ndata: {"error":"The AI chat stream failed"}\n\n',
      ])
    );

    const gen = parseSSEStream(stream);

    await expect(collect(gen)).rejects.toThrow(AiChatError);
    await expect(
      collect(
        parseSSEStream(
          streamOf(encodeFrames(['event: error\ndata: {"error":"boom"}\n\n']))
        )
      )
    ).rejects.toMatchObject({ kind: "stream", message: "boom" });
  });

  test("should parse a refusal frame as kind: refusal", async () => {
    const stream = streamOf(
      encodeFrames([
        `event: error\ndata: {"error":"${refusalText}","kind":"refusal"}\n\n`,
      ])
    );

    await expect(collect(parseSSEStream(stream))).rejects.toMatchObject({
      kind: "refusal",
      message: refusalText,
    });
  });

  test("should parse a busy frame as kind: busy", async () => {
    // Transient contention, not a considered refusal: the two want opposite UI.
    const stream = streamOf(
      encodeFrames([
        'event: error\ndata: {"error":"Another answer for this conversation is still being generated","kind":"busy"}\n\n',
      ])
    );

    await expect(collect(parseSSEStream(stream))).rejects.toMatchObject({
      kind: "busy",
      message: "Another answer for this conversation is still being generated",
    });
  });

  test("should default an untyped error frame to kind: stream", async () => {
    // No `kind` field: the legacy mid-stream failure shape must not be read as
    // a refusal.
    const stream = streamOf(
      encodeFrames(['event: error\ndata: {"error":"boom"}\n\n'])
    );

    await expect(collect(parseSSEStream(stream))).rejects.toMatchObject({
      kind: "stream",
      message: "boom",
    });
  });

  test("should treat a malformed error payload as kind: stream", async () => {
    // An unparseable error is a failure, never a silent refusal.
    const stream = streamOf(encodeFrames(["event: error\ndata: not-json\n\n"]));

    await expect(collect(parseSSEStream(stream))).rejects.toMatchObject({
      kind: "stream",
      message: "The AI chat stream failed",
    });
  });

  test("should round-trip the literal server refusal frame over the wire", async () => {
    // The exact bytes the server asserts in ai.test.ts. This is the only test
    // proving both ends agree on the wire contract.
    const frame = `event: error\ndata: {"error":"${refusalText}","kind":"refusal"}\n\n`;

    await expect(
      collect(parseSSEStream(streamOf(encodeFrames([frame]))))
    ).rejects.toMatchObject({ kind: "refusal", message: refusalText });
  });

  test("should ignore frames that carry no data", async () => {
    const stream = streamOf(encodeFrames([": keep-alive\n\n"]));

    expect(await collect(parseSSEStream(stream))).toEqual([]);
  });

  test("should skip contentless frames without inventing text", async () => {
    // A role-only opener, a frame with no `choices`, a delta with no content, an
    // explicitly null finish_reason, and a truncated byte sequence at end.
    const stream = streamOf(
      encodeFrames([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        "data: {}\n\n",
        'data: {"choices":[{"delta":{}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"real"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"cut',
      ])
    );

    expect(await collect(parseSSEStream(stream))).toEqual([
      { type: "delta", text: "real" },
    ]);
  });

  test("should yield a terminal event for event: complete", async () => {
    const stream = streamOf(
      encodeFrames([
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
        'event: complete\ndata: {"runId":"run-1","finishReason":"stop"}\n\n',
        'data: {"choices":[{"delta":{"content":"after"}}]}\n\n',
      ])
    );

    expect(await collect(parseSSEStream(stream))).toEqual([
      { type: "delta", text: "done" },
      {
        type: "terminal",
        outcome: "complete",
        runId: "run-1",
        finishReason: "stop",
      },
    ]);
  });

  test("should yield a terminal event for event: truncated", async () => {
    const stream = streamOf(
      encodeFrames([
        'data: {"choices":[{"delta":{"content":"half"}}]}\n\n',
        'event: truncated\ndata: {"runId":"run-2","finishReason":null}\n\n',
      ])
    );

    expect(await collect(parseSSEStream(stream))).toEqual([
      { type: "delta", text: "half" },
      {
        type: "terminal",
        outcome: "truncated",
        runId: "run-2",
        finishReason: null,
      },
    ]);
  });

  test("should end iteration at a terminal frame whose payload is malformed", async () => {
    // A terminal frame that cannot be parsed is still terminal; refusing to end
    // would leave the caller unable to tell a whole answer from a cut-off one.
    const stream = streamOf(
      encodeFrames(["event: complete\ndata: not-json\n\n"])
    );

    expect(await collect(parseSSEStream(stream))).toEqual([
      {
        type: "terminal",
        outcome: "complete",
        runId: undefined,
        finishReason: null,
      },
    ]);
  });
});

describe("#streamAiChat", () => {
  const messages: AiChatMessage[] = [{ role: "user", content: "hi" }];
  const complete =
    'event: complete\ndata: {"runId":"r","finishReason":"stop"}\n\n';
  const truncatedFrame =
    'event: truncated\ndata: {"runId":"r","finishReason":null}\n\n';

  /**
   * Builds a single assistant delta frame carrying the given text.
   *
   * @param text the incremental content.
   * @returns the encoded SSE frame.
   */
  function deltaFrame(text: string) {
    return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Points `fetch` at a single SSE response body.
   *
   * @param frames the raw SSE frames the response carries.
   * @returns the fetch mock, for asserting on the request.
   */
  function stubStream(frames: string[]) {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(streamOf(encodeFrames(frames)), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  test("should accumulate deltas from a stubbed streaming response", async () => {
    const fetchMock = stubStream([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      complete,
    ]);

    const deltas = await collect(streamAiChat(messages));

    expect(deltas.map((delta) => delta.text).join("")).toBe("Hello world");
    expect(deltas).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " world" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("should send the CSRF and editor-version headers", async () => {
    const fetchMock = stubStream([complete]);

    await collect(streamAiChat(messages));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai.chat",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      })
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBeDefined();
    expect(headers["x-editor-version"]).toBe("17.0.0");
  });

  test("should send sessionId in the request body and no messages", async () => {
    const fetchMock = stubStream([complete]);

    await collect(streamAiChat(messages, { sessionId: "session-42" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(body.sessionId).toBe("session-42");
    expect(body).not.toHaveProperty("messages");
  });

  test("should omit sessionId from the request body when not supplied", async () => {
    const fetchMock = stubStream([complete]);

    await collect(streamAiChat(messages));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(init.body).toBe(JSON.stringify({ messages }));
    expect(body).not.toHaveProperty("sessionId");
  });

  test("should throw a typed http error on a 403 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "CSRF token invalid" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(collect(streamAiChat(messages))).rejects.toMatchObject({
      kind: "http",
      status: 403,
      message: "CSRF token invalid",
    });
  });

  test("should throw a typed http error on a 404 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 404 }))
    );

    await expect(collect(streamAiChat(messages))).rejects.toMatchObject({
      kind: "http",
      status: 404,
    });
  });

  /**
   * The terminal-frame contract, which is conditional on the turn being
   * session-backed. The server authors a terminal frame only for those turns —
   * `finish()` in `server/routes/api/ai/ai.ts` early-returns on
   * `if (!ownedSession)` — so the client must demand one only when it sent a
   * `sessionId`. Every row here is a distinct wire shape; the stateless rows are
   * the regression guard for the first turn of a new conversation, which is
   * sent before a session exists.
   */
  it.each([
    {
      label: "stateless, no terminal frame",
      sessionId: undefined,
      terminal: [],
      outcome: "complete",
    },
    {
      label: "stateless, event: complete",
      sessionId: undefined,
      terminal: [complete],
      outcome: "complete",
    },
    {
      label: "session-backed, event: complete",
      sessionId: "session-1",
      terminal: [complete],
      outcome: "complete",
    },
    {
      label: "session-backed, event: truncated",
      sessionId: "session-1",
      terminal: [truncatedFrame],
      outcome: "truncated",
    },
    {
      label: "session-backed, no terminal frame",
      sessionId: "session-1",
      terminal: [],
      outcome: "truncated",
    },
  ])("$label should $outcome", async ({ sessionId, terminal, outcome }) => {
    const fetchMock = stubStream([
      deltaFrame("A partial "),
      deltaFrame("sentence"),
      ...terminal,
    ]);

    const seen: string[] = [];
    let raised: unknown;
    try {
      for await (const delta of streamAiChat(messages, { sessionId })) {
        seen.push(delta.text);
      }
    } catch (err) {
      raised = err;
    }

    // The deltas reached the caller in full either way: a truncated answer is
    // an error about completeness, not about losing the text that arrived.
    expect(seen).toEqual(["A partial ", "sentence"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (outcome === "complete") {
      expect(raised).toBeUndefined();
    } else {
      expect(raised).toMatchObject({ kind: "truncated" });
    }
  });

  test("should raise kind: aborted, distinct from network, on a user Stop", async () => {
    const controller = new AbortController();
    let pulls = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(controllerStream) {
        pulls += 1;
        if (pulls === 1) {
          controllerStream.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'
            )
          );
          return;
        }
        if (pulls === 2) {
          controller.abort();
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        controllerStream.close();
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    );

    const deltas: string[] = [];
    await expect(
      (async () => {
        for await (const delta of streamAiChat(messages, {
          signal: controller.signal,
        })) {
          deltas.push(delta.text);
        }
      })()
    ).rejects.toMatchObject({ kind: "aborted" });

    expect(deltas).toEqual(["first"]);
  });

  test("should raise kind: aborted when the request is stopped before it opens", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"))
    );
    controller.abort();

    await expect(
      collect(streamAiChat(messages, { signal: controller.signal }))
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  test("should raise kind: network on a genuine socket failure", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controllerStream) {
        controllerStream.error(new Error("socket hang up"));
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    );

    await expect(collect(streamAiChat(messages))).rejects.toMatchObject({
      kind: "network",
    });
  });

  test("should raise kind: refusal, not stream, for a refusal frame", async () => {
    stubStream([
      `event: error\ndata: {"error":"${refusalText}","kind":"refusal"}\n\n`,
    ]);

    await expect(collect(streamAiChat(messages))).rejects.toMatchObject({
      kind: "refusal",
      message: refusalText,
    });
  });

  test("should raise kind: busy when another turn is still streaming", async () => {
    stubStream([
      'event: error\ndata: {"error":"Another answer for this conversation is still being generated","kind":"busy"}\n\n',
    ]);

    await expect(collect(streamAiChat(messages))).rejects.toMatchObject({
      kind: "busy",
    });
  });
});

describe("session helpers", () => {
  const post = vi.mocked(client.post);
  const session = {
    id: "session-1",
    title: "First",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };

  beforeEach(() => {
    post.mockReset();
  });

  test("createSession should hit ai.sessions.create and return the session", async () => {
    post.mockResolvedValueOnce({ data: session } as never);

    expect(await createSession("First")).toEqual(session);
    expect(post).toHaveBeenCalledWith("/ai.sessions.create", {
      title: "First",
    });
  });

  test("createSession should omit an absent title rather than send undefined", async () => {
    post.mockResolvedValueOnce({ data: session } as never);

    await createSession();

    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([]);
  });

  test("listSessions should hit ai.sessions.list and unwrap the array", async () => {
    post.mockResolvedValueOnce({ data: { sessions: [session] } } as never);

    expect(await listSessions()).toEqual([session]);
    expect(post).toHaveBeenCalledWith("/ai.sessions.list", {});
  });

  test("listMessages should return the messages/truncated/cursor envelope", async () => {
    const message = {
      id: "m1",
      seq: 4,
      role: "assistant",
      content: "hi",
      status: "truncated",
      runId: "run-1",
      createdAt: "2026-01-02T00:00:00.000Z",
    };
    post.mockResolvedValueOnce({
      data: { messages: [message], truncated: true, cursor: 4 },
    } as never);

    expect(await listMessages("session-1")).toEqual({
      messages: [message],
      truncated: true,
      cursor: 4,
    });
  });

  test("listMessages should thread the beforeSeq cursor", async () => {
    post.mockResolvedValueOnce({
      data: { messages: [], truncated: false },
    } as never);

    const page = await listMessages("session-1", 7);

    expect(post).toHaveBeenCalledWith("/ai.messages.list", {
      sessionId: "session-1",
      beforeSeq: 7,
    });
    expect(page.cursor).toBeUndefined();
  });

  test("listMessages should not send a beforeSeq key when paging from the start", async () => {
    post.mockResolvedValueOnce({
      data: { messages: [], truncated: false },
    } as never);

    await listMessages("session-1");

    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["sessionId"]);
  });

  test("deleteSession should hit ai.sessions.delete with the session id", async () => {
    post.mockResolvedValueOnce({ success: true } as never);

    await deleteSession("session-1");

    expect(post).toHaveBeenCalledWith("/ai.sessions.delete", {
      id: "session-1",
    });
  });
});

describe("draft helpers", () => {
  const sessionA = "aaaaaaaa-0000-4000-8000-000000000000";
  const sessionB = "bbbbbbbb-0000-4000-8000-000000000000";

  afterEach(() => {
    clearDraft(sessionA);
    clearDraft(sessionB);
    clearDraft();
    vi.mocked(client.post).mockReset();
  });

  test("should round-trip a draft through storage", () => {
    writeDraft("half a question", sessionA);
    flushDrafts();

    expect(readDraft(sessionA)).toBe("half a question");
  });

  test("should keep the pre-create draft under its own key", () => {
    writeDraft("typed before the session existed", sessionA);
    flushDrafts();
    writeDraft("typed after a reload, no session yet");
    flushDrafts();

    expect(readDraft()).toBe("typed after a reload, no session yet");
    expect(readDraft(sessionA)).toBe("typed before the session existed");
  });

  test("should clear the draft on send", () => {
    writeDraft("about to be sent", sessionA);
    flushDrafts();

    clearDraft(sessionA);

    expect(readDraft(sessionA)).toBe("");
  });

  test("should clear an emptied composer rather than store an empty draft", () => {
    writeDraft("something", sessionA);
    flushDrafts();

    writeDraft("", sessionA);

    expect(readDraft(sessionA)).toBe("");
  });

  test("should not leak one session's draft into another's key", () => {
    writeDraft("a", sessionA);
    writeDraft("b", sessionB);
    flushDrafts();

    expect(readDraft(sessionA)).toBe("a");
    expect(readDraft(sessionB)).toBe("b");

    clearDraft(sessionA);

    expect(readDraft(sessionA)).toBe("");
    expect(readDraft(sessionB)).toBe("b");
  });

  test("should garbage-collect the draft when the session is deleted", async () => {
    writeDraft("orphaned draft", sessionA);
    flushDrafts();
    vi.mocked(client.post).mockResolvedValueOnce({ success: true } as never);

    await deleteSession(sessionA);

    expect(readDraft(sessionA)).toBe("");
  });

  test("should degrade to no draft when storage throws on access", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage is blocked");
      },
    });

    try {
      expect(() => writeDraft("never stored", sessionA)).not.toThrow();
      expect(() => flushDrafts()).not.toThrow();
      expect(readDraft(sessionA)).toBe("");
      expect(() => clearDraft(sessionA)).not.toThrow();
      expect(readDraft(sessionA)).toBe("");
    } finally {
      if (original) {
        Object.defineProperty(window, "localStorage", original);
      } else {
        delete (window as { localStorage?: unknown }).localStorage;
      }
    }
  });

  test("should degrade to no draft when a storage write throws", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => undefined,
      },
    });
    vi.mocked(client.post).mockResolvedValueOnce({ success: true } as never);

    try {
      expect(() => writeDraft("too big", sessionA)).not.toThrow();
      expect(() => flushDrafts()).not.toThrow();
      expect(readDraft(sessionA)).toBe("");
      expect(() =>
        writeDraft("still fine after the quota error", sessionA)
      ).not.toThrow();
      await expect(deleteSession(sessionA)).resolves.toBeUndefined();
    } finally {
      if (original) {
        Object.defineProperty(window, "localStorage", original);
      } else {
        delete (window as { localStorage?: unknown }).localStorage;
      }
    }
  });
});
