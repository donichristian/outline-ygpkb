# Native YAML frontmatter for Outline documents — implementation plan

**Goal:** Outline documents carry structured YAML frontmatter that Hermes (and
any MCP client) can read and write efficiently — without lossy round-trips
through a code fence.

**Why:** Today frontmatter is *not* first-class:
- **Import** (`server/converters/BaseConverter.ts::processFrontmatter`) converts
  an incoming `---` block into a ` ```yaml ` **code block**. It is parsed for
  validity, then flattened into body text. No structured storage.
- **Export** (`server/models/helpers/OKFHelper.ts`) *generates* frontmatter for
  OKF bundles (`type/title/description/resource/status/generated`) but reads
  nothing back.
- The **Document model** has no free-form metadata column (`content` JSONB is the
  ProseMirror snapshot; `sourceMetadata` JSONB is import provenance only).

So a graph the agent builds cannot round-trip: write frontmatter → it becomes a
code fence → the structure is lost.

---

## Design decision: where does frontmatter live?

Two viable stores. **Recommendation: A (dedicated JSONB column)** — it is the
only option that makes frontmatter queryable, graph-addressable, and independent
of the editor.

| Option | Storage | Pros | Cons |
|---|---|---|---|
| **A (recommended)** | New `frontmatter` JSONB column on `documents` | Queryable/indexable; survives editor churn; clean API surface; graph edges derivable in SQL | New column + migration + editor node + presenter/API plumbing |
| B | A ProseMirror `frontmatter` node at the top of `content` | Single source of truth; no migration | Buried in content; hard to query; every insert path must set it; collab/YJS merges risk |
| C | Keep the code-fence convention, parse on read | Zero schema change | Not structured; agents must parse text; no graph queries; violates "efficient" goal |

Proceed with **A**, but mirror the value into a **top-of-document ProseMirror
node for display/editing** (so the UI shows it) — the column is the source of
truth, the node is a projection.

---

## Data model

### 1. Migration + column
`server/migrations/XXXXXX-add-frontmatter-to-documents.js`

```js
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("documents", "frontmatter", {
      type: Sequelize.JSONB,
      allowNull: true,
    });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn("documents", "frontmatter");
  },
};
```
(Follow the 307 existing migrations' style; `yarn build:server` compiles TS
migrations before `yarn db:migrate`; `NODE_ENV=development` required.)

### 2. Model field — `server/models/Document.ts`
Mirror the `preferences: DocumentPreferences | null` JSONB column (line ~358):

```ts
/** Structured YAML frontmatter authored on the document. */
@AllowNull
@Column(DataType.JSONB)
frontmatter: Record<string, unknown> | null;
```

- Add to the `documentUpdate`/create allow-lists where `preferences`/`summary`
  are handled.
- Add a scope note: exclude from `withoutContent`? No — frontmatter is small,
  keep it in default scope so agents get it from `list_documents`.

### 3. Shared type — `shared/types.ts`
```ts
/** A YAML frontmatter value, restricted to JSON-safe primitives. */
export type FrontmatterValue =
  | string | number | boolean | null
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

export type DocumentFrontmatter = Record<string, FrontmatterValue>;
```

### 4. Validation — `shared/validations.ts`
- Guard shape + size (e.g. max 32 KB, max 100 keys, key charset `^[a-zA-Z0-9_-]+$`).
- Reject nested depth > N to keep it graph-friendly.

---

## Server round-trip

### 5. Import — `server/converters/BaseConverter.ts`
Replace the "parse then fence" behavior with structured capture:

- `processFrontmatter` returns `{ frontmatter: object | null, content }` instead
  of a rewritten string.
- `DocumentConverter.convert` puts `frontmatter` into `ConvertResult`.
- `server/commands/documentImporter.ts` writes `document.frontmatter = fm` on
  create (uses `*WithCtx`).
- **Keep a fallback:** if `frontmatter` is null (foreign file), preserve today's
  code-fence behavior so imports never regress.

### 6. Export — unify OKF + a new markdown emitter
- `OKFHelper.frontmatter` stays for the OKF bundle, but when a document has an
  explicit `frontmatter`, **merge**: stored keys win, OKF defaults fill gaps
  (`status`, `generated`, `resource`).
- Add a markdown export path (`ExportDocumentTreeTask` md branch) that prepends
  the stored frontmatter when present. Use one shared serializer
  (`OKFHelper.serialize` is already correct: `yaml.dump(..., { lineWidth: -1, noRefs: true })`).

### 7. Presenters — `server/presenters/document.ts`
Include `frontmatter` in the API payload (agent-visible). Gate by a new
`DocumentPreference` if you want it opt-in per document.

---

## Editor (authoring + display)

### 8. ProseMirror node — `shared/editor/nodes/Frontmatter.ts`
- A non-editable-by-default `frontmatter` node rendered as a collapsible widget
  at the top of `doc` (a `.tsx` React node, like `Embed.tsx`).
- `toMarkdown`: emit `---\n<yaml>\n---\n\n`; `parseMarkdown`: consume a leading
  fence into the node.
- Register in `shared/editor/nodes/index.ts` — **first** in `inlineExtensions`
  so it precedes body content (re-check the load-bearing ordering note in
  `shared/editor/AGENTS.md`).
- **Sanitize**: YAML is code-adjacent — never inject raw values into DOM; render
  as escaped text. Reuse the existing `sanitizeUrl` discipline.
- `EDITOR_VERSION` bump in `shared/editor/version.ts` (currently `17.0.0`).

### 9. Schema/Round-trip
- `app/editor/index.tsx` builds the schema from `basicExtensions`; the new node
  flows through automatically once added to `nodes/index.ts`.
- The doc top node is `Doc` (`shared/editor/nodes/Doc.ts`, `content: "block+"`).
  Allow `frontmatter` as optional first child (e.g. `content: "frontmatter? block+"`).

---

## Agent (MCP) surface

### 10. MCP tools — `server/mcp/tools/documents.ts`
- `create_document` / `update_document`: add optional
  `frontmatter: z.record(...)` input; write to `document.frontmatter`.
- `fetch` / `list_documents`: include `frontmatter` in the presented output
  (already returns metadata block + markdown body; add a `frontmatter` field).
- This is the *efficient interaction* the requirement asks for: Hermes sets
  typed keys instead of embedding a YAML code fence in the body.

### 11. Graph derivation (minimal — no viewer required)
Requirement is "support frontmatter for graph", not "build a viewer". Minimal
enabler:
- A helper `server/models/helpers/FrontmatterHelper.ts` that maps conventional
  keys to edges: `related: [docSlug]`, `sources: [url]`, `tags: [string]`,
  `[[wikilinks]]` in the body.
- Optionally expose it via a new MCP resource or tool `document_links` so Hermes
  can pull the adjacency. No server-side graph DB needed.

---

## Fork constraints & sequencing

- **Windows dev**: no Docker; use `yarn`. Migration flow:
  `yarn build:server` → `NODE_ENV=development yarn db:migrate`.
- **Verification order** (per root `AGENTS.md`): `yarn lint` → `yarn tsc` →
  `yarn test <file>`. Note ~2601 pre-existing format failures and lint warnings
  are baseline noise — format only touched files.
- **Server tests share a module registry**: any test using `vi.mock` /
  `vi.resetModules` needs `// @vitest-isolate true` on line 1.
- **i18n**: new UI strings are auto-extracted; never hand-edit
  `shared/i18n/locales/`. `yarn build:i18n` fails on Windows (`mkdir -p`), so add
  strings via source `t(...)` and let CI extract.

### Suggested PR sequence
1. **DB + model + presenter** (column, type, validation, present `frontmatter`).
2. **Import/export round-trip** (BaseConverter/DocumentConverter/importer + export merge).
3. **Editor node** (display/edit + serializer/parser + version bump).
4. **MCP tools** (create/update/fetch frontmatter fields).
5. **Graph helper** (`FrontmatterHelper` + optional `document_links` tool).

Each step is independently shippable and testable. Steps 1–2 already deliver
"frontmatter survives a round-trip"; step 3 makes it authorable in the UI; step 4
delivers the Hermes efficiency win.

---

## Risks

| Risk | Mitigation |
|---|---|
| Editor node breaks YJS collaboration / schema ordering | Add node last-ish, test collab; keep column as source of truth so a missing node never loses data. |
| Import regression for foreign files | Keep code-fence fallback when `frontmatter` is null. |
| YAML injection into DOM | Render frontmatter as escaped text; never `innerHTML`. |
| Schema version mismatch between clients | Bump `EDITOR_VERSION`; editor already handles unknown-version docs. |
| Query performance | JSONB is fine; add a GIN index only if graph queries need it. |

## Open decisions (need your call before coding)

1. **Frontmatter scope**: any keys, or a fixed schema (`tags`, `related`,
   `sources`, `type`, `status`)? A fixed schema makes graph edges trivial.
2. **Opt-in per document** (`DocumentPreference.frontmatter`) or always-on?
3. **Sync with OKF**: should stored frontmatter and OKF's generated keys merge
   (stored wins) — assumed yes above.
