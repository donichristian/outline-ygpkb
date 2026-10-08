# shared/ — code used by BOTH app and server

Alias: `@shared/*` → `shared/*`. Cross-cutting types, the ProseMirror editor,
and framework-agnostic utilities. Also transcompiled into the server build.

## Structure

```
shared/
├── editor/      ProseMirror editor (nodes, marks, extensions, commands…) → editor/AGENTS.md
├── utils/       82 helpers (urls, dates, slugs, markdown, ProsemirrorHelper…)
├── components/  Small cross-app React components (Icon, EmojiIcon, ColorPicker…)
├── i18n/        i18n config + locales/ (MACHINE-GENERATED — do not edit)
├── styles/      Design tokens: theme.ts, globals.ts, breakpoints.ts, depths.ts
├── helpers/     AuthenticationHelper, FilterHelper
├── hooks/       useShare, useStores
├── collaboration/ Y.js/WebSocket close events
├── test/        editor.ts (test schema factory), setup files
├── schema.ts    NOT the editor schema — zod import schemas
├── types.ts     Largest shared file (821) — global enums/interfaces
└── validations.ts  Zod validations
```

## Where to look

| Task | Location |
|------|----------|
| URL sanitization | `utils/urls.ts` — `sanitizeUrl`, `sanitizeImageSrc`, `urlRegex` |
| Markdown round-trip | `editor/lib/markdown/{rules,serializer}.ts` |
| Editor node/mark base classes | `editor/nodes/Node.ts`, `editor/marks/Mark.ts` |
| Extension base + schema builder | `editor/lib/Extension.ts`, `editor/lib/ExtensionManager.ts` |
| Global types | `types.ts` ; slugs/dates/emoji in `utils/` |
| i18n language list | `i18n/index.ts` (`languageOptions`) |

## Conventions & gotchas

- **Sanitize in `toDOM`**: ProseMirror `toDOM` writes raw DOM (unlike React).
  Wrap user-controlled `href`/`src` in `sanitizeUrl()`/`sanitizeImageSrc()`
  (e.g. `editor/nodes/Video.tsx`, `Embed.tsx`, `marks/Link.tsx`).
- `shared/schema.ts` is **not** the editor schema — the PM schema is built at
  runtime in `app/editor/index.tsx` from `editor/nodes/index.ts` (`basicExtensions`).
- `editor/nodes/index.ts` ordering is load-bearing: container/table nodes last so
  key handlers register for inner content first.
- Read-only mode: pure `extension` types with `allowInReadOnly=false` are not
  instantiated; Node/Mark extensions always are.
- Editing a language requires updating **both** `i18n/index.ts` and the `locales`
  array in `utils/date.ts`.
- `EDITOR_VERSION` (`editor/version.ts`) is `17.0.0`.

## Anti-patterns

- Never hand-edit `i18n/locales/` — translations are auto-extracted (`yarn build:i18n`).
- Do not `import { addRowBefore } from "prosemirror-tables"` — use the wrappers in
  `editor/commands/table.ts` (enforced by `no-restricted-imports`).
- Do not create new test directories; tests are colocated `*.test.ts(x)`.

## Largest files

`editor/components/Styles.ts` (2500) · `editor/commands/table.ts` (1286) ·
`types.ts` (821) · `editor/nodes/CodeFence.ts` (771) · `editor/embeds/index.tsx` (732)
