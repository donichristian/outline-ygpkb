import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  AIChatProvider,
  openAIChatPanel,
  useAIChatPanel,
} from "./AIChatContext";
import type * as SidebarContext from "~/components/RightSidebarContext";
import type { AIChatControls } from "./AIChatContext";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The panel is never rendered here – these tests assert on the *element* handed
// to the sidebar, which is the property that decides whether the panel subtree
// is torn down and rebuilt. Stubbing it keeps the module graph to the provider.
vi.mock("./AIChatPanel", () => ({
  default: () => <div data-testid="ai-chat-panel" />,
}));

// The provider only reads the workspace preference off the team.
vi.mock("~/hooks/useCurrentTeam", () => ({
  default: () => ({ getPreference: () => true }),
}));

// `setSidebar` is spied rather than driven through a real RightSidebarProvider:
// a context consumer only re-renders when the value changes, so it cannot
// observe "was setSidebar called again". The setter call log is the only place
// that difference is visible.
const setSidebar = vi.hoisted(() => vi.fn());
vi.mock("~/components/RightSidebarContext", async (importOriginal) => {
  const actual = await importOriginal<typeof SidebarContext>();
  return { ...actual, useSetRightSidebar: () => setSidebar };
});

/**
 * Renders the provider inside a harness that re-renders on demand, exposing the
 * sidebar setter call log and the controls the context published.
 */
function renderProvider() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const controlsSeen: (AIChatControls | null)[] = [];

  function Harness({ tick }: { tick: number }) {
    const controls = useAIChatPanel();
    controlsSeen.push(controls);
    return <span data-testid="tick">{tick}</span>;
  }

  const render = (tick: number) =>
    act(() => {
      root.render(
        <AIChatProvider>
          <Harness tick={tick} />
        </AIChatProvider>
      );
    });

  render(0);

  const cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };

  /** Every element (rather than `null`) ever handed to the sidebar. */
  const sidebarElements = () =>
    setSidebar.mock.calls
      .map((call) => call[0])
      .filter((node): node is React.ReactElement => React.isValidElement(node));

  return {
    render,
    cleanup,
    controlsSeen,
    sidebarElements,
    lastSidebarNode: () => {
      const call = setSidebar.mock.calls.at(-1);
      return call ? call[0] : undefined;
    },
  };
}

describe("AIChatProvider", () => {
  afterEach(() => {
    setSidebar.mockReset();
    document.body.innerHTML = "";
  });

  it("hands the sidebar a stable panel element across re-renders", () => {
    const { render, cleanup, sidebarElements } = renderProvider();

    act(() => openAIChatPanel());
    render(1);
    render(2);
    render(3);

    const elements = sidebarElements();
    expect(elements).toHaveLength(1);

    render(4);
    expect(sidebarElements()[0]).toBe(elements[0]);
    cleanup();
  });

  it("hands the sidebar an element that carries no props", () => {
    const { cleanup, sidebarElements } = renderProvider();

    act(() => openAIChatPanel());

    // Threading per-keystroke state (draft, session id, streaming flag) through
    // this element is what remounts the panel and silently drops the transcript.
    expect(Object.keys(sidebarElements()[0].props as object)).toEqual([]);
    cleanup();
  });

  it("reuses the same element object after a close and reopen", () => {
    const { cleanup, controlsSeen, sidebarElements, lastSidebarNode } =
      renderProvider();

    act(() => openAIChatPanel());
    const first = sidebarElements()[0];

    act(() => controlsSeen.at(-1)!.close());
    expect(lastSidebarNode()).toBeNull();

    act(() => openAIChatPanel());

    // Two open cycles, two setSidebar calls – but one element instance. A fresh
    // element per cycle would tear the panel subtree down and rebuild it.
    const elements = sidebarElements();
    expect(elements).toHaveLength(2);
    expect(new Set(elements).size).toBe(1);
    expect(elements[1]).toBe(first);
    cleanup();
  });

  it("clears the sidebar with null when the panel closes", () => {
    const { cleanup, controlsSeen, lastSidebarNode } = renderProvider();

    act(() => openAIChatPanel());
    expect(React.isValidElement(lastSidebarNode())).toBe(true);

    act(() => controlsSeen.at(-1)!.close());
    expect(lastSidebarNode()).toBeNull();
    cleanup();
  });

  it("keeps open and close referentially stable across open and close", () => {
    const { cleanup, controlsSeen } = renderProvider();

    const initial = controlsSeen.at(-1)!;
    expect(initial.isOpen).toBe(false);

    act(() => openAIChatPanel());
    const opened = controlsSeen.at(-1)!;
    expect(opened.isOpen).toBe(true);
    expect(opened.open).toBe(initial.open);
    expect(opened.close).toBe(initial.close);

    act(() => opened.close());
    expect(controlsSeen.at(-1)!.isOpen).toBe(false);
    expect(controlsSeen.at(-1)!.open).toBe(initial.open);
    cleanup();
  });
});
