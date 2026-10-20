import "~/stores";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MobXProviderContext } from "mobx-react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "styled-components";
import { buildLightTheme } from "@shared/styles/theme";
import type { UIMessage } from "@tanstack/ai-client";
import RootStore from "~/stores/RootStore";
import { AiChatError, clearDraft, flushDrafts } from "~/utils/aiChat";
import type { AiChatKind } from "~/utils/aiChat";
import AIChatPanel from "./AIChatPanel";
import { client } from "~/utils/ApiClient";
import type * as AiChatModule from "~/utils/aiChat";

// The panel reads the session and message stores, so it needs a root store in
// context. Seeding it with no sessions leaves the panel on an empty, unselected
// conversation, which is the state these transcript/composer tests exercise.
const rootStore = new RootStore();

// The panel composes SidebarLayout, which reaches into stores, the Aside
// container and framer-motion. None of that is under test here – the panel's
// transcript, composer and abort behaviour are – so it is stubbed to a plain
// form/container passthrough. `actions` is forwarded so the header's
// AIChatHistory dropdown stays drivable.
vi.mock("~/scenes/Document/components/SidebarLayout", () => ({
  default: ({
    children,
    actions,
    fullscreen,
  }: {
    children?: React.ReactNode;
    actions?: React.ReactNode;
    fullscreen?: boolean;
  }) => (
    <div data-testid="sidebar-layout" data-fullscreen={String(!!fullscreen)}>
      <div data-testid="sidebar-header">{actions}</div>
      {children}
    </div>
  ),
}));

// Button renders through ActionButton, which needs the action context and MobX
// store providers this focused test does not set up.
vi.mock("~/components/Button", () => ({
  default: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
    const { children, ...rest } = props;
    return <button {...rest}>{children}</button>;
  },
}));

// The header's AIChatHistory composes NudeButton (through ActionButton) and
// Tooltip (portal + delay timer). Mocking them at the root keeps the
// dropdown drivable with plain DOM clicks.
vi.mock("~/components/ActionButton", () => ({
  default: ({
    children,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest}>{children}</button>
  ),
}));

vi.mock("~/components/Tooltip", () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// jsdom's matchMedia has no listener methods, and useMobile subscribes with
// addEventListener, so a stub that reports no match is installed.
const matchMediaStub = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
});
window.matchMedia = matchMediaStub as unknown as typeof window.matchMedia;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not implement ResizeObserver, which Scrollable observes.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  ResizeObserverStub;

// The panel consumes the connection factory through a per-turn ChatClient; each
// test installs its own AG-UI frame source so the incremental, abort and error
// paths can be driven deterministically.
const createAiChatConnection = vi.hoisted(() => vi.fn());
vi.mock("~/utils/aiChat", async (importOriginal) => {
  const actual = await importOriginal<typeof AiChatModule>();
  return { ...actual, createAiChatConnection };
});

const theme = buildLightTheme({});

/**
 * Lets the client's subscription loop, send loop and post-settle re-read run to
 * quiescence inside `act`, including the macrotask the connection wrapper uses
 * to wait for its subscriber.
 */
async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 10; turn++) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The default ApiClient mock answers every path with a benign auth envelope.
// The two AI endpoints the panel reads need a proper shape instead, so the
// helper answers them; the shared afterEach restores the default afterwards.
type SessionSeed = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

type FakeChunk = { type: string; [key: string]: unknown };

/** The arguments the panel handed the connection for one turn. */
type FakeRun = {
  messages: UIMessage[];
  data?: Record<string, unknown>;
  signal?: AbortSignal;
  threadId?: string;
};

/** Rows the fake server committed, keyed by session id. */
const committed = new Map<string, Record<string, unknown>[]>();

/**
 * Records the turn a fake stream completed, so the panel's post-settle re-read
 * returns the rows a real server writes before closing the stream.
 *
 * @param threadId the session the turn belongs to.
 * @param question the user's turn.
 * @param answer the assistant's reply.
 */
function commitTurn(
  threadId: string | undefined,
  question: string,
  answer: string
) {
  if (!threadId) {
    return;
  }

  const rows = committed.get(threadId) ?? [];
  const seq = rows.length + 1;
  const createdAt = "2024-01-02T00:00:00.000Z";

  rows.push(
    {
      id: `q-${threadId}-${seq}`,
      seq,
      role: "user",
      content: question,
      status: "completed",
      createdAt,
    },
    {
      id: `a-${threadId}-${seq + 1}`,
      seq: seq + 1,
      role: "assistant",
      content: answer,
      status: "completed",
      createdAt,
    }
  );
  committed.set(threadId, rows);
}

/**
 * Builds one AG-UI frame.
 *
 * @param type the frame type.
 * @param fields every other field on the frame.
 * @returns the frame.
 */
function chunk(type: string, fields: Record<string, unknown> = {}): FakeChunk {
  return { type, timestamp: Date.now(), ...fields };
}

/** One tool call replayed by a fake turn. */
type FakeToolCall = {
  /** The id AG-UI routes every tool frame by. */
  id: string;
  /** The tool's name. */
  name: string;
  /** The parsed input, streamed as the arguments delta and repeated on END. */
  input: unknown;
  /** The tool's result. Omitted, the call stays pending. */
  output?: unknown;
  /** Await the given promise after END, before the result is emitted. */
  gateBeforeResult?: Promise<void>;
};

/** What one fake turn replays. */
type StreamScript = {
  /** Incremental assistant text, one frame per entry. */
  deltas: string[];
  /** Reasoning emitted before the answer, as one frame. */
  reasoning?: string;
  /** A tool call emitted before the answer text. */
  toolCall?: FakeToolCall;
  /** A `MESSAGES_SNAPSHOT` carrying these messages, emitted first. */
  snapshot?: Record<string, unknown>[];
  /** Skip the text envelope, leaving only the snapshot as the transcript. */
  skipText?: boolean;
  /** Await the given promise after yielding the delta at `index`. */
  gateAfter?: { index: number; promise: Promise<void> };
  /** Await the given promise after the reasoning, before the answer starts. */
  gateBeforeText?: Promise<void>;
  /** Await the given promise after the answer, before the run finishes. */
  gateBeforeFinish?: Promise<void>;
  /** The question to record alongside the answer when the stream completes. */
  question?: string;
  /** Thrown before any frame, the way a rejected request fails. */
  error?: Error;
  /** The `X-AI-Chat-Kind` the response carries, as the server sends it. */
  kind?: AiChatKind;
};

/**
 * Installs a fake connection that replays an AG-UI stream. The returned array
 * collects each run's arguments for assertions.
 *
 * @param source the frames to replay, or a function producing them per run.
 * @returns the runs the panel started.
 */
function fakeConnection(
  source: StreamScript | ((run: FakeRun) => StreamScript)
) {
  const runs: FakeRun[] = [];
  let sequence = 0;

  createAiChatConnection.mockImplementation(((
    options?: { onKind?: (kind: AiChatKind) => void }
  ) => ({
    connect: (
      messages: UIMessage[],
      data: Record<string, unknown> | undefined,
      signal: AbortSignal | undefined,
      context?: { threadId?: string }
    ) => {
      const run: FakeRun = {
        messages,
        data,
        signal,
        threadId: context?.threadId,
      };
      runs.push(run);

      const script = typeof source === "function" ? source(run) : source;
      const id = ++sequence;
      const messageId = `m-${id}`;

      return (async function* () {
        if (script.error) {
          throw script.error;
        }

        // The real connection observes the header before any frame, so the
        // panel's mapping sees the kind even for an otherwise clean run.
        options?.onKind?.(script.kind ?? null);

        const threadId = run.threadId ?? "thread";
        yield chunk("RUN_STARTED", { threadId, runId: `run-${id}` });

        if (script.snapshot) {
          yield chunk("MESSAGES_SNAPSHOT", { messages: script.snapshot });
        }

        if (script.reasoning) {
          yield chunk("REASONING_MESSAGE_START", {
            messageId: `r-${id}`,
            role: "reasoning",
          });
          yield chunk("REASONING_MESSAGE_CONTENT", {
            messageId: `r-${id}`,
            delta: script.reasoning,
          });
          yield chunk("REASONING_MESSAGE_END", { messageId: `r-${id}` });
        }

        if (script.gateBeforeText) {
          await script.gateBeforeText;
        }

        if (!script.skipText) {
          yield chunk("TEXT_MESSAGE_START", { messageId, role: "assistant" });

          if (script.toolCall) {
            const { id: toolCallId, name, input, output } = script.toolCall;
            yield chunk("TOOL_CALL_START", { toolCallId, toolCallName: name });
            yield chunk("TOOL_CALL_ARGS", {
              toolCallId,
              delta: JSON.stringify(input),
            });
            yield chunk("TOOL_CALL_END", { toolCallId, input });

            if (script.toolCall.gateBeforeResult) {
              await script.toolCall.gateBeforeResult;
            }

            if (output !== undefined) {
              yield chunk("TOOL_CALL_RESULT", {
                toolCallId,
                content: JSON.stringify(output),
              });
            }
          }
        }

        if (script.gateBeforeFinish) {
          await script.gateBeforeFinish;
        }

        if (!script.skipText) {
          for (let index = 0; index < script.deltas.length; index++) {
            yield chunk("TEXT_MESSAGE_CONTENT", {
              messageId,
              delta: script.deltas[index],
            });

            if (script.gateAfter?.index === index) {
              await script.gateAfter.promise;
            }

            if (signal?.aborted) {
              return;
            }
          }

          if (script.question !== undefined) {
            commitTurn(run.threadId, script.question, script.deltas.join(""));
          }

          yield chunk("TEXT_MESSAGE_END", { messageId });
        }

        yield chunk("RUN_FINISHED", { threadId, runId: `run-${id}` });
      })() as unknown as AsyncIterable<never>;
    },
  })) as never);

  return runs;
}

/**
 * The text a client message carries, as the panel renders it.
 *
 * @param message the message to read.
 * @returns the joined text parts.
 */
function messageText(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("");
}

// The panel's mount effect re-reads the session list through
// aiChatSessions.list(), which replaces the local set with the server's
// answer. Without this the call wipes out every session added directly to
// the store, so the mock must agree with what was seeded.
function mockEndpoints(sessions: SessionSeed[]) {
  const post = vi.mocked(client.post);
  post.mockImplementation((async (
    path: string,
    params?: { sessionId?: string }
  ) => {
    if (path === "/ai.sessions.list") {
      return { data: { sessions } };
    }
    if (path === "/ai.messages.list") {
      return {
        data: {
          messages: committed.get(params?.sessionId ?? "") ?? [],
          truncated: false,
        },
      };
    }
    return defaultPost(path);
  }) as never);
}

/**
 * The default ApiClient answer. The panel creates a conversation on the first
 * send of a new chat, so `/ai.sessions.create` must return a session with an id;
 * every other path gets a benign auth envelope.
 *
 * @param path the requested RPC path.
 * @returns the mocked response envelope.
 */
function defaultPost(path: string) {
  if (path === "/ai.sessions.create") {
    return {
      data: {
        id: "session-new",
        title: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    };
  }
  return { data: { user: {}, team: {}, groups: [], groupUsers: [] } };
}

function seedMessage(
  store: RootStore,
  sessionId: string,
  message: Record<string, unknown>
) {
  store.aiChatMessages.add({
    sessionId,
    status: "completed",
    createdAt: "2024-01-02T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    ...message,
  } as never);
}

/**
 * Renders the panel into a fresh container and returns helpers for driving and
 * inspecting it. The container and React root are torn down by `cleanup`.
 */
function renderPanel(rootStore: RootStore) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const onClose = vi.fn();

  act(() => {
    root.render(
      <MobXProviderContext.Provider value={{ rootStore }}>
        <ThemeProvider theme={theme}>
          <MemoryRouter>
            <AIChatPanel onClose={onClose} />
          </MemoryRouter>
        </ThemeProvider>
      </MobXProviderContext.Provider>
    );
  });

  const cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };

  const query = (testid: string) =>
    document.querySelector(`[data-testid="${testid}"]`);

  const click = async (el: Element | null) => {
    await act(async () => {
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  };

  const typeMessage = (text: string) => {
    const input = query("ai-chat-input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      setter?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const pressEnter = async () => {
    const input = query("ai-chat-input") as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
    });
  };

  const submit = async () => {
    const form = query("ai-chat-input")?.closest("form");
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
  };

  const transcripts = () =>
    Array.from(
      document.querySelectorAll(
        '[data-testid="message-user"], [data-testid="message-assistant"]'
      )
    ).map((el) => el.textContent);

  const inputValue = () => (query("ai-chat-input") as HTMLInputElement).value;

  return {
    query,
    click,
    typeMessage,
    pressEnter,
    submit,
    transcripts,
    inputValue,
    onClose,
    cleanup,
  };
}

describe("AIChatPanel", () => {
  // Installed before every test, not just restored after: the panel creates a
  // conversation on its first send, and the automocked `client.post` resolves
  // `undefined` until an implementation is set. `invariant` is stripped in this
  // build, so an undefined envelope is added to the store as a session with no
  // dates, which blows up the history list.
  beforeEach(() => {
    committed.clear();
    createAiChatConnection.mockReset();
    // The module-level store outlives each test; a selection or transcript left
    // behind would change which conversation the next send addresses.
    rootStore.clear();
    rootStore.aiChatSessions.setSelectedSessionId(null);
    vi.mocked(client.post).mockImplementation((async (
      path: string,
      params?: { sessionId?: string }
    ) => {
      if (path === "/ai.messages.list") {
        return {
          data: {
            messages: committed.get(params?.sessionId ?? "") ?? [],
            truncated: false,
          },
        };
      }
      return defaultPost(path);
    }) as never);
  });

  afterEach(() => {
    createAiChatConnection.mockReset();
    document.body.innerHTML = "";
    // Every test installs its own connection; no global fetch stub survives.
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    // Drafts live in module-level state and `localStorage`, which survive both
    // the DOM reset above and a panel's unmount – the very behaviour under
    // test. `clearDraft` drops the queued write and the stored key together,
    // so the next test does not inherit a stale composer.
    clearDraft();
    // The session/message seeding helpers point the global ApiClient mock at
    // the AI endpoints, so restore its default implementation.
    vi.mocked(client.post).mockImplementation(((path: string) =>
      Promise.resolve(defaultPost(path))) as never);
  });

  it("sends the message when Enter is pressed in the prompt", async () => {
    const runs = fakeConnection({ deltas: ["ok"], question: "hi" });

    const { query, typeMessage, pressEnter, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await pressEnter();

    expect(runs).toHaveLength(1);
    expect(runs[0].messages).toHaveLength(1);
    expect(runs[0].messages[0].role).toBe("user");
    expect(messageText(runs[0].messages[0])).toBe("hi");
    expect(query("message-user")?.textContent).toBe("hi");
    cleanup();
  });

  it("appends assistant text incrementally as deltas arrive", async () => {
    // The stream is released between assertions, so the intermediate
    // transcript state is observable.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    fakeConnection({
      deltas: ["Hel", "lo"],
      gateAfter: { index: 0, promise: gate },
      question: "hi",
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();

    // The first delta is applied before the second is released.
    expect(query("message-assistant")?.textContent).toContain("Hel");
    expect(query("message-assistant")?.textContent).not.toContain("Hello");

    release();
    await flush();

    expect(query("message-assistant")?.textContent).toContain("Hello");
    cleanup();
  });

  it("renders assistant markdown as plain text with a clickable source link", async () => {
    fakeConnection({
      deltas: [
        "See **POS Akademik 01** at http://localhost:3050/doc/pos-akademik-01-Olc4Zkpd4D",
      ],
      question: "hi",
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();

    const bubble = query("message-assistant");
    // Emphasis markers are stripped, not shown literally.
    expect(bubble?.textContent).toContain("POS Akademik 01 at");
    expect(bubble?.textContent).not.toContain("**");
    // The bare source URL is rendered as a link.
    const link = bubble?.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toContain(
      "/doc/pos-akademik-01-Olc4Zkpd4D"
    );
    cleanup();
  });

  it("shows model reasoning in a loading disclosure, never as the answer", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    fakeConnection({
      reasoning: "Let me search the KB",
      deltas: ["The answer"],
      gateBeforeText: gate,
      question: "hi",
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();

    const disclosure = query("ai-chat-reasoning");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.textContent).toContain("Loading");
    expect(disclosure?.textContent).toContain("Let me search the KB");

    // The answer span excludes the reasoning: it is a disclosure, not the reply.
    const answerSpan = () =>
      query("message-assistant")?.querySelector('span[role="status"]')
        ?.textContent;
    expect(answerSpan() ?? "").not.toContain("Let me search the KB");

    release();
    await flush();

    expect(answerSpan()).toContain("The answer");
    // The disclosure is live-only: it is gone once the turn completes.
    expect(query("ai-chat-reasoning")).toBeNull();
    cleanup();
  });

  it("renders a completed tool call with its name, input, and output", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    fakeConnection({
      deltas: ["Found the refund policy"],
      toolCall: {
        id: "call-1",
        name: "search_workspace",
        input: { query: "refund policy" },
        output: {
          total: 1,
          results: [
            {
              documentId: "doc-1",
              title: "Refund policy",
              url: "http://localhost:3050/doc/refund-policy-abc1234567",
            },
          ],
        },
      },
      gateBeforeFinish: gate,
      question: "what is our refund policy?",
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("what is our refund policy?");
    await submit();

    // While the stream is held open the tool call and the answer are both
    // visible. The card shows the tool name, its input and its output.
    expect(query("ai-chat-tool-call")).not.toBeNull();
    expect(query("ai-chat-tool-name")?.textContent).toBe("search_workspace");
    expect(query("ai-chat-tool-input")?.textContent).toContain("refund policy");
    expect(query("ai-chat-tool-output")?.textContent).toContain("Refund policy");
    expect(query("ai-chat-tool-pending")).toBeNull();

    release();
    await flush();
    cleanup();
  });

  it("renders a pending tool call with a running state and no output", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    fakeConnection({
      deltas: ["Here is the answer"],
      toolCall: {
        id: "call-2",
        name: "search_workspace",
        input: { query: "pricing" },
        gateBeforeResult: gate,
      },
      question: "what are the prices?",
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("what are the prices?");
    await submit();

    // The tool call ran but the result has not arrived yet.
    expect(query("ai-chat-tool-call")).not.toBeNull();
    expect(query("ai-chat-tool-name")?.textContent).toBe("search_workspace");
    expect(query("ai-chat-tool-input")?.textContent).toContain("pricing");
    expect(query("ai-chat-tool-output")).toBeNull();
    expect(query("ai-chat-tool-pending")?.textContent).toContain(
      "Waiting for result"
    );

    release();
    await flush();
    cleanup();
  });

  it("ignores an unknown part type without crashing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    fakeConnection({
      deltas: [],
      skipText: true,
      snapshot: [
        {
          id: "snap-1",
          role: "assistant",
          parts: [
            { type: "mystery-part", content: "SHOULD-NOT-RENDER" },
            { type: "text", content: "Known answer" },
          ],
        },
      ],
      gateBeforeFinish: gate,
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("ignored");
    await submit();

    // The unknown part is silently dropped; only the text part renders.
    expect(query("message-assistant")?.textContent).toContain("Known answer");
    expect(document.body.textContent).not.toContain("SHOULD-NOT-RENDER");

    release();
    await flush();
    cleanup();
  });

  it("toggles the panel into fullscreen and back", async () => {
    const { query, click, cleanup } = renderPanel(rootStore);
    const layout = () =>
      query("sidebar-layout")?.getAttribute("data-fullscreen");

    expect(layout()).toBe("false");

    await click(query("ai-chat-fullscreen"));
    expect(layout()).toBe("true");

    await click(query("ai-chat-fullscreen"));
    expect(layout()).toBe("false");
    cleanup();
  });

  it("shows a loading spinner while the response streams, then clears it", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    fakeConnection({
      deltas: ["", "done"],
      gateAfter: { index: 0, promise: gate },
      question: "hi",
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();

    // Before the first token arrives the assistant bubble is empty, so the
    // spinner is the only thing the panel can show for that turn.
    expect(query("ai-chat-spinner")).not.toBeNull();

    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(query("ai-chat-spinner")).toBeNull();
    expect(query("message-assistant")?.textContent).toContain("done");
    cleanup();
  });

  it("aborts the in-flight stream when Stop is pressed and shows no error", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runs = fakeConnection((run) => {
      // Release the blocked frame as soon as the client aborts, so the fake
      // connection settles the way a cancelled request does.
      run.signal?.addEventListener("abort", () => release());
      return {
        deltas: ["Hel", "lo"],
        gateAfter: { index: 0, promise: gate },
      };
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();

    expect(runs[0].signal?.aborted).toBe(false);
    expect(query("message-assistant")?.textContent).toContain("Hel");

    const stop = query("ai-chat-stop") as HTMLButtonElement;
    expect(stop).not.toBeNull();
    await act(async () => {
      stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(runs[0].signal?.aborted).toBe(true);
    expect(query("ai-chat-error")).toBeNull();
    expect(query("ai-chat-spinner")).toBeNull();
    // The partial answer stays visible; the turn is simply over.
    expect(query("message-assistant")?.textContent).toContain("Hel");
    cleanup();
  });

  it("renders a visible error notice when the stream throws AiChatError", async () => {
    fakeConnection({
      deltas: [],
      error: new AiChatError("Too many requests", "http", 429),
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();

    const notice = query("ai-chat-error");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Too many requests");
    cleanup();
  });

  it("shows the workspace-disabled message for a 404", async () => {
    fakeConnection({
      deltas: [],
      error: new AiChatError("Resource not found", "http", 404),
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();

    expect(query("ai-chat-error")?.textContent).toContain(
      "AI chat is not enabled for this workspace"
    );
    cleanup();
  });

  it("renders a grounding refusal inline as an assistant turn, not an error", async () => {
    const refusal =
      "This assistant only answers from this workspace’s knowledge base";
    fakeConnection({ deltas: [refusal], question: "hi", kind: "refusal" });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();

    expect(query("message-user")?.textContent).toBe("hi");
    expect(query("message-assistant")?.textContent).toContain(refusal);
    expect(query("ai-chat-error")).toBeNull();
    // A refusal completed normally, so it carries no turn marker at all.
    // `error` here rendered a danger "Failed" badge under the refusal text,
    // which is what made the boundary read as a failure.
    expect(query("message-status-error")).toBeNull();
    expect(query("message-status-completed")).toBeNull();
    cleanup();
  });

  it("shows a retry-later notice for a busy response header", async () => {
    fakeConnection({ deltas: [], kind: "busy" });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();
    await flush();

    expect(query("ai-chat-error")?.textContent).toContain(
      "Another AI chat response is still in progress"
    );
    cleanup();
  });

  it("shows the session-expired message for a 403", async () => {
    fakeConnection({
      deltas: [],
      error: new AiChatError("CSRF token invalid", "http", 403),
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();

    expect(query("ai-chat-error")?.textContent).toContain(
      "Your session has expired, refresh the page to continue"
    );
    cleanup();
  });

  it("restores an unsent draft after the panel is unmounted and remounted", async () => {
    mockEndpoints([]);
    const rootStore = new RootStore();

    let panel = renderPanel(rootStore);
    panel.typeMessage("half-typed question");
    // The draft writer debounces; commit what the keystrokes queued rather
    // than sleeping past the debounce window.
    flushDrafts();
    panel.cleanup();

    panel = renderPanel(rootStore);
    expect(panel.inputValue()).toBe("half-typed question");
    panel.cleanup();
  });

  it("restores the active conversation when the panel is closed and reopened", async () => {
    mockEndpoints([
      {
        id: "session-a",
        title: "Alpha conversation",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      },
    ]);
    const rootStore = new RootStore();
    rootStore.aiChatSessions.add({
      id: "session-a",
      title: "Alpha conversation",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    } as never);
    // Inserted newest-first on purpose: the transcript must render in seq
    // order, not in store-insertion order.
    seedMessage(rootStore, "session-a", {
      id: "m-a2",
      seq: 2,
      role: "assistant",
      content: "answer one",
    });
    seedMessage(rootStore, "session-a", {
      id: "m-a1",
      seq: 1,
      role: "user",
      content: "question one",
    });

    // First open: the panel starts on a new conversation, so the session is
    // picked explicitly.
    let panel = renderPanel(rootStore);
    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-a"));
    expect(panel.transcripts()).toEqual(["question one", "answer one"]);
    panel.cleanup();

    // Reopen. No dropdown interaction of any kind – closing the panel is an
    // unmount, and the user must come back to the conversation they were
    // reading without re-picking it from the list.
    panel = renderPanel(rootStore);
    expect(panel.transcripts()).toEqual(["question one", "answer one"]);
    panel.cleanup();

    // A second close/reopen cycle must converge on the same transcript, not
    // accumulate duplicates of the messages.
    panel = renderPanel(rootStore);
    expect(panel.transcripts()).toEqual(["question one", "answer one"]);
    panel.cleanup();
  });

  it("leaves the panel on an empty conversation after an explicit New chat", async () => {
    mockEndpoints([
      {
        id: "session-a",
        title: "Alpha conversation",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      },
    ]);
    const rootStore = new RootStore();
    rootStore.aiChatSessions.add({
      id: "session-a",
      title: "Alpha conversation",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    } as never);
    seedMessage(rootStore, "session-a", {
      id: "m-a1",
      seq: 1,
      role: "user",
      content: "question one",
    });

    const panel = renderPanel(rootStore);
    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-a"));
    expect(panel.transcripts()).toEqual(["question one"]);

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-new"));
    expect(panel.transcripts()).toEqual([]);

    panel.cleanup();
  });

  it("restores both turns of a stored conversation from the messages endpoint", async () => {
    const post = vi.mocked(client.post);
    post.mockImplementation((async (path: string) => {
      if (path === "/ai.sessions.list") {
        return {
          data: {
            sessions: [
              {
                id: "session-a",
                title: "Alpha conversation",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-02T00:00:00.000Z",
              },
            ],
          },
        };
      }
      if (path === "/ai.messages.list") {
        return {
          data: {
            messages: [
              {
                id: "m2",
                seq: 2,
                role: "assistant",
                content: "answer one",
                status: "completed",
                runId: "run-1",
                createdAt: "2024-01-02T00:00:00.000Z",
              },
              {
                id: "m1",
                seq: 1,
                role: "user",
                content: "question one",
                status: "completed",
                runId: "run-1",
                createdAt: "2024-01-01T00:00:00.000Z",
              },
            ],
            truncated: false,
          },
        };
      }
      return defaultPost(path);
    }) as never);

    const rootStore = new RootStore();
    rootStore.aiChatSessions.add({
      id: "session-a",
      title: "Alpha conversation",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    } as never);
    rootStore.aiChatSessions.setSelectedSessionId("session-a");

    const panel = renderPanel(rootStore);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Read back through `ai.messages.list`, the path a reopen actually takes:
    // the assistant turn must render alongside the question.
    expect(vi.mocked(client.post)).toHaveBeenCalledWith("/ai.messages.list", {
      sessionId: "session-a",
    });
    expect(panel.transcripts()).toEqual(["question one", "answer one"]);
    panel.cleanup();
  });

  it("shows each session's own transcript when switching between sessions", async () => {
    mockEndpoints([
      {
        id: "session-a",
        title: "Alpha conversation",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      },
      {
        id: "session-b",
        title: "Beta conversation",
        createdAt: "2024-01-03T00:00:00.000Z",
        updatedAt: "2024-01-04T00:00:00.000Z",
      },
    ]);
    const rootStore = new RootStore();
    rootStore.aiChatSessions.add({
      id: "session-a",
      title: "Alpha conversation",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    } as never);
    rootStore.aiChatSessions.add({
      id: "session-b",
      title: "Beta conversation",
      createdAt: "2024-01-03T00:00:00.000Z",
      updatedAt: "2024-01-04T00:00:00.000Z",
    } as never);
    seedMessage(rootStore, "session-a", {
      id: "m-a",
      seq: 1,
      role: "user",
      content: "Alpha question",
    });
    seedMessage(rootStore, "session-b", {
      id: "m-b",
      seq: 1,
      role: "user",
      content: "Beta question",
    });
    seedMessage(rootStore, "session-b", {
      id: "m-b2",
      seq: 2,
      role: "assistant",
      content: "Beta answer",
    });

    const panel = renderPanel(rootStore);
    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-b"));

    // Exactly the messages of session B, nothing from A.
    expect(panel.transcripts()).toEqual(["Beta question", "Beta answer"]);

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-a"));

    // Switching back shows exactly the messages of session A.
    expect(panel.transcripts()).toEqual(["Alpha question"]);

    panel.cleanup();
  });

  it("creates a session before the first send and addresses it by thread id", async () => {
    const runs = fakeConnection({
      deltas: ["ok"],
      question: "what is our refund policy?",
    });

    const panel = renderPanel(new RootStore());
    panel.typeMessage("what is our refund policy?");
    await panel.submit();

    // A conversation is created before the turn is sent, so the server has a
    // session to write both rows into – without one the turn is stateless and
    // the transcript dies with the panel.
    expect(vi.mocked(client.post)).toHaveBeenCalledWith(
      "/ai.sessions.create",
      {}
    );
    expect(runs).toHaveLength(1);
    // The created session is the AG-UI thread id, and the wire carries only the
    // question – the server rebuilds the window from committed rows.
    expect(runs[0].threadId).toBe("session-new");
    expect(runs[0].messages).toHaveLength(1);
    expect(runs[0].messages[0].role).toBe("user");
    expect(messageText(runs[0].messages[0])).toBe(
      "what is our refund policy?"
    );
    panel.cleanup();
  });

  it("addresses a stored conversation by its thread id without owning its history", async () => {
    const session = {
      id: "session-a",
      title: "Alpha conversation",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };
    mockEndpoints([session]);
    const rootStore = new RootStore();
    rootStore.aiChatSessions.add(session as never);
    seedMessage(rootStore, "session-a", {
      id: "m-a1",
      seq: 1,
      role: "user",
      content: "question one",
    });
    seedMessage(rootStore, "session-a", {
      id: "m-a2",
      seq: 2,
      role: "assistant",
      content: "answer one",
    });

    const runs = fakeConnection({
      deltas: ["ok"],
      question: "and the deadline?",
    });

    const panel = renderPanel(rootStore);
    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-a"));
    panel.typeMessage("and the deadline?");
    await panel.submit();

    expect(runs).toHaveLength(1);
    expect(runs[0].threadId).toBe("session-a");
    // The client is a frame source only: it sends the new turn, never the
    // committed transcript it does not own.
    expect(runs[0].messages).toHaveLength(1);
    expect(messageText(runs[0].messages[0])).toBe("and the deadline?");
    panel.cleanup();
  });

  it("surfaces the server's message when it rejects the request", async () => {
    fakeConnection({
      deltas: [],
      error: new AiChatError(
        "messages: Too small: expected array to have >=1 items",
        "http",
        400
      ),
    });

    const panel = renderPanel(new RootStore());
    panel.typeMessage("hi");
    await panel.submit();

    const notice = panel.query("ai-chat-error")?.textContent ?? "";
    expect(notice).toContain(
      "messages: Too small: expected array to have >=1 items"
    );
    expect(notice).not.toContain("The AI chat request failed, try again?");
    panel.cleanup();
  });

  it("keeps the transcript pinned to the latest turn", async () => {
    fakeConnection({ deltas: ["ok"], question: "hi" });

    const panel = renderPanel(rootStore);
    const transcript = panel.query("ai-chat-transcript") as HTMLElement;
    Object.defineProperty(transcript, "scrollHeight", {
      configurable: true,
      value: 480,
    });

    panel.typeMessage("hi");
    await panel.submit();

    expect(transcript.scrollTop).toBe(480);
    panel.cleanup();
  });

  it("aborts the in-flight stream when the panel unmounts", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runs = fakeConnection((run) => {
      run.signal?.addEventListener("abort", () => release());
      return {
        deltas: ["Hel", "lo"],
        gateAfter: { index: 0, promise: gate },
      };
    });

    const panel = renderPanel(rootStore);
    panel.typeMessage("hi");
    await panel.submit();

    expect(runs[0].signal?.aborted).toBe(false);

    panel.cleanup();

    expect(runs[0].signal?.aborted).toBe(true);
  });

  it("clears the pending turn and aborts when New chat is chosen mid-stream", async () => {
    const session = {
      id: "session-a",
      title: "Alpha conversation",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };
    mockEndpoints([session]);
    const rootStore = new RootStore();
    rootStore.aiChatSessions.add(session as never);
    rootStore.aiChatSessions.setSelectedSessionId("session-a");

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs = fakeConnection((run) => {
      run.signal?.addEventListener("abort", () => release());
      return {
        deltas: ["partial", " answer"],
        gateAfter: { index: 0, promise: gate },
      };
    });

    const panel = renderPanel(rootStore);
    panel.typeMessage("hi");
    await panel.submit();

    expect(panel.transcripts()).toEqual(["hi", "partial"]);

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-new"));

    expect(panel.transcripts()).toEqual([]);
    expect(runs[0].signal?.aborted).toBe(true);
    panel.cleanup();
  });

  it("clears the pending turn and aborts when another session is selected mid-stream", async () => {
    const sessionA = {
      id: "session-a",
      title: "Alpha conversation",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };
    const sessionB = {
      id: "session-b",
      title: "Beta conversation",
      createdAt: "2024-01-03T00:00:00.000Z",
      updatedAt: "2024-01-04T00:00:00.000Z",
    };
    mockEndpoints([sessionA, sessionB]);
    const rootStore = new RootStore();
    rootStore.aiChatSessions.add(sessionA as never);
    rootStore.aiChatSessions.add(sessionB as never);
    rootStore.aiChatSessions.setSelectedSessionId("session-a");
    seedMessage(rootStore, "session-b", {
      id: "m-b1",
      seq: 1,
      role: "user",
      content: "Beta question",
    });

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runs = fakeConnection((run) => {
      run.signal?.addEventListener("abort", () => release());
      return {
        deltas: ["partial", " answer"],
        gateAfter: { index: 0, promise: gate },
      };
    });

    const panel = renderPanel(rootStore);
    panel.typeMessage("hi");
    await panel.submit();

    expect(panel.transcripts()).toEqual(["hi", "partial"]);

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-b"));

    expect(panel.transcripts()).toEqual(["Beta question"]);
    expect(runs[0].signal?.aborted).toBe(true);
    panel.cleanup();
  });
});
