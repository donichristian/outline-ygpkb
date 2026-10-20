import { client } from "~/utils/ApiClient";
import {
  clearDraft,
  createAiChatConnection,
  flushDrafts,
  readDraft,
  writeDraft,
  type AiChatKind,
  type AiChatMessage,
} from "./aiChat";

/**
 * Collects every value yielded by an async iterable into an array.
 *
 * @param iterable the iterable to drain.
 * @returns the yielded values, in order.
 */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

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

  test("should degrade to no draft when a storage write throws", () => {
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

    try {
      expect(() => writeDraft("too big", sessionA)).not.toThrow();
      expect(() => flushDrafts()).not.toThrow();
      expect(readDraft(sessionA)).toBe("");
      expect(() =>
        writeDraft("still fine after the quota error", sessionA)
      ).not.toThrow();
      // Clearing must still work after a failed write, or a draft that failed to
      // save could never be discarded either.
      expect(() => clearDraft(sessionA)).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(window, "localStorage", original);
      } else {
        delete (window as { localStorage?: unknown }).localStorage;
      }
    }
  });
});

describe("#createAiChatConnection", () => {
  const threadId = "aaaaaaaa-0000-4000-8000-000000000000";
  const runContext = { threadId, runId: "run-1" };
  const messages: AiChatMessage[] = [{ role: "user", content: "hi" }];
  const finishedFrame = `data: ${JSON.stringify({
    type: "RUN_FINISHED",
    threadId,
    runId: "run-1",
  })}\n\n`;

  /**
   * Builds a successful SSE response, optionally carrying the kind header.
   *
   * @param kind the value for the `X-AI-Chat-Kind` header.
   * @returns the stubbed response.
   */
  function sseResponse(kind?: string): Response {
    return new Response(finishedFrame, {
      status: 200,
      headers: kind ? { "X-AI-Chat-Kind": kind } : {},
    });
  }

  /** Clears the CSRF cookie so a test starts from an unauthenticated document. */
  function clearCsrfCookie(): void {
    document.cookie =
      "csrfToken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  }

  afterEach(() => {
    clearCsrfCookie();
  });

  test("should read the CSRF token at send time, not module load", async () => {
    clearCsrfCookie();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(sseResponse());
    const connection = createAiChatConnection({ fetchClient: fetchMock });

    // The cookie is set only after the module and connection exist: the header
    // must reflect this value, proving the token is read per request.
    document.cookie = "csrfToken=rotated-token; path=/";
    await collect(
      connection.connect(messages, undefined, undefined, runContext)
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("/api/ai.chat");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(headers.get("x-csrf-token")).toBe("rotated-token");
    expect(headers.get("x-editor-version")).toBe("17.0.0");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  test("should send no client-supplied tools or forwardedProps", async () => {
    document.cookie = "csrfToken=t; path=/";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(sseResponse());
    const connection = createAiChatConnection({ fetchClient: fetchMock });

    await collect(
      connection.connect(messages, undefined, undefined, runContext)
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.tools).toEqual([]);
    expect(body.forwardedProps).toEqual({});
    expect(body.threadId).toBe(threadId);
  });

  test("should observe X-AI-Chat-Kind: refusal", async () => {
    document.cookie = "csrfToken=t; path=/";
    const kinds: AiChatKind[] = [];
    const connection = createAiChatConnection({
      fetchClient: vi
        .fn<typeof fetch>()
        .mockResolvedValue(sseResponse("refusal")),
      onKind: (kind) => kinds.push(kind),
    });

    await collect(
      connection.connect(messages, undefined, undefined, runContext)
    );

    expect(kinds).toEqual(["refusal"]);
  });

  test("should observe null when the response carries no kind header", async () => {
    document.cookie = "csrfToken=t; path=/";
    const kinds: AiChatKind[] = [];
    const connection = createAiChatConnection({
      fetchClient: vi.fn<typeof fetch>().mockResolvedValue(sseResponse()),
      onKind: (kind) => kinds.push(kind),
    });

    await collect(
      connection.connect(messages, undefined, undefined, runContext)
    );

    expect(kinds).toEqual([null]);
  });

  test("should omit the CSRF header and surface a 403 as an http error", async () => {
    clearCsrfCookie();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "CSRF token invalid" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );
    const connection = createAiChatConnection({ fetchClient: fetchMock });

    await expect(
      collect(connection.connect(messages, undefined, undefined, runContext))
    ).rejects.toMatchObject({
      kind: "http",
      status: 403,
      message: "CSRF token invalid",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has("x-csrf-token")).toBe(false);
  });
});
