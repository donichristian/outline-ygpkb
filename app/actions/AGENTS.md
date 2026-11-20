# app/actions/ — action definitions

One action = one declarative object, consumed by three surfaces: kbar command bar, dropdown/context menus, WebMCP tools.

## Overview

Factories in `app/actions/index.ts` — the action factories emit `type: "action"` and default `id` to `uuidv4()`:

- `createAction` → `"action"`, needs `perform(context)`
- `createInternalLinkAction` → `"internal_link"`, needs `to`
- `createExternalLinkAction` → `"external_link"`, needs `url`
- `createActionWithChildren` → `"action_with_children"`, needs `children`
- `createActionGroup` → `action_group`, needs `name` + `actions`; it and the `ActionSeparator` marker (`action_separator`) carry no `id`; `createRootMenuAction(list)` wraps a list and mints a fresh `uuidv4()`.

Fields (`app/types.ts` `BaseAction`): `id`, `name`, `section`, `analyticsName`, `description`, `shortcut`, `keywords`, `priority`, `icon`, `iconInContextMenu`, `badge`, `placeholder`, `selected`, `visible`, `disabled`, `mcp.inputSchema`; `Action` adds `dangerous`, `tooltip`, `perform`.

Per-surface fields are functions of `ActionContext`: `name: ({ t }) => t("Home")`, `visible: ({ stores }) => ...`. `resolve(value, context)` unwraps function-or-literal fields — there is **no** id→definition registry; `id` is identity for kbar parents and React keys. `section` comes from `app/actions/sections.ts` (`({ t }) => t("Document")`, optional attached `.priority`).

`performAction(action, context)` runs `perform`, `history.push` for `internal_link`, `window.open` for `external_link`, tracks `perform_action` with `analyticsName`, toasts errors unless `context.isMCP`.

**Consumers.**

- Command bar — `CommandBar.tsx` merges `rootActions` (`~/actions/root`); `useCommandBarActions` maps them via `actionToKBar` into kbar.
- Menus — `app/menus/*.tsx` wrap children in `ActionContextProvider`, pass an action list to `DropdownMenu`/`ContextMenu` → `actionToMenuItem`; `hasVisibleActions` gates rendering.
- WebMCP — `useWebMCPActions` flattens actions (drops invisible, dangerous, separators), names tools `snakeCase(analyticsName)`, registers them; `AuthenticatedLayout.tsx` registers `rootWebMCPActions` from `app/actions/definitions/webmcp.ts`.

**Adding one.**

1. New file `app/actions/definitions/<domain>.tsx`, or extend an existing one.
2. Build with a factory; export a `root<Domain>Actions` array.
3. Import + spread it in `app/actions/root.ts` — collection is an explicit import list, no directory glob, no registry.
4. Menu-only: skip `root.ts`, add to a `use*MenuActions` hook. MCP-only: keep in `definitions/webmcp.ts` — listing it in `root.ts` also shows it in kbar.
5. `section` must exist in `app/actions/sections.ts`.

## Where to look

| Task | Location |
|------|----------|
| Factories, `resolve`, `performAction` | `app/actions/index.ts` |
| Field types, `ActionContext` | `app/types.ts` |
| Sections + priorities | `app/actions/sections.ts` |
| Definitions + shared factories | `app/actions/definitions/*.tsx`, `app/actions/definitions/common.tsx` |
| Command-bar root list | `app/actions/root.ts` |
| Context provider | `app/hooks/useActionContext.tsx` |
| Command bar / menu / MCP hooks | `app/hooks/useCommandBarActions.ts`, `app/hooks/useWebMCPActions.ts`, `app/hooks/use*MenuAction(s).tsx` |
| Menu rendering | `app/components/Menu/DropdownMenu.tsx`, `app/menus/*.tsx` |
| MCP tool registration | `app/utils/ModelContext.ts` |

## Conventions

- Declarative. `perform` calls store methods; bulk work uses `performBatch` / `performBatchOnActiveModels` (`definitions/common.tsx`).
- `name` is an i18n key (`({ t }) => t("Home")`); `analyticsName` is an untranslated literal feeding analytics and the MCP tool name. MCP-only actions use untranslated `name`/`description` (agents read them).
- Set `id` explicitly only when it must stay stable (e.g. a document URL).
- `visible`/`disabled` are predicates over `ActionContext`; authorize with `stores.policies.abilities(...)`.
- `iconInContextMenu: false` hides the icon in menus, keeps it in kbar.

## Anti-patterns

- Do not treat `resolve()` as an id lookup — it unwraps function-or-literal fields only.
- Do not translate `analyticsName`; do not omit it on WebMCP-bound actions.
- Do not register MCP-only actions in `app/actions/root.ts`.
- Do not hand-roll per-item API loops in `perform`; batch them.
- Do not duplicate a definition per surface — export once, compose the list.
- Do not mutate `ActionContext`; it comes from `useActionContext`.
