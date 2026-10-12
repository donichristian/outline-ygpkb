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
 * Mounts the AI chat panel into the right sidebar whenever it is open, mirroring
 * the pattern used by the Document sidebar. Renders nothing itself – it drives
 * the ephemeral `RightSidebarContext` from an effect so the sliding `Aside`
 * animation in `Layout` is reused rather than duplicated.
 */
const AIChatContent = observer(function AIChatContent({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const setSidebar = useSetRightSidebar();

  React.useEffect(() => {
    if (isOpen) {
      setSidebar(<AIChatPanel onClose={onClose} />);
    } else {
      setSidebar(null);
    }
  }, [isOpen, onClose, setSidebar]);

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

  const handleClose = React.useCallback(() => setRequested(false), []);

  const controls = React.useMemo<AIChatControls | null>(() => {
    if (!enabled) {
      return null;
    }

    return {
      open: () => setRequested(true),
      close: () => setRequested(false),
      isOpen,
    };
  }, [enabled, isOpen]);

  return (
    <AIChatContext.Provider value={controls}>
      {enabled && <AIChatContent isOpen={isOpen} onClose={handleClose} />}
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
