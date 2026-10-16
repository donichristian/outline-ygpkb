import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  RightSidebarProvider,
  useRightSidebarContent,
  useSetRightSidebar,
  useSetRightSidebarOverride,
} from "./RightSidebarContext";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Captured from the harness so a test can drive both slots directly; a context
// consumer re-renders on value change, which is what these assertions read.
let setContent: (content: React.ReactNode) => void = () => undefined;
let setOverride: (content: React.ReactNode) => void = () => undefined;

function Harness() {
  setContent = useSetRightSidebar();
  setOverride = useSetRightSidebarOverride();
  const content = useRightSidebarContent();
  return (
    <div data-testid="out">
      {typeof content === "string" ? content : "none"}
    </div>
  );
}

describe("RightSidebarProvider", () => {
  it("lets the override outrank scene content and yields back when cleared", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <RightSidebarProvider>
          <Harness />
        </RightSidebarProvider>
      );
    });

    const out = () =>
      document.querySelector('[data-testid="out"]')?.textContent;

    act(() => setContent("scene"));
    expect(out()).toBe("scene");

    act(() => setOverride("ai"));
    expect(out()).toBe("ai");

    // A scene clearing its own content – what a route change does – must not
    // evict the override.
    act(() => setContent(null));
    expect(out()).toBe("ai");

    act(() => setOverride(null));
    expect(out()).toBe("none");

    act(() => root.unmount());
    container.remove();
  });
});
