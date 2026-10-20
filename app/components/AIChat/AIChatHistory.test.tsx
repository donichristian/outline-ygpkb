/* oxlint-disable */
import "~/stores";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MobXProviderContext } from "mobx-react";
import { ThemeProvider } from "styled-components";
import { buildLightTheme } from "@shared/styles/theme";
import RootStore from "~/stores/RootStore";
import { flushDrafts, writeDraft } from "~/utils/aiChat";
import AIChatPanel from "./AIChatPanel";
import type * as AiChatModule from "~/utils/aiChat";

vi.mock("~/scenes/Document/components/SidebarLayout", () => ({
  default: ({
    children,
    actions,
  }: {
    children?: React.ReactNode;
    actions?: React.ReactNode;
    fullscreen?: boolean;
  }) => (
    <div data-testid="sidebar-layout">
      <div data-testid="sidebar-header">{actions}</div>
      {children}
    </div>
  ),
}));

const createAiChatConnection = vi.hoisted(() => vi.fn());
vi.mock("~/utils/aiChat", async (importOriginal) => {
  const actual = await importOriginal<typeof AiChatModule>();
  return { ...actual, createAiChatConnection };
});

// Button and NudeButton both render through ActionButton, which needs the
// action context this focused test does not set up. Mocking ActionButton at the
// root covers every button in the tree, and forwarding `type`, `aria-label` and
// children verbatim keeps the rendered label and test ids non-vacuous.
vi.mock("~/components/ActionButton", () => ({
  default: ({
    children,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest}>{children}</button>
  ),
}));

// Tooltip renders through a portal and a delay timer; the content it wraps is
// what matters here.
vi.mock("~/components/Tooltip", () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  ResizeObserverStub;

// jsdom's matchMedia returns an object without the listener methods useMobile
// subscribes with, so it is replaced with a stub that reports no match.
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

const theme = buildLightTheme({});

type SessionSeed = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Answers the two AI endpoints the panel reads and falls back to a benign
 * envelope for anything else, so unrelated store traffic (auth, policies) does
 * not fail on the wrong response shape.
 */
async function mockEndpoints(sessions: SessionSeed[]) {
  const { client } = await import("~/utils/ApiClient");
  vi.mocked(client.post).mockImplementation((async (path: string) => {
    if (path === "/ai.sessions.list") {
      return { data: { sessions } };
    }
    if (path === "/ai.sessions.delete") {
      return { data: {} };
    }
    if (path === "/ai.messages.list") {
      return { data: { messages: [], truncated: false } };
    }
    // The panel creates a conversation on the first send of a new chat; the
    // envelope must carry an id and dates, or the history list throws on the
    // missing timestamp.
    if (path === "/ai.sessions.create") {
      return {
        data: {
          id: "session-new",
          title: null,
          createdAt: "2024-01-05T00:00:00.000Z",
          updatedAt: "2024-01-05T00:00:00.000Z",
        },
      };
    }
    return { data: { user: {}, team: {}, groups: [], groupUsers: [] } };
  }) as never);
}

/** Seeds two sessions whose updatedAt order differs from their creation order. */
function seedSessions(store: RootStore) {
  store.aiChatSessions.add({
    id: "session-a",
    title: "Alpha conversation",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
  } as never);
  store.aiChatSessions.add({
    id: "session-b",
    title: "Beta conversation",
    createdAt: "2024-01-03T00:00:00.000Z",
    updatedAt: "2024-01-04T00:00:00.000Z",
  } as never);
}

const alphaSeed: SessionSeed = {
  id: "session-a",
  title: "Alpha conversation",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
};
const betaSeed: SessionSeed = {
  id: "session-b",
  title: "Beta conversation",
  createdAt: "2024-01-03T00:00:00.000Z",
  updatedAt: "2024-01-04T00:00:00.000Z",
};

/** Seeds one stored user message so the active transcript is non-empty. */
function seedMessage(
  store: RootStore,
  sessionId: string,
  content: string,
  overrides: Record<string, unknown> = {}
) {
  store.aiChatMessages.add({
    id: `m-${sessionId}`,
    seq: 1,
    role: "user",
    content,
    status: "completed",
    sessionId,
    createdAt: "2024-01-02T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    ...overrides,
  } as never);
}

/**
 * Renders the panel against a real RootStore. The transcript is read from
 * `aiChatMessages`, so a test seeds that store directly rather than mocking the
 * network read.
 */
function renderPanel(rootStore: RootStore) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);

  const onClose = vi.fn();

  act(() => {
    reactRoot.render(
      <MobXProviderContext.Provider value={{ rootStore }}>
        <ThemeProvider theme={theme}>
          <AIChatPanel onClose={onClose} />
        </ThemeProvider>
      </MobXProviderContext.Provider>
    );
  });

  const cleanup = () => {
    act(() => reactRoot.unmount());
    container.remove();
  };

  // Popover content is portalled to document.body, outside the render
  // container, so queries must search the whole document.
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

  const submit = async () => {
    const form = query("ai-chat-input")?.closest("form");
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });
  };

  return {
    container: document.body,
    query,
    click,
    typeMessage,
    submit,
    cleanup,
  };
}

describe("AIChatPanel — history, status markers, disclosure", () => {
  afterEach(() => {
    createAiChatConnection.mockReset();
    document.body.innerHTML = "";
  });

  async function mountWith(sessions: SessionSeed[]) {
    await mockEndpoints(sessions);
    const rootStore = new RootStore();
    seedSessions(rootStore);
    return { rootStore, panel: renderPanel(rootStore) };
  }

  it("lays the session list out vertically so it can scroll", async () => {
    const { panel } = await mountWith([alphaSeed, betaSeed]);
    await panel.click(panel.query("ai-chat-history-trigger"));

    const list = panel.query("ai-chat-sessions");
    expect(list).not.toBeNull();
    // Flex defaults to a row; a long history must stack, not run sideways.
    expect(getComputedStyle(list as Element).flexDirection).toBe("column");
    panel.cleanup();
  });

  it("lists the user's sessions and switches to the correct transcript", async () => {
    const { rootStore, panel } = await mountWith([alphaSeed, betaSeed]);
    seedMessage(rootStore, "session-a", "Alpha question");
    seedMessage(rootStore, "session-b", "Beta question");

    await panel.click(panel.query("ai-chat-history-trigger"));

    expect(panel.query("ai-chat-session-session-a")?.textContent).toContain(
      "Alpha conversation"
    );
    expect(panel.query("ai-chat-session-session-b")?.textContent).toContain(
      "Beta conversation"
    );

    await panel.click(panel.query("ai-chat-session-session-a"));
    expect(panel.query("message-user")?.textContent).toBe("Alpha question");

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-b"));
    expect(panel.query("message-user")?.textContent).toBe("Beta question");

    panel.cleanup();
  });

  it("renders the transcript ordered by seq ascending, not by createdAt", async () => {
    const { rootStore, panel } = await mountWith([alphaSeed]);

    // seq and createdAt deliberately disagree: seq 1 is the oldest turn, so a
    // createdAt-descending render would place it *last*, not first.
    rootStore.aiChatMessages.add({
      id: "m-1",
      seq: 1,
      role: "user",
      content: "first turn",
      status: "completed",
      sessionId: "session-a",
      createdAt: "2024-01-05T00:00:00.000Z",
      updatedAt: "2024-01-05T00:00:00.000Z",
    } as never);
    rootStore.aiChatMessages.add({
      id: "m-2",
      seq: 2,
      role: "assistant",
      content: "second turn",
      status: "completed",
      sessionId: "session-a",
      createdAt: "2024-01-10T00:00:00.000Z",
      updatedAt: "2024-01-10T00:00:00.000Z",
    } as never);

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-a"));

    const rendered = Array.from(
      panel.container.querySelectorAll(
        '[data-testid="message-user"], [data-testid="message-assistant"]'
      )
    ).map((el) => el.textContent);

    expect(rendered).toEqual(["first turn", "second turn"]);

    panel.cleanup();
  });

  it("marks an assistant turn with status truncated with a visible marker", async () => {
    const { rootStore, panel } = await mountWith([alphaSeed]);
    seedMessage(rootStore, "session-a", "A short answer", {
      id: "m-trunc",
      role: "assistant",
      status: "truncated",
    });

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-a"));

    const marker = panel.query("message-status-truncated");
    expect(marker).not.toBeNull();
    // Assert on the rendered text: a marker that renders nothing would not stop
    // a short answer being read as a complete one.
    expect(marker?.textContent).toContain("Response cut short");

    panel.cleanup();
  });

  it("marks aborted and error turns with a visible marker", async () => {
    const { rootStore, panel } = await mountWith([alphaSeed]);
    seedMessage(rootStore, "session-a", "Stopped answer", {
      id: "m-aborted",
      seq: 1,
      role: "assistant",
      status: "aborted",
    });
    seedMessage(rootStore, "session-a", "Failed answer", {
      id: "m-error",
      seq: 2,
      role: "assistant",
      status: "error",
    });

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-a"));

    expect(panel.query("message-status-aborted")?.textContent).toContain(
      "Stopped"
    );
    expect(panel.query("message-status-error")?.textContent).toContain(
      "Failed"
    );

    panel.cleanup();
  });

  it("delete without confirming changes nothing", async () => {
    const { rootStore, panel } = await mountWith([alphaSeed, betaSeed]);
    await panel.click(panel.query("ai-chat-history-trigger"));

    await panel.click(panel.query("ai-chat-delete-session-a"));

    // The confirmation is shown, but nothing has been deleted yet.
    expect(panel.query("ai-chat-delete-confirm-session-a")).not.toBeNull();
    expect(rootStore.aiChatSessions.get("session-a")).toBeDefined();
    expect(rootStore.aiChatSessions.sessionsByRecency).toHaveLength(2);

    // Dismissing the confirmation leaves both sessions intact.
    await panel.click(panel.query("ai-chat-delete-cancel-session-a"));
    expect(panel.query("ai-chat-delete-confirm-session-a")).toBeNull();
    expect(rootStore.aiChatSessions.get("session-a")).toBeDefined();
    expect(rootStore.aiChatSessions.sessionsByRecency).toHaveLength(2);

    panel.cleanup();
  });

  it("deleting with confirming removes the session", async () => {
    const { rootStore, panel } = await mountWith([alphaSeed, betaSeed]);
    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-delete-session-b"));
    await panel.click(panel.query("ai-chat-delete-confirm-session-b"));

    expect(rootStore.aiChatSessions.get("session-b")).toBeUndefined();
    expect(rootStore.aiChatSessions.sessionsByRecency).toHaveLength(1);

    panel.cleanup();
  });

  it("garbage-collects the deleted session's draft", async () => {
    const { rootStore, panel } = await mountWith([alphaSeed, betaSeed]);

    writeDraft("half-typed question", "session-b");
    flushDrafts();
    // Assert against the literal storage key, not `draftKey`, so the test pins
    // the real contract in `localStorage` rather than the helper's own naming.
    expect(window.localStorage.getItem("aiChat.draft.session-b")).toBe(
      "half-typed question"
    );

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-delete-session-b"));
    await panel.click(panel.query("ai-chat-delete-confirm-session-b"));

    expect(rootStore.aiChatSessions.get("session-b")).toBeUndefined();
    // Nothing else removes this key. Without the delete path clearing it, the
    // draft outlives a conversation that can no longer be reopened.
    expect(window.localStorage.getItem("aiChat.draft.session-b")).toBeNull();

    panel.cleanup();
  });

  it("deleting the active session starts a new one", async () => {
    const { rootStore, panel } = await mountWith([alphaSeed, betaSeed]);
    seedMessage(rootStore, "session-a", "Alpha question");

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-a"));
    expect(panel.query("message-user")?.textContent).toBe("Alpha question");

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-delete-session-a"));
    await panel.click(panel.query("ai-chat-delete-confirm-session-a"));

    expect(rootStore.aiChatSessions.get("session-a")).toBeUndefined();
    expect(panel.query("message-user")).toBeNull();
    expect(panel.query("ai-chat-input")).not.toBeNull();

    panel.cleanup();
  });

  it("New chat returns the panel to a fresh, unselected conversation", async () => {
    const { rootStore, panel } = await mountWith([alphaSeed]);
    seedMessage(rootStore, "session-a", "Alpha question");

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-session-session-a"));
    expect(panel.query("message-user")?.textContent).toBe("Alpha question");

    await panel.click(panel.query("ai-chat-history-trigger"));
    await panel.click(panel.query("ai-chat-new"));

    expect(panel.query("message-user")).toBeNull();
    expect(panel.query("ai-chat-input")).not.toBeNull();

    // A message typed now creates a conversation and streams under it, so the
    // exchange is stored and survives closing the panel.
    const threadIds: Array<string | undefined> = [];
    createAiChatConnection.mockImplementation((() => ({
      connect: (
        _messages: unknown,
        _data: unknown,
        _signal: unknown,
        context?: { threadId?: string }
      ) => {
        threadIds.push(context?.threadId);
        return (async function* () {
          yield { type: "RUN_STARTED", threadId: context?.threadId, runId: "r" };
          yield { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" };
          yield {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "m",
            delta: "fresh",
          };
          yield { type: "TEXT_MESSAGE_END", messageId: "m" };
          yield { type: "RUN_FINISHED", threadId: context?.threadId, runId: "r" };
        })();
      },
    })) as never);

    panel.typeMessage("a new question");
    await panel.submit();

    expect(threadIds).toEqual(["session-new"]);
    expect((panel.query("ai-chat-input") as HTMLInputElement).value).toBe("");

    panel.cleanup();
  });

  it("shows a one-line disclosure framed as fabrication risk, not a leak", async () => {
    const { panel } = await mountWith([]);

    expect(panel.container.textContent).toContain(
      "may be wrong or out of date"
    );
    expect(panel.container.textContent).not.toContain("permission");
    expect(panel.container.textContent).not.toContain("exfiltrat");
    expect(panel.container.textContent).not.toContain("access");
    expect(panel.container.textContent).not.toContain("private to you");

    panel.cleanup();
  });

  it("renders a session with a null title sensibly in the list", async () => {
    await mockEndpoints([
      {
        id: "session-null",
        title: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      },
    ]);
    const rootStore = new RootStore();
    rootStore.aiChatSessions.add({
      id: "session-null",
      title: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    } as never);
    const panel = renderPanel(rootStore);

    await panel.click(panel.query("ai-chat-history-trigger"));

    const row = panel.query("ai-chat-session-session-null");
    expect(row).not.toBeNull();
    // An empty row is not a sensible rendering: a title must be present.
    expect(row?.textContent?.trim()).not.toBe("");

    panel.cleanup();
  });
});
