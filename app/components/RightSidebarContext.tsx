import * as React from "react";

type SetSidebarFn = (content: React.ReactNode) => void;

const RightSidebarSetterContext = React.createContext<SetSidebarFn | null>(
  null
);
const RightSidebarOverrideSetterContext =
  React.createContext<SetSidebarFn | null>(null);
const RightSidebarContentContext = React.createContext<React.ReactNode>(null);

/**
 * Provider that holds right sidebar content state. Wrap at the layout level
 * so that scenes can set sidebar content via the setter hook.
 *
 * Two slots share the one sidebar: scene content (comments, history) and an
 * override that outranks it. The override exists so the AI chat panel survives
 * navigation – a scene's `setSidebar(null)` on route change must not evict a
 * panel the user has not closed.
 */
export function RightSidebarProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [content, setContent] = React.useState<React.ReactNode>(null);
  const [override, setOverride] = React.useState<React.ReactNode>(null);

  return (
    <RightSidebarSetterContext.Provider value={setContent}>
      <RightSidebarOverrideSetterContext.Provider value={setOverride}>
        <RightSidebarContentContext.Provider value={override ?? content}>
          {children}
        </RightSidebarContentContext.Provider>
      </RightSidebarOverrideSetterContext.Provider>
    </RightSidebarSetterContext.Provider>
  );
}

/**
 * Returns a stable setter function to set the right sidebar content.
 * Used by scenes (e.g. Document) to populate the sidebar.
 */
export function useSetRightSidebar(): SetSidebarFn {
  const setter = React.useContext(RightSidebarSetterContext);
  if (!setter) {
    throw new Error(
      "useSetRightSidebar must be used within a RightSidebarProvider"
    );
  }
  return setter;
}

/**
 * Returns a stable setter for sidebar content that outranks scene content.
 * Used by the AI chat panel, whose content must persist across navigation until
 * the user closes it – a scene setting its own content, or clearing it, must not
 * evict the panel.
 *
 * @returns the override setter.
 * @throws when used outside a {@link RightSidebarProvider}.
 */
export function useSetRightSidebarOverride(): SetSidebarFn {
  const setter = React.useContext(RightSidebarOverrideSetterContext);
  if (!setter) {
    throw new Error(
      "useSetRightSidebarOverride must be used within a RightSidebarProvider"
    );
  }
  return setter;
}

/**
 * Returns the current right sidebar content. Used by Layout to render
 * the sidebar.
 */
export function useRightSidebarContent(): React.ReactNode {
  return React.useContext(RightSidebarContentContext);
}

/**
 * Context indicating whether the Right sidebar wrapper is already rendered
 * by an ancestor. When true, SidebarLayout skips rendering its own Right
 * wrapper to avoid duplicate animated containers.
 */
export const RightSidebarWrappedContext = React.createContext(false);
