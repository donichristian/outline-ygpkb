import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import { buildLightTheme } from "@shared/styles/theme";
import { AiChatError } from "~/utils/aiChat";
import AIChatPanel from "./AIChatPanel";
import type * as AiChatModule from "~/utils/aiChat";

// The panel composes SidebarLayout, which reaches into stores, the Aside
// container and framer-motion. None of that is under test here – the panel's
// transcript, composer and abort behaviour are – so it is stubbed to a plain
// form/container passthrough.
vi.mock("~/scenes/Document/components/SidebarLayout", () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="sidebar-layout">{children}</div>
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

/**
 * Renders the panel into a fresh container and returns helpers for driving and
 * inspecting it. The container and React root are torn down by `cleanup`.
 */
function renderPanel() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const onClose = vi.fn();

  act(() => {
    root.render(
      <ThemeProvider theme={theme}>
        <AIChatPanel onClose={onClose} />
      </ThemeProvider>
    );
  });

  const cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };

  const query = (testid: string) =>
    container.querySelector(`[data-testid="${testid}"]`);

  const typeMessage = (text: string) => {
    const input = query("ai-chat-input") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
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
    });
  };

  return { container, query, typeMessage, submit, onClose, cleanup };
}

describe("AIChatPanel", () => {
  afterEach(() => {
    streamAiChat.mockReset();
    document.body.innerHTML = "";
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

    const { query, typeMessage, submit, cleanup } = renderPanel();
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

    const { query, typeMessage, submit, cleanup } = renderPanel();
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

    const { query, typeMessage, submit, cleanup } = renderPanel();
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

    const { query, typeMessage, submit, cleanup } = renderPanel();
    typeMessage("hi");
    await submit();

    expect(query("ai-chat-error")?.textContent).toContain(
      "AI chat is not enabled for this workspace"
    );
    cleanup();
  });
});
