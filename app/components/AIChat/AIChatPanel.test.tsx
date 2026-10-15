import "~/stores";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MobXProviderContext } from "mobx-react";
import { ThemeProvider } from "styled-components";
import { buildLightTheme } from "@shared/styles/theme";
import RootStore from "~/stores/RootStore";
import { AiChatError, clearDraft, flushDrafts } from "~/utils/aiChat";
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
  }: {
    children?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div data-testid="sidebar-layout">
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom does not implement ResizeObserver, which Scrollable observes.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  ResizeObserverStub;

// The streaming transport is what the panel consumes; each test installs its
// own generator so the incremental, abort and error paths can be driven
// deterministically.
const streamAiChat = vi.hoisted(() => vi.fn());
vi.mock("~/utils/aiChat", async (importOriginal) => {
  const actual = await importOriginal<typeof AiChatModule>();
  return { ...actual, streamAiChat };
});

const theme = buildLightTheme({});

// The default ApiClient mock answers every path with a benign auth envelope.
// The two AI endpoints the panel reads need a proper shape instead, so the
// helper answers them; the shared afterEach restores the default afterwards.
type SessionSeed = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

// The panel's mount effect re-reads the session list through
// aiChatSessions.list(), which replaces the local set with the server's
// answer. Without this the call wipes out every session added directly to
// the store, so the mock must agree with what was seeded.
function mockEndpoints(sessions: SessionSeed[]) {
  const post = vi.mocked(client.post);
  post.mockImplementation((async (path: string) => {
    if (path === "/ai.sessions.list") {
      return { data: { sessions } };
    }
    if (path === "/ai.messages.list") {
      return { data: { messages: [], truncated: false } };
    }
    return { data: { user: {}, team: {}, groups: [], groupUsers: [] } };
  }) as never);
}

function seedMessage(
  store: RootStore,
  sessionId: string,
  message: Record<string, unknown>
) {
  store.aiChatMessages.add(
    {
      sessionId,
      status: "completed",
      createdAt: "2024-01-02T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
      ...message,
    } as never
  );
}

// The wire body is what regressed, so the tests below drive the REAL transport
// against a stubbed `fetch` instead of the module mock: what they assert is the
// JSON the panel actually puts on the wire, not what it hands to a stub.
async function useRealTransport() {
  const actual = await vi.importActual<typeof AiChatModule>("~/utils/aiChat");
  streamAiChat.mockImplementation(actual.streamAiChat);
}

/** A 200 response whose body is the given SSE frames, for running a turn to completion. */
function sseResponse(frames: string) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });

  return { ok: true, status: 200, body } as unknown as Response;
}

/** The API's rejection envelope, which is what a 400 on `/api/ai.chat` returns. */
function validationErrorResponse(message: string) {
  return {
    ok: false,
    status: 400,
    json: async () => ({
      ok: false,
      error: "validation_error",
      status: 400,
      message,
    }),
  } as unknown as Response;
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
          <AIChatPanel onClose={onClose} />
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

  const inputValue = () =>
    (query("ai-chat-input") as HTMLInputElement).value;

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
  afterEach(() => {
    streamAiChat.mockReset();
    document.body.innerHTML = "";
    // The wire-body tests swap in a real transport and a stubbed `fetch`; the
    // global is restored here so no test can see the previous one's stub.
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    // Drafts live in module-level state and `localStorage`, which survive both
    // the DOM reset above and a panel's unmount – the very behaviour under
    // test. `clearDraft` drops the queued write and the stored key together,
    // so the next test does not inherit a stale composer.
    clearDraft();
    // The session/message seeding helpers point the global ApiClient mock at
    // the AI endpoints, so restore its default implementation.
    vi.mocked(client.post).mockImplementation(
      () =>
        Promise.resolve({
          data: { user: {}, team: {}, groups: [], groupUsers: [] },
        }) as never
    );
  });

  it("sends the message when Enter is pressed in the prompt", async () => {
    streamAiChat.mockImplementation(async function* () {
      yield { type: "delta", text: "ok" };
    });

    const { query, typeMessage, pressEnter, cleanup } =
      renderPanel(rootStore);
    typeMessage("hi");
    await pressEnter();

    expect(streamAiChat).toHaveBeenCalledTimes(1);
    expect(query("message-user")?.textContent).toBe("hi");
    cleanup();
  });

  it("appends assistant text incrementally as deltas arrive", async () => {
    // A generator whose two frames are released between assertions, so the
    // intermediate transcript state can be observed.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    streamAiChat.mockImplementation(async function* () {
      yield { type: "delta", text: "Hel" };
      await gate;
      yield { type: "delta", text: "lo" };
    });

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();

    // The first delta is applied before the second is released.
    expect(query("message-assistant")?.textContent).toContain("Hel");
    expect(query("message-assistant")?.textContent).not.toContain("Hello");

    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(query("message-assistant")?.textContent).toContain("Hello");
    cleanup();
  });

  it("aborts the in-flight stream when Stop is pressed", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    streamAiChat.mockImplementation(
      async function* (
        _messages: unknown,
        options: { signal?: AbortSignal } = {}
      ) {
        capturedSignal = options.signal;
        resolveStarted();
        yield { type: "delta", text: "" };
        // Never yield content – the test asserts the abort propagates to the signal.
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        });
      }
    );

    const { query, typeMessage, submit, cleanup } = renderPanel(rootStore);
    typeMessage("hi");
    await submit();
    await act(async () => {
      await started;
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    const stop = query("ai-chat-stop") as HTMLButtonElement;
    expect(stop).not.toBeNull();
    await act(async () => {
      stop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(capturedSignal?.aborted).toBe(true);
    cleanup();
  });

  it("renders a visible error notice when the stream throws AiChatError", async () => {
    streamAiChat.mockImplementation(async function* () {
      throw new AiChatError(
        "Too many requests",
        "http",
        429
      );
      // eslint-disable-next-line no-unreachable
      yield { type: "delta", text: "" };
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
    streamAiChat.mockImplementation(async function* () {
      throw new AiChatError("Resource not found", "http", 404);
      // eslint-disable-next-line no-unreachable
      yield { type: "delta", text: "" };
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
    streamAiChat.mockImplementation(async function* () {
      throw new AiChatError(refusal, "refusal");
      // eslint-disable-next-line no-unreachable
      yield { type: "delta", text: "" };
    });

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

  it("shows the session-expired message for a 403", async () => {
    streamAiChat.mockImplementation(async function* () {
      throw new AiChatError("CSRF token invalid", "http", 403);
      // eslint-disable-next-line no-unreachable
      yield { type: "delta", text: "" };
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

  it("sends the typed question as the last message when the conversation is new", async () => {
    await useRealTransport();

    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return sseResponse(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
        );
      })
    );

    // No session is selected, so this is the very first turn of a brand-new
    // conversation – the one that went out as `{ messages: [] }`.
    const panel = renderPanel(new RootStore());
    panel.typeMessage("what is our refund policy?");
    await panel.submit();

    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: "what is our refund policy?",
    });
    panel.cleanup();
  });

  it("sends only the sessionId for a turn inside a stored conversation", async () => {
    await useRealTransport();

    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        // A session-backed turn is only whole once the server says so.
        return sseResponse(
          'event: complete\ndata: {"runId":"run-1","finishReason":"stop"}\n\n'
        );
      })
    );

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

    const panel = renderPanel(rootStore);
    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-a"));
    panel.typeMessage("and the deadline?");
    await panel.submit();

    expect(bodies).toHaveLength(1);
    // The server rebuilds the prompt window from committed rows, so the body
    // carries the session alone – no `messages` key at all.
    expect(JSON.parse(bodies[0])).toEqual({ sessionId: "session-a" });
    panel.cleanup();
  });

  it("surfaces the server's message when it rejects the request", async () => {
    await useRealTransport();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        validationErrorResponse(
          "messages: Too small: expected array to have >=1 items"
        )
      )
    );

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
});
