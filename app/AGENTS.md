# app/ — React SPA

React 19 + MobX + react-router-dom v5 + styled-components. Alias: `~/*` → `app/*`.
Entry: `app/index.tsx` (`createRoot(#root)`, provider stack: StrictMode → MobX
Provider → Router → Theme → KBarProvider → Routes).

## Structure

```
app/
├── index.tsx      SPA bootstrap + MobX config + provider tree
├── routes/        Route tree (index.tsx, authenticated.tsx, settings.tsx, scenes.ts)
├── scenes/        Route-level pages, one dir per screen (→ scenes/AGENTS.md)
├── components/    Shared UI components (→ components/AGENTS.md)
├── stores/        MobX stores, one per model (→ stores/AGENTS.md)
├── models/        Client data models extending models/base/Model
├── actions/       Action definitions → kbar + context menus + WebMCP
├── menus/         Dropdown/context menu wrappers rendering actions
├── editor/        ProseMirror Editor shell (index.tsx; real schema in shared/editor)
├── hooks/         Shared React hooks (useStores, usePolicy, useCurrentUser/Team…)
├── utils/         ApiClient.ts, routeHelpers.ts, errors.ts, history, i18n, sentry
├── styles/        Global theme + animations
└── typings/       Ambient .d.ts (styled-components, window, i18next)
```

## Where to look

| Task | Location |
|------|----------|
| API call / transport | `utils/ApiClient.ts` — `export const client`; RPC + request batching |
| Route definitions | `routes/index.tsx`, `routes/authenticated.tsx`, `routes/settings.tsx` |
| Path builders / slug regex | `utils/routeHelpers.ts` (`documentPath`, `matchDocumentSlug`, …) |
| Store root | `stores/RootStore.ts` (registration order matters; AuthStore last) |
| Data model fields sent to API | `@Field` decorator in `models/decorators/` |
| Command-bar / menu actions | `actions/definitions/*.tsx` + `actions/index.ts` `resolve()` |

## Conventions

- **Business logic lives in stores, not components.** Components are `observer()`
  function components using hooks. Event handlers named `handle*`.
- Strict MobX: `enforceActions`, `computedRequiresReaction`, `isolateGlobalState`
  set in `index.tsx`. Mutate only via `@action`; prefer `computed`.
- Styling is styled-components only — co-located in the `.tsx`, typed via
  `typings/styled-components.d.ts`. No CSS modules.
- Model gotcha: a field without a default initializer does not exist on the
  instance, so MobX can't annotate it. Anything sent to the API needs `@Field`.
- Route slugs are regex-constrained (`name-<10..15 alnum>`); always build paths
  with `routeHelpers`, never hand-concatenate `/doc/...`.
- Tests: colocated `*.test.ts` (project `app`, jsdom). Do not create test dirs.

## Anti-patterns

- Do not put fetch logic in components — go through a store → `ApiClient`.
- Do not import React unless used directly (react-jsx runtime).
- Do not hand-edit `shared/i18n/locales/` (auto-extracted).

## Largest files (beware, edit carefully)

`scenes/Developer/components/ExampleData.ts` (2654, generated data) ·
`actions/definitions/documents.tsx` (1829) · `components/Lightbox.tsx` (1262) ·
`editor/components/SuggestionsMenu.tsx` (1199) · `editor/index.tsx` (1089)
