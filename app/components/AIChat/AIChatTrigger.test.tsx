import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import { buildLightTheme } from "@shared/styles/theme";
import { depths } from "@shared/styles";
import AIChatTrigger from "./AIChatTrigger";
import type { AIChatControls } from "./AIChatContext";

// Mock the useAIChatPanel hook to return controlled values
const mockUseAIChatPanel = vi.hoisted(() => vi.fn());
vi.mock("./AIChatContext", async (importOriginal) => {
  const actual =
    (await importOriginal()) as unknown as Record<string, unknown>;
  return {
    ...actual,
    useAIChatPanel: mockUseAIChatPanel,
  };
});

// Button renders through ActionButton, which needs the action context and MobX
// store providers this focused test does not set up. The mock only spreads
// known DOM attributes; anything else (e.g. `neutral`, `borderOnHover`,
// styled-props) would leak onto a real <button> and trip React's DOM warning.
vi.mock("~/components/Button", () => ({
  default: (props: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    "data-testid"?: string;
    style?: React.CSSProperties;
  }) => {
    // Forwarded verbatim: hardcoding values here would make the style
    // assertions below assert the mock instead of AIChatTrigger.
    const { children, onClick, "data-testid": testId, style } = props;
    return (
      <button data-testid={testId} onClick={onClick} style={style}>
        {children}
      </button>
    );
  },
}));

// Tooltip wraps children in a Radix portal – stub to plain pass-through.
vi.mock("~/components/Tooltip", () => ({
  default: ({
    children,
    content,
  }: {
    children: React.ReactNode;
    content?: React.ReactNode;
  }) => <div data-tooltip-content={content as string}>{children}</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = buildLightTheme({});

function renderTrigger(controls: AIChatControls | null) {
  mockUseAIChatPanel.mockReturnValue(controls);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <ThemeProvider theme={theme}>
        <AIChatTrigger />
      </ThemeProvider>
    );
  });

  const cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };

  const query = (testid: string) =>
    container.querySelector(`[data-testid="${testid}"]`);

  return { container, query, cleanup };
}

describe("AIChatTrigger", () => {
  afterEach(() => {
    mockUseAIChatPanel.mockReset();
    document.body.innerHTML = "";
  });

  it("renders the trigger button when AI chat is enabled and panel is closed", () => {
    const controls: AIChatControls = {
      open: vi.fn(),
      close: vi.fn(),
      isOpen: false,
    };

    const { query, cleanup } = renderTrigger(controls);
    const button = query("ai-chat-trigger") as HTMLElement | null;

    expect(button).not.toBeNull();
    // jsdom has no layout engine, so `offsetParent`/`getBoundingClientRect`
    // are always null/zeros; assert on the computed positioning style instead.
    expect(button?.style.position).toBe("fixed");
    expect(button?.style.right).toBe("24px");
    expect(button?.style.bottom).toBe("24px");
    // Must sit just below the sliding Aside (depths.sidebar) to avoid
    // overlapping the sidebar when the panel is open.
    expect(button?.style.zIndex).toBe(String(depths.sidebar - 1));
    cleanup();
  });

  it("does not render the trigger button when AI chat is disabled (hook returns null)", () => {
    const { query, cleanup } = renderTrigger(null);
    const button = query("ai-chat-trigger");

    expect(button).toBeNull();
    cleanup();
  });

  it("does not render the trigger button when panel is open", () => {
    const controls: AIChatControls = {
      open: vi.fn(),
      close: vi.fn(),
      isOpen: true,
    };

    const { query, cleanup } = renderTrigger(controls);
    const button = query("ai-chat-trigger");

    expect(button).toBeNull();
    cleanup();
  });

  it("calls controls.open when the trigger button is clicked", () => {
    const controls: AIChatControls = {
      open: vi.fn(),
      close: vi.fn(),
      isOpen: false,
    };

    const { query, cleanup } = renderTrigger(controls);
    const button = query("ai-chat-trigger") as HTMLButtonElement;

    expect(button).not.toBeNull();

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(controls.open).toHaveBeenCalledTimes(1);
    cleanup();
  });
});