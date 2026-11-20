// @vitest-isolate true
import { AIChatMessageRole, AIChatMessageStatus } from "@server/models/AIChatMessage";

describe("POST /api/ai.chat citation validation", () => {
  const writeSpy = vi.fn(
    async (payload: { content: string; citationMiss?: boolean }) => ({
      id: "turn-1",
      runId: "",
      role: AIChatMessageRole.Assistant,
      status: AIChatMessageStatus.Completed,
      content: payload.content,
      seq: 1,
    })
  );

  beforeEach(() => {
    vi.doMock("@server/commands/aiChatMessageCreator", () => ({
      default: writeSpy,
    }));
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@server/commands/aiChatMessageCreator");
    vi.restoreAllMocks();
  });

  async function driveMiddleware({
    runId,
    requestId,
    toolResults,
    answer,
  }: {
    runId: string;
    requestId: string;
    toolResults?: Array<Record<string, unknown>>;
    answer: string;
  }): Promise<import("@tanstack/ai").ChatMiddleware> {
    const module = await import("./middleware");
    const middleware = module.createPersistenceMiddleware({
      user: {} as never,
      sessionId: "session-1",
      runId,
      ctx: {} as never,
      requestId,
      releaseInFlightLock: vi.fn().mockResolvedValue(undefined),
    });

    for (const result of toolResults ?? []) {
      middleware.onChunk?.(
        {} as never,
        {
          type: "TOOL_CALL_RESULT",
          messageId: "m1",
          toolCallId: "t1",
          content: JSON.stringify({ total: 1, results: [result] }),
          role: "tool",
        } as never
      );
    }

    middleware.onChunk?.(
      {} as never,
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m1",
        delta: answer,
        timestamp: 1,
      } as never
    );

    return middleware;
  }

  it("strips a fabricated absolute URL from the persisted answer", async () => {
    writeSpy.mockClear();

    const middleware = await driveMiddleware({
      runId: "run-fabricated",
      requestId: "req-fabricated",
      toolResults: [
        {
          documentId: "doc-a1b2",
          title: "Runbook",
          url: "https://kb.example.com/runbook",
          context: "payments",
        },
      ],
      answer: "See https://evil.example.com/fake for details.",
    });

    await middleware.onFinish?.({} as never, {
      finishReason: "stop",
      duration: 1,
      content: "See https://evil.example.com/fake for details.",
    });

    const written = writeSpy.mock.calls.at(0)?.[0] as { content: string };
    expect(written.content).not.toContain("https://evil.example.com/fake");
    expect(written.content).toContain("See");
  });

  it("preserves a corpus URL the turn's tool results returned", async () => {
    writeSpy.mockClear();

    const middleware = await driveMiddleware({
      runId: "run-corpus",
      requestId: "req-corpus",
      toolResults: [
        {
          documentId: "doc-c3d4",
          title: "Runbook",
          url: "https://kb.example.com/runbook",
          context: "payments",
        },
      ],
      answer: "See https://kb.example.com/runbook for the steps.",
    });

    await middleware.onFinish?.({} as never, {
      finishReason: "stop",
      duration: 1,
      content: "See https://kb.example.com/runbook for the steps.",
    });

    const written = writeSpy.mock.calls.at(0)?.[0] as {
      content: string;
      citationMiss?: boolean;
    };
    expect(written.content).toContain("https://kb.example.com/runbook");
    expect(written.citationMiss).toBe(false);
  });

  it("marks the persisted row a citation miss when a URL was stripped", async () => {
    const { default: FreshLogger } = await import("@server/logging/Logger");
    const infoSpy = vi.spyOn(FreshLogger, "info").mockImplementation(() => {});
    writeSpy.mockClear();

    const middleware = await driveMiddleware({
      runId: "run-stripped",
      requestId: "req-stripped",
      toolResults: [
        {
          documentId: "doc-e5f6",
          title: "Runbook",
          url: "https://kb.example.com/runbook",
          context: "payments",
        },
      ],
      answer: "See https://evil.example.com/fake for details.",
    });

    await middleware.onFinish?.({} as never, {
      finishReason: "stop",
      duration: 1,
      content: "See https://evil.example.com/fake for details.",
    });

    const written = writeSpy.mock.calls.at(0)?.[0] as {
      content: string;
      citationMiss?: boolean;
    };
    expect(written.citationMiss).toBe(true);

    const rejected = infoSpy.mock.calls.filter(
      ([, message]) => message === "AI chat citation rejected"
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.[0]).toEqual("http");
    expect(rejected[0]?.[2]).toMatchObject({
      requestId: "req-stripped",
      runId: "run-stripped",
      strippedUrls: 1,
    });
  });

  it("does not mark a zero-tool answer without a source-like marker as a citation miss", async () => {
    const { default: FreshLogger } = await import("@server/logging/Logger");
    const warnSpy = vi.spyOn(FreshLogger, "warn").mockImplementation(() => {});
    writeSpy.mockClear();

    const answer = "Hello, how can I help you today?";
    const middleware = await driveMiddleware({
      runId: "run-plain",
      requestId: "req-plain",
      answer,
    });

    await middleware.onFinish?.({} as never, {
      finishReason: "stop",
      duration: 1,
      content: answer,
    });

    const written = writeSpy.mock.calls.at(0)?.[0] as {
      citationMiss?: boolean;
    };
    expect(written.citationMiss).toBe(false);
    expect(
      warnSpy.mock.calls.filter(
        ([message]) =>
          message === "AI chat answer carries no tool-returned source"
      )
    ).toHaveLength(0);
  });

  it("marks a zero-tool answer that cites a source-like marker as a citation miss", async () => {
    const { default: FreshLogger } = await import("@server/logging/Logger");
    const warnSpy = vi.spyOn(FreshLogger, "warn").mockImplementation(() => {});
    writeSpy.mockClear();

    const answer = "See /other-doc for details.";
    const middleware = await driveMiddleware({
      runId: "run-marker",
      requestId: "req-marker",
      answer,
    });

    await middleware.onFinish?.({} as never, {
      finishReason: "stop",
      duration: 1,
      content: answer,
    });

    const written = writeSpy.mock.calls.at(0)?.[0] as {
      citationMiss?: boolean;
    };
    expect(written.citationMiss).toBe(true);
    expect(
      warnSpy.mock.calls.filter(
        ([message]) =>
          message === "AI chat answer carries no tool-returned source"
      )
    ).toHaveLength(1);
  });

  it("logs at most one citation warn and no error for a zero-tool answer without a source marker", async () => {
    const { default: FreshLogger } = await import("@server/logging/Logger");
    const warnSpy = vi.spyOn(FreshLogger, "warn").mockImplementation(() => {});
    const errorSpy = vi
      .spyOn(FreshLogger, "error")
      .mockImplementation(() => {});
    const infoSpy = vi.spyOn(FreshLogger, "info").mockImplementation(() => {});
    writeSpy.mockClear();

    const middleware = await driveMiddleware({
      runId: "run-conversational",
      requestId: "req-conversational",
      answer: "Hello, how can I help you today?",
    });

    await middleware.onFinish?.({} as never, {
      finishReason: "stop",
      duration: 1,
      content: "Hello, how can I help you today?",
    });

    expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
