import {
  AiChatError,
  parseSSEStream,
  streamAiChat,
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

describe("#parseSSEStream", () => {
  test("should yield the decoded payload of each data frame", async () => {
    const stream = streamOf(
      encodeFrames([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );

    const payloads = await collect(parseSSEStream(stream));

    expect(payloads).toEqual([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
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
    const payloads = await collect(parseSSEStream(streamOf(chunks)));

    expect(payloads).toEqual([
      { choices: [{ delta: { content: "split" } }] },
      { choices: [{ delta: { content: "!" } }] },
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

    const payloads = await collect(parseSSEStream(stream));

    expect(payloads).toHaveLength(1);
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
          streamOf(
            encodeFrames(['event: error\ndata: {"error":"boom"}\n\n'])
          )
        )
      )
    ).rejects.toMatchObject({ kind: "stream", message: "boom" });
  });

  test("should ignore frames that carry no data", async () => {
    const stream = streamOf(encodeFrames([": keep-alive\n\n"]));
    const payloads = await collect(parseSSEStream(stream));

    expect(payloads).toEqual([]);
  });
});

describe("#streamAiChat", () => {
  const messages: AiChatMessage[] = [{ role: "user", content: "hi" }];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("should accumulate deltas from a stubbed streaming response", async () => {
    const body = streamOf(
      encodeFrames([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
    );

    const deltas = await collect(streamAiChat(messages));
    const text = deltas.map((delta) => delta.text).join("");

    expect(text).toBe("Hello world");
    expect(deltas).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " world" },
    ]);
  });

  test("should send the CSRF and editor-version headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(streamOf(encodeFrames(["data: [DONE]\n\n"])), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

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
    expect(init.body).toBe(JSON.stringify({ messages }));
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

  test("should stop cleanly when aborted mid-stream", async () => {
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
    ).rejects.toMatchObject({ kind: "network" });

    expect(deltas).toEqual(["first"]);
  });
});
