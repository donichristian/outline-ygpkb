# shared/editor/ — ProseMirror editor internals

Every feature is an `Extension` subclass typed `"node"` | `"mark"` | `"extension"`.
`ExtensionManager` aggregates them into the schema, plugins, keymaps, input
rules, markdown serializer/parser, and selection-toolbar menus.

## Structure

```
editor/
├── lib/         Extension.ts, ExtensionManager.ts, markdown/{rules,serializer}.ts
├── nodes/       PM nodes (Node base + index.ts extension sets) — React nodes are .tsx
├── marks/       Mark base + Bold/Italic/Code/Highlight/Link/Comment/…
├── extensions/  Non-node features (History, MaxLength, Mermaid, Diff, Math…)
├── commands/    PM command factories (table.ts 1286, CodeFence, toggleList…)
├── queries/     Selection/doc introspection (isMarkActive, findParentNode, table…)
├── rules/       markdown-it / input rules (tables, checkboxes, mentions…)
├── plugins/     State plugins (Anchor, Placeholder, TableColumnResize…)
├── embeds/      Embed registry + per-service embeds (index.tsx 732)
├── components/  Editor React UI (Styles.ts 2500, Embed, Image, Mentions…)
├── selection/   ColumnSelection, RowSelection
├── types/       MenuItem, TableLayout, NodeAttrMark…
├── utils.ts     PM transaction/selection helpers (516)
└── version.ts   EDITOR_VERSION = "17.0.0"
```

## Schema source of truth

`nodes/index.ts` exports the composable extension sets:
`inlineExtensions`, `listExtensions`, `tableExtensions`,
`basicExtensions` (inline + list + HeadingPrefix),
`richExtensions` (full), and `withComments(nodes)`.
`ExtensionManager` strips marks/excludes absent from the current schema — never
assume a mark exists. The `Editor` React class that builds `new Schema({...})`
lives in `app/editor/index.tsx` (imported as `~/editor`); server-side uses
`server/editor/`.

## Conventions & gotchas

- Extensions declare `schema`, `plugins`, `keys`, `inputRules`, `commands`,
  `toMarkdown`, `parseMarkdown`, `widget`, `selectionToolbarMenus()`.
- **Sanitize in `toDOM`** — raw DOM, not React. Wrap `href`/`src` in
  `sanitizeUrl()`/`sanitizeImageSrc()`.
- Node/mark ordering in `nodes/index.ts` is intentional (containers/tables last).
- Table ops: use `editor/commands/table.ts` wrappers, not `prosemirror-tables`
  `addRowBefore`/`addColumnAfter` directly.
- Widgets are wrapped in MobX `observer` by `ExtensionManager`.
- Tests can build an editor via `shared/test/editor.ts`.

## Largest files

`components/Styles.ts` (2500) · `commands/table.ts` (1286) ·
`nodes/CodeFence.ts` (771) · `embeds/index.tsx` (732) · `queries/table.ts` (719)
