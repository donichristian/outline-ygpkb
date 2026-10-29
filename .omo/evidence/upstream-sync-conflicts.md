# Upstream sync — conflict resolutions and gate evidence

**Branch:** `sync/upstream-main` (worktree `D:\Work-Project\Outline-YGPKB\outline-ygpkb-wt\upstream-sync-w1`)
**Merge:** `origin/main` (`6946f2b278`, fork) ← `upstream/main` (`0545db9080`, official `outline/outline`, 157 commits)
**Diff vs `origin/main`:** 1138 files changed, +31886 / −21671
**Conflicts:** 15 (the dry-run predicted 13; `package.json`, `tsconfig.json` and `yarn.lock` also conflicted)
**Push / PR:** none (orchestrator owns those)

## 1. Conflict table

| # | File | Ours (fork `main`) wanted | Theirs (`upstream/main`) wanted | Kept | Why |
|---|------|---------------------------|---------------------------------|------|-----|
| 1 | `AGENTS.md` | Fork-only guidance: Windows setup, `scripts/` launchers, worktree/PR rules, sub-`AGENTS.md` index, alias table | Full rewrite with new convention sections (General Guidelines, Dependencies & Upgrading, React/MobX/DB/API/Auth/Realtime/Testing/Performance/Security) | Fork's structure and every fork section, with upstream's new sections folded in; alias table retargeted to `.mts`; note added that `shared/types.ts` is now `shared/types/` | Policy: keep all fork-specific guidance, add upstream's new material. Doc must stay true after the rename |
| 2 | `app/components/AuthenticatedLayout.tsx` | `layoutRef.current` passed to `PortalContext`, plus `AIChatProvider` wrapper and `<AIChatTrigger />` | Layout element held in state (`layoutElement` / `setLayoutElement`) — fixes reading `ref.current` during render | Upstream's state-based ref **and** fork's `AIChatProvider` + `AIChatTrigger` | Upstream structure is the newer base; the AI-chat delta must survive |
| 3 | `app/scenes/Document/hooks/useDocumentSave.ts` | `shouldAutoDeleteDraftOnUnmount(... isJustCreated: false)` — fork's "never trash a draft just created" guard | `queueMicrotask` deferral + `isPersistedOnce` predicate (created-at === updated-at) | Upstream's mechanism; fork's intent retargeted to `isPersistedOnce`; fork's explanatory comment rewritten | Upstream's predicate is time-independent, so it also covers a fresh draft left open >10 s (a hole in the fork's 10-second window). Fork test updated to the new predicate name |
| 4 | `build.js` | Windows-safe `fs` helpers (`remove`, `copy`), `yarn swc` per directory | POSIX `rm -rf` / `cp`, one swc pass, watch mode, locales copy | Upstream's structure (watch mode, single swc pass, `copyDirectory` for locales) **and** fork's `fs`-based helpers + `yarn swc` | `node_modules/.bin/swc` is not executable through `cmd.exe` (verified: `'node_modules' is not recognized`); `yarn swc` is. POSIX `cp`/`rm` fail on Windows |
| 5 | `package.json` | `@tanstack/ai 0.69.0`, `ai-client 0.39.3`, `ai-openai 0.30.0`, `ai-react 0.30.4` | `@socket.io/redis-adapter` (new dep) + bumped i18n backends | Both: all four exact `@tanstack/ai*` pins **and** `@socket.io/redis-adapter` | Independent additions; neither side contains the other. Fork scripts (`copy:i18n`, `dev:start`, `dev:stop`, `dev:reset`) auto-merged |
| 6 | `server/middlewares/csp.ts` | `env.VITE_DEV_PORT` | `env.vitePort` getter | `env.vitePort` | Upstream base; the getter was pointed at `VITE_DEV_PORT` (§3) so the fork's env var stays authoritative |
| 7 | `server/policies/index.ts` | `// Import all policies` + `import "./aiChatSession";` | Comment line removed, no AI policy import | The `aiChatSession` import (alphabetically first), stale comment dropped | Fork delta is the import itself; the comment is redundant against the file's contents |
| 8 | `server/routes/api/teams/schema.ts` | `[TeamPreference.AIChat]: z.boolean()` | `[TeamPreference.PersonalDocs]: z.boolean()` | Both | Independent preferences; dropping either loses a feature flag |
| 9 | `server/routes/app.ts` | `const viteHost = env.URL.replace(... env.VITE_DEV_PORT)` | `env.vitePort` | `env.vitePort` | Same reason as #6 |
| 10 | `shared/constants.ts` | `[TeamPreference.AIChat]: false` | `[TeamPreference.PersonalDocs]: true` | Both defaults | Independent preferences |
| 11 | `shared/i18n/locales/en_US/translation.json` | Fork's AI-chat strings | Upstream catalog | Upstream file, then repo extraction (`yarn i18next --silent '{shared,app,server,plugins}/**/*.{ts,tsx}'`) | Never hand-merge a generated catalog. Result: +35 fork keys, 0 removed. Parser wrote 1995 CRLF lines on Windows → normalized to LF so the diff stays minimal; 0 raw `\r`, 0 `\r\n` escapes. Verified keys: `Queued messages`, `Waiting for result…`, `Response cut short`, `Stopped`, `Done`, `Running`, `AI chat`, `Chat history` |
| 12 | `shared/types.ts` | File present, carrying `TeamPreference.AIChat` + `TeamPreferences[AIChat]` | File deleted, split into `shared/types/` directory | Deletion accepted (`git rm`); the two `AIChat` lines re-applied to `shared/types/team.ts` | Upstream's module layout is the new base. No import repointing was needed: `@shared/*` → `shared/*` resolves `@shared/types` to `shared/types/index.ts`, and `tsc` proves the whole graph |
| 13 | `tsconfig.json` | `@tanstack/ai-openai/compatible` path entry | `pele/lazy` path entry | Both | Independent type-resolution workarounds |
| 14 | `vite.config.mts` | `vite.config.ts` with `redirectRootToApp` plugin, `VITE_DEV_PORT` port, `strictPort` comment, `./server/utils/environment` import | Renamed to `.mts`, inline `loadEnvironment()` helper, `PORT + 1` port | Upstream's file shape (`env()` accessor, no server-TS import from Vite) + fork's redirect plugin, `VITE_DEV_PORT` override and `strictPort` comment | Upstream base; the fork's two deltas re-applied on top. Aliases `~`→`app`, `@shared`→`shared` present |
| 15 | `yarn.lock` | Fork's tanstack resolutions | Wholesale rewritten lockfile | Upstream lockfile, then `yarn install` | Never hand-merge a lockfile. `yarn install` added the four `@tanstack/ai*` resolutions (`@tanstack/ai@npm:0.69.0`, `ai-client@npm:0.39.3`, `ai-openai@npm:0.30.0`, `ai-react@npm:0.30.4`) |

## 2. Repairs required after the text conflicts

These were not conflict hunks but were broken by the merge and are part of the resolution:

1. **`koa-router` → `@koa/router`** in `server/routes/api/ai/{ai,aiSessions,index}.ts`. Upstream dropped the `koa-router` package; `tsc` reported `TS2307: Cannot find module 'koa-router'`.
2. **`Tooltip placement` → `side`** in `app/components/AIChat/{AIChatHistory,AIChatPanel}.tsx`. Upstream's Tooltip exposes `side`; `tsc` reported `Property 'placement' does not exist`.
3. **`server/env.ts`** — the auto-merge left two sources of truth: the fork's `VITE_DEV_PORT` field and upstream's `vitePort` getter (`PORT + 1`). `VITE_DEV_PORT` now defaults to `PORT + 1` and `vitePort` returns `VITE_DEV_PORT`, so `csp.ts`, `routes/app.ts` and `vite.config.mts` all read the same value and the fork's override still wins.
4. **`shared/types/team.ts`** — re-applied the fork's `TeamPreference.AIChat` enum member and `TeamPreferences` field (see #12).
5. **`app/scenes/Document/hooks/useDocumentSave.test.ts`** — fork's regression test renamed from `isJustCreated` to `isPersistedOnce` with the semantics inverted, so it still fails if a never-persisted empty draft is trashed on unmount.

## 3. Fork AI-chat surface verified intact

Present and registered after the merge:

- `server/routes/api/ai/**` (18 files) — `import ai from "./ai"` + `router.use("/", ai.routes())` in `server/routes/api/index.ts`
- `app/components/AIChat/**`, `app/utils/aiChat.ts`, `app/stores/AIChat*`, `app/models/AIChat*`
- `docs/AI-CHAT.md`, `docs/AI-CHAT-DESIGN.md`, `docs/AI-CHAT-E2E.md`
- `package.json`: `@tanstack/ai 0.69.0`, `@tanstack/ai-client 0.39.3`, `@tanstack/ai-openai 0.30.0`, `@tanstack/ai-react 0.30.4` (also present in `yarn.lock`)
- `tsconfig.json`: `@tanstack/ai-openai/compatible` path entry
- `server/env.ts`: `AI_CHAT_BASE_URL`, `AI_CHAT_API_KEY`, `AI_CHAT_MODEL`, `AI_CHAT_REASONING`, `AI_CHAT_GROUNDING`
- `server/errors.ts`: `ProviderUnavailableError`
- `app/actions/definitions/navigation.tsx`: `openAIChat` action, gated on `TeamPreference.AIChat`
- `server/utils/PluginManager.ts`: `pluginEntryPointGlob` (Windows-safe glob)
- `server/mcp/tools/documents.test.ts`: `list_collection_documents` cases
- `scripts/copy-i18n.mjs`, `scripts/dev*.ps1`, `scripts/dev.js`

Alias mapping after the rename: `~` → `app` and `@shared` → `shared` in `vite.config.mts:resolve.alias` and `vitest.config.mts:aliases`; `.swcrc` still carries all four `paths` entries (`@server`, `@shared`, `~`, `plugins`).

## 4. Gates

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `yarn tsc --incremental false` | **EXIT=0**, no diagnostics (re-run `yarn tsc` EXIT=0) |
| App tests | `yarn test:app` | **43 files / 388 tests passed**, EXIT=0 |
| AI server tests | `yarn test server/routes/api/ai/` | **9 files / 161 tests passed**, EXIT=0 |
| Server build | `yarn build:server` | **EXIT=0** (`Clean → Compiling → Copying static files → Done!`) |
| Lint | `yarn lint` | **EXIT=0**, 179 warnings / 0 errors. Baseline (`6946f2b278`): 184 warnings / 0 errors → **0 new errors, 5 fewer warnings** |
| Server tests | `yarn test:server` | 254 files, **9 failed / 245 passed**; 26 failed / 4171 passed / 6 skipped of 4203. **Delta vs baseline: 0** |

### `yarn test:server` delta

Baseline was measured, not assumed: a detached worktree at `6946f2b278` with its own `yarn install` was run against the same nine files — **9 failed files, 26 failed tests**. The merged tree reproduces the same nine files and the same per-file counts:

| File | Baseline | Merged |
|------|---------:|-------:|
| `server/routes/api/cron/cron.test.ts` | 4 | 4 |
| `plugins/storage/server/api/files.test.ts` | 4 | 4 |
| `server/queues/tasks/MarkdownAPIImportTask.test.ts` | 6 | 6 |
| `server/converters/DocumentConverter.test.ts` | 3 | 3 |
| `server/queues/tasks/ExportTextBundleZipTask.test.ts` | 3 | 3 |
| `server/routes/api/documents/documents.test.ts` | 2 | 2 |
| `server/routes/api/revisions/revisions.test.ts` | 2 | 2 |
| `server/queues/tasks/ExportOKFZipTask.test.ts` | 1 | 1 |
| `server/commands/documentImporter.test.ts` | 1 | 1 |
| **Total** | **26** | **26** |

All of these are pre-existing and outside the AI surface. Root causes seen:
`Cannot find package '@shared/types'` from `requireDirectory()` loading task files through Node's native loader (bare-specifier resolution bypasses the Vite alias — the new `shared/types/index.ts` layout does not change that, so the cron failures persist exactly as before);
`invalid file trailer` from `@firecrawl/pdf-inspector` on the PDF fixtures; storage / textpack / markdown-import fixture comparisons.

One earlier full-suite run reported 27 (an extra 5-second timeout in `documentImporter > should convert Word Document to markdown`). The repeat run and the isolated run both show that test passing, `server/converters/DocxConverter.ts` is unchanged between `origin/main` and `upstream/main`, and the file's per-file count matches baseline — a load-induced timeout flake, not a regression.

## 5. Hygiene checks

- `git diff --name-only --diff-filter=U` → empty (no unmerged paths)
- Conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) → none in `.ts/.tsx/.js/.jsx/.mjs/.mts/.json/.md` outside `node_modules`/`build`
- Dangling imports of the deleted module → none; no references to `vite.config.ts`, `vitest.config.ts` or `shared/types.ts` in `package.json`, `scripts/` or `.github/workflows/` (only a historical mention in `docs/FRONTMATTER-PLAN.md`)
- Only the snapshot files show as worktree-modified after the test runs; their `git diff` is empty (line-ending normalisation only) and they are **not** staged
