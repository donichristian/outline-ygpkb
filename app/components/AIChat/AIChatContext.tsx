import { observer } from "mobx-react";
import * as React from "react";
import { TeamPreference } from "@shared/types";
import { useSetRightSidebarOverride } from "~/components/RightSidebarContext";
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
  /** Seeds a prompt into the panel's composer, consuming any prior one. */
  setPendingPrompt: (prompt: AiChatPrefill | null) => void;
  /**
   * Takes the pending prompt exactly once; `null` does not clear it, so a
   * closed panel finds it again on its next open.
   */
  consumePendingPrompt: () => AiChatPrefill | null;
}

/** A prompt waiting for the panel, optionally pinned to a document. */
export type AiChatPrefill = {
  /** The text to seed into the composer. */
  prompt: string;
  /** Sent as the top-level `documentId` of the request that sends it. */
  documentId?: string;
};

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

/** The pending prompt shared with {@link openAIChatPanel}. */
let pendingPrompt: AiChatPrefill | null = null;
const pendingPromptListeners = new Set<() => void>();

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
 * Reads and clears the pending prompt. Callers that do not take it (a panel
 * that mounts while closed) leave it in place, so the next open still finds it.
 *
 * @returns the pending prompt, or `null`.
 */
export function takePendingPrompt(): AiChatPrefill | null {
  const value = pendingPrompt;
  if (value !== null) {
    setPendingPrompt(null);
  }
  return value;
}

function getPendingPrompt(): AiChatPrefill | null {
  return pendingPrompt;
}

/**
 * Sets the prompt the panel seeds into its composer, or clears it. Kept outside
 * panel state so closing and reopening the panel never loses it.
 *
 * @param prompt the prompt, or `null` to clear it.
 */
export function setPendingPrompt(prompt: AiChatPrefill | null): void {
  pendingPrompt = prompt;
  pendingPromptListeners.forEach((listener) => listener());
}

function subscribePendingPrompt(listener: () => void): () => void {
  pendingPromptListeners.add(listener);
  return () => {
    pendingPromptListeners.delete(listener);
  };
}

/**
 * Restores a prompt that was never sent, unless a newer one has arrived.
 *
 * @param prompt the prefill to put back.
 */
export function restorePendingPrompt(prompt: AiChatPrefill): void {
  if (!pendingPrompt) {
    setPendingPrompt(prompt);
  }
}

/**
 * Opens the AI chat panel via the currently registered provider, if any. Safe
 * to call when AI chat is disabled for the workspace – the provider does not
 * register a handler while the {@link TeamPreference.AIChat} gate is off, so
 * the call is a no-op. The action additionally hides itself via its `visible`
 * predicate, so this is defence in depth.
 *
 * @param prompt an optional prompt to seed into the composer.
 */
export function openAIChatPanel(prompt?: string | AiChatPrefill): void {
  setPendingPrompt(prompt ?? null);
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
  const setSidebar = useSetRightSidebarOverride();

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
  const pendingPrompt = React.useSyncExternalStore(
    subscribePendingPrompt,
    getPendingPrompt,
    () => null
  );

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
      pendingPrompt,
      setPendingPrompt,
      consumePendingPrompt: takePendingPrompt,
    };
  }, [enabled, isOpen, pendingPrompt, handleOpen, handleClose]);

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
 * the current workspace.
 *
 * This hook is for in-tree React callers – the sidebar content that mounts the
 * panel reads `close` from it. The command-bar action is a plain object with no
 * React context, so it does not use this hook: it calls the module bridge
 * {@link openAIChatPanel}, which invokes the provider's `open` callback when one
 * is registered and is a no-op otherwise.
 *
 * @returns the panel controls, or `null` when disabled.
 */
export function useAIChatPanel(): AIChatControls | null {
  return React.useContext(AIChatContext);
}
