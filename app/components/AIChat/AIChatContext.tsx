import { observer } from "mobx-react";
import * as React from "react";
import { TeamPreference } from "@shared/types";
import { useSetRightSidebar } from "~/components/RightSidebarContext";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import AIChatPanel from "./AIChatPanel";

/**
 * Controls the right-sidebar AI chat panel. `open` sets the panel content into
 * the ephemeral right sidebar context; `close` clears it. `isOpen` reflects
 * whether the panel is currently mounted.
 */
export interface AIChatControls {
  /** Opens the AI chat panel in the right sidebar. */
  open: () => void;
  /** Closes the AI chat panel and clears its content. */
  close: () => void;
  /** Whether the AI chat panel is currently open. */
  isOpen: boolean;
}

const AIChatContext = React.createContext<AIChatControls | null>(null);

/**
 * Module-level bridge between the command-bar action (which is a plain object
 * with no access to React context) and the mounted {@link AIChatProvider}. The
 * provider registers its `open` callback here on mount and clears it on
 * unmount; {@link openAIChatPanel} is the action-facing entry point. This keeps
 * the panel's open state in React where it already lives, instead of widening
 * `UiStore` (whose persisted `rightSidebar` field drives the Document sidebar).
 */
let openHandler: (() => void) | null = null;

/**
 * Registers the callback used by {@link openAIChatPanel} to open the panel.
 *
 * @param handler the provider's `open` callback.
 * @returns a cleanup function that removes the handler if it is still current.
 */
export function registerAIChatOpenHandler(handler: () => void): () => void {
  openHandler = handler;
  return () => {
    if (openHandler === handler) {
      openHandler = null;
    }
  };
}

/**
 * Opens the AI chat panel via the currently registered provider, if any. Safe
 * to call when AI chat is disabled for the workspace – the provider does not
 * register a handler while the {@link TeamPreference.AIChat} gate is off, so
 * the call is a no-op. The action additionally hides itself via its `visible`
 * predicate, so this is defence in depth.
 */
export function openAIChatPanel(): void {
  openHandler?.();
}

const noop = () => undefined;

/**
 * The panel as the sidebar sees it: a component with no props. It reads `close`
 * from the AI chat context instead of receiving it, so the element handed to the
 * sidebar cannot change when the provider re-renders. The Document sidebar
 * solves the same problem the same way with `DocumentSidebarContent`.
 */
const AIChatSidebarContent = function AIChatSidebarContent() {
  const controls = useAIChatPanel();
  return <AIChatPanel onClose={controls?.close ?? noop} />;
};

/**
 * Mounts the AI chat panel into the right sidebar whenever it is open, mirroring
 * the pattern used by the Document sidebar. Renders nothing itself – it drives
 * the ephemeral `RightSidebarContext` from an effect so the sliding `Aside`
 * animation in `Layout` is reused rather than duplicated.
 */
const AIChatContent = observer(function AIChatContent({
  isOpen,
}: {
  isOpen: boolean;
}) {
  const setSidebar = useSetRightSidebar();

  // Memoized so the sidebar element is referentially stable for the lifetime of
  // the provider. Handing the sidebar a different element tears the panel subtree
  // down and back up, discarding its component state – invisible until the
  // transcript silently resets. The effect depends on the open flag alone.
  const panel = React.useMemo(() => <AIChatSidebarContent />, []);

  React.useEffect(() => {
    setSidebar(isOpen ? panel : null);
  }, [isOpen, panel, setSidebar]);

  // Clear the sidebar content if the panel unmounts while open so a stale panel
  // does not linger after the provider goes away.
  React.useEffect(
    () => () => {
      setSidebar(null);
    },
    [setSidebar]
  );

  return null;
});

/**
 * Provider that owns the AI chat panel open/close state and renders the panel
 * into the right sidebar when open. The panel is gated on the workspace
 * {@link TeamPreference.AIChat} preference: when the preference is off nothing
 * is exposed through the context and no panel is mounted.
 *
 * The open state is intentionally local React state rather than a field on
 * `UiStore` – the persisted `ui.rightSidebar` enum drives the Document
 * comments/history panels and must not be disturbed.
 */
export function AIChatProvider({ children }: { children: React.ReactNode }) {
  const team = useCurrentTeam({ rejectOnEmpty: false });
  const enabled = !!team?.getPreference(TeamPreference.AIChat);
  const [requested, setRequested] = React.useState(false);

  // Derive the open state during render so that disabling the workspace
  // preference collapses an already-open panel without an effect.
  const isOpen = enabled && requested;

  const handleOpen = React.useCallback(() => setRequested(true), []);
  const handleClose = React.useCallback(() => setRequested(false), []);

  const controls = React.useMemo<AIChatControls | null>(() => {
    if (!enabled) {
      return null;
    }

    return {
      open: handleOpen,
      close: handleClose,
      isOpen,
    };
  }, [enabled, isOpen, handleOpen, handleClose]);

  // Publish the open callback to the module bridge so the command-bar action
  // can reach it, but only while the workspace gate is on.
  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    return registerAIChatOpenHandler(handleOpen);
  }, [enabled, handleOpen]);

  return (
    <AIChatContext.Provider value={controls}>
      {enabled && <AIChatContent isOpen={isOpen} />}
      {children}
    </AIChatContext.Provider>
  );
}

/**
 * Returns the AI chat panel controls, or `null` when AI chat is not enabled for
 * the current workspace. Todo 6 (the command-bar action) should call this hook
 * and invoke `open()` from the action's `perform`.
 *
 * @returns the panel controls, or `null` when disabled.
 */
export function useAIChatPanel(): AIChatControls | null {
  return React.useContext(AIChatContext);
}
