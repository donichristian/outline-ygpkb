# AGENTS.md

Guidance for AI agents working in this repository.

**This is a fork of [Outline](https://github.com/outline/outline)** with local
Windows-native development tooling. Upstream conventions still apply; the
fork-specific parts are called out below.

Read these before working here:

- `docs/TECHNICAL-GUIDE.md` — Windows setup, ports, DB/Redis, troubleshooting
- `docs/ARCHITECTURE.md` — upstream architecture
- `docs/NON-TECHNICAL-GUIDE.md` — non-engineering overview

Fork-specific docs:

- `docs/AI-CHAT.md` — AI chat feature
- `docs/KB-INTEGRATION-CONTRACT.md` — knowledge-base integration contract
- `docs/HERMES-INTEGRATION.md` — Hermes integration
- `docs/HERMES-OUTLINE-ARCHITECTURE.md` — Hermes × Outline architecture
- `docs/FOUNDATION-ARCHITECTURE.md` — foundation architecture
- `docs/SERVICES.md` — service topology
- `docs/DEPLOYMENT.md` — deployment
- `docs/TELEGRAM-COMMANDS.md` — Telegram commands
- `docs/FRONTMATTER-PLAN.md` — frontmatter plan
- `docs/SECURITY.md` — security notes

## Where to look

| Task | Location | Notes |
|------|----------|-------|
| Frontend feature/bug | `app/` | React 19 SPA, MobX stores, react-router v5. See `app/AGENTS.md`. |
| API endpoint | `server/routes/api/<resource>/<resource>.ts` | RPC-style `POST /api/x.y`. See `server/AGENTS.md`. |
| DB model / soft-delete | `server/models/*.ts` + `models/helpers/` | Sequelize. See `server/models/AGENTS.md`. |
| Multi-step write workflow | `server/commands/` | Cross-model orchestration (create/move/import). See `server/commands/AGENTS.md`. |
| Authorization rule | `server/policies/*.ts` | cancan-style; one file per model. See `server/policies/AGENTS.md`. |
| Rich-text editor | `shared/editor/` | ProseMirror. See `shared/editor/AGENTS.md`. |
| Shared types/utils | `shared/` | Used by both app + server. See `shared/AGENTS.md`. |
| Third-party integration | `plugins/<name>/` | `server/` + `client/` split. See `plugins/AGENTS.md`. |
| Background job / queue | `server/queues/` | Bull tasks + processors. See `server/queues/AGENTS.md`. |
| Command bar / context menu action | `app/actions/definitions/` | Definitions consumed by menus + kbar. See `app/actions/AGENTS.md`. |
| Client-side model | `app/models/` | MobX models + field decorators. See `app/models/AGENTS.md`. |
| AI chat (fork feature) | `server/routes/api/ai/` + `app/components/AIChat/` | Streaming chat. See `docs/AI-CHAT.md`. |
| MCP tools (fork feature) | `server/mcp/` | Tool impls + skills; `server/routes/mcp/` is the HTTP mount. |

## Subdirectory knowledge base

This file is the root of a hierarchy. Load the child file nearest the code you
touch (children never restate parent content):

- `app/AGENTS.md` — SPA structure, stores, models, routing, conventions
- `app/stores/AGENTS.md` — MobX store patterns
- `app/models/AGENTS.md` — client-side models + field decorators
- `app/components/AGENTS.md` — shared component library
- `app/scenes/AGENTS.md` — route-level pages
- `app/actions/AGENTS.md` — action definitions (kbar, menus, WebMCP)
- `server/AGENTS.md` — Koa app, boot, request flow, commands/policies
- `server/models/AGENTS.md` — Sequelize models + base classes
- `server/routes/api/AGENTS.md` — RPC route conventions
- `server/commands/AGENTS.md` — cross-model write commands
- `server/policies/AGENTS.md` — cancan abilities
- `server/queues/AGENTS.md` — Bull tasks/processors
- `shared/AGENTS.md` — cross-cutting shared code
- `shared/editor/AGENTS.md` — ProseMirror editor internals
- `plugins/AGENTS.md` — plugin architecture

## Repo layout

```
outline-ygpkb/
├── app/          React SPA (MobX, react-router v5, styled-components) → "~" alias
├── server/       Koa + Sequelize + Bull backend (RPC API, services, queues)
├── shared/       Code used by BOTH app and server (editor, types, utils) → "@shared"
├── plugins/      24 integrations, each server/ + client/ (slack, github, …)
├── scripts/      Windows dev launchers (dev-start/check/stop/reset.ps1, dev.js)
├── docs/         Technical + architecture guides
├── build/        GENERATED — never edit or commit
└── server/migrations/   48 committed .js migrations (+ baseline/) — plain JS, run as-is
```

Note that `shared/types.ts` no longer exists — upstream split it into the
`shared/types/` directory (`index.ts` re-exports every module). Import
`@shared/types` as before; only the file layout changed.

## Path aliases (critical for crawling imports)

Defined in `tsconfig.json`; **duplicated** in `vitest.config.mts`,
`vite.config.mts` (only `~` and `@shared`), and `.swcrc`. Keep all in sync.

| Alias | Resolves to |
|-------|-------------|
| `~/*` | `app/*` |
| `@server/*` | `server/*` |
| `@shared/*` | `shared/*` |
| `plugins/*` | `plugins/*` (relative imports used inside plugins) |

## Repository and branch workflow

Fork: `https://github.com/donichristian/outline-ygpkb`

Branch hierarchy is **`main` → `development` → feature branches**:

- `main` mirrors upstream and is the release branch.
- `development` is the integration branch. Fork work lands here first.
- Feature branches (`fix/*`, `feat/*`) branch off **`development`**, not `main`.

**Open PRs against `development`.** `development` is what flows into `main`.
Branching off `main` produces a PR that bypasses the integration branch and
cannot see work already merged into `development`. If asked to "PR to main",
confirm the base first — it is almost always `development`.

Commit messages follow Conventional Commits with a scope:

```
fix(documents): don't auto-trash drafts that were just created
feat(dev): add yarn dev:start
docs: document native Windows dev setup
```

## Commands

```bash
yarn lint                # oxlint --type-aware over app server shared plugins
yarn lint:changed        # oxlint on git-changed files (POSIX grep/xargs — fails on Windows)
yarn format              # oxfmt (write); yarn format:check to verify
yarn tsc --incremental false   # typecheck, the CI form (no package script — local binary)
yarn test path/to/x.test.ts   # single file (preferred)
yarn test:app  test:server  test:shared
yarn build:server        # compile server TS → build/ (needed before yarn start)
yarn build:i18n          # extract translations + copy locales → build/
yarn db:migrate          # sequelize-cli; needs NODE_ENV=development
yarn db:rollback  yarn db:reset
yarn db:create-migration --name my-migration
```

Migrations are already plain `.js` in `server/migrations/`, and `.sequelizerc`
points sequelize-cli there, so no build step is needed before `db:migrate`.

`yarn test` runs with `TZ=UTC`. Server tests need PostgreSQL and Redis on
`127.0.0.1` (`outline-test` database, `.env.test`).

CI (`.github/workflows/ci.yml`) runs `yarn lint --quiet` → `yarn tsc
--incremental false` → `yarn test:app` / `yarn test:shared`; the server job
runs `yarn sequelize db:migrate` then `yarn test:server --maxWorkers=4
--shard=N/6`. Separate `actionlint`, `audit`, and `bundle-size` jobs cover
workflow YAML, dependency advisories, and app bundle size (the last is gated
to the upstream repo).

`.husky/pre-commit` runs `npx lint-staged`, configured by
`lint-staged.config.mjs`: oxfmt → oxlint `--fix` (or `yarn lint --fix` above
20 files) → `yarn build:i18n` → `git add` the translation catalog, plus
`yarn dedupe` for lockfile changes. The hook does not run in this checkout —
see below. Translation strings are **extracted automatically** — never
hand-edit `shared/i18n/locales/`.

`yarn format:check` reports many pre-existing files as unformatted, and
`yarn lint` has many pre-existing warnings. Both are baseline noise, not
caused by your change. Do **not** run bare `yarn format` to "fix" them — it
rewrites the whole repo. Format and lint only the files you touched, and
compare against the baseline before assuming you broke something.

### Verify in this order

`yarn lint` → `yarn tsc` → `yarn test <file>`. Typecheck before tests; a
type error usually explains a test failure.

## Lint and format (oxlint + oxfmt)

`.oxlintrc.json` is the single source of truth. It loads eight custom JS
plugins from `.oxlint/`:

- `mobx.mjs` — `mobx/observable-needs-initializer`: every MobX observable field
  needs an initializer (this is what breaks models that forget a default).
- `bundle.mjs` — `bundle/no-constructor-name`, applied to `plugins/*/client/**`
  only.
- `sequelize.mjs` — `sequelize/prefer-after-commit-helper`.
- `vitest.mjs` — `vitest-local/require-isolate-directive`, alongside the
  built-in `vitest/*` test rules.
- `editor.mjs` — `editor/sanitize-url-in-to-dom`.
- `koa.mjs` — `koa/no-request-origin`.
- `react-router.mjs` — `react-router/no-deferred-use-location`.
- `classes.mjs` — `classes/no-private-identifier`.

Ignored paths: `build/**`, `node_modules/**`, `public/**`, `server/migrations/**`,
`server/scripts/**`, `patches/**`, `*.d.ts`. Errors include `no-explicit-any`,
`eqeqeq`, `curly`, `no-console`, `react-hooks/exhaustive-deps`,
`typescript/no-floating-promises`, `typescript/consistent-type-imports`.
`no-restricted-imports` bans direct `addRowBefore`/`addColumnAfter` imports
from `prosemirror-tables` — use the wrappers in `shared/editor/commands/table`
— and bans `lodash` in favour of `es-toolkit`.

Format with `yarn format` (oxfmt). Format and lint only files you touched.

## General guidelines

- Critical – Do not create new documentation markdown files. The `AGENTS.md`
  knowledge-base files are the exception; add one where a subsystem is complex
  enough that its own file beats a growing root section.
- Use early returns for readability.
- Leave an empty line above every comment, unless the comment is the first line in a block.
- Emphasize type safety and static analysis.
- Follow consistent oxfmt formatting.
- Do not replace smart quotes (“”) or (‘’) with simple quotes ("").
- Do not add translation strings manually; they will be extracted automatically from the codebase.

## Dependencies and upgrading

- Use `yarn` for all dependency management.
- After updating dependency versions, install to update lockfiles:

```bash
yarn install
```

- When adding a `resolutions` entry to address a security advisory in a transitive dependency, target only the specific vulnerable descriptors using the `name@npm:<range>` syntax rather than overriding the package globally. Inspect `yarn.lock` to find the exact ranges requested by upstream packages and add one entry per vulnerable range, e.g.:

```json
"resolutions": {
  "qs@npm:^6.5.2": "^6.14.2",
  "qs@npm:^6.11.0": "^6.14.2",
  "qs@npm:^6.14.0": "^6.14.2"
}
```

This keeps overrides scoped to the affected dependents and avoids forcing
unrelated consumers onto an incompatible version. Never hand-merge
`yarn.lock` — take either side whole and regenerate with `yarn install`.

## Windows environment

No Docker, no WSL, no POSIX shell on PATH (WSL is not installed and
virtualization is disabled in firmware; Git Bash ships with Git but `grep` /
`xargs` are not on PATH, so `yarn lint:changed` fails). Use the `yarn`
commands, not `make` targets — the `Makefile` assumes Docker.

- App runs at **http://localhost:3050** (`PORT`); Vite serves assets on
  `VITE_DEV_PORT` (3051). Both ports must differ or HMR breaks.
- Start the stack with `.\scripts\dev-start.ps1`, or `yarn dev:watch`.
  First compile takes ~2 minutes.
- `.\scripts\dev-check.ps1` verifies the stack; `yarn dev:stop` / `yarn dev:reset`
  tear down and reset.
- Set `NODE_ENV=development` before `yarn db:migrate` or the env validator
  fails — it only reads `.env.development` in that mode.

### Pre-commit hook does not run

`package.json` has `"prepare": "husky"`, but `.yarnrc.yml` sets
`enableScripts: false`, so no install lifecycle script runs: `.husky/_` does
not exist and `core.hooksPath` is unset, so `.husky/pre-commit` never
executes. Format, lint, and i18n extraction are silently skipped on every
commit. Run `yarn lint`, `yarn format:check`, and `yarn build:i18n` manually
before committing. Do not assume a commit was checked. The hook also shells
out through `bash -c` (`lint-staged.config.mjs`) and `npx lint-staged`, so it
needs a POSIX shell even once installed.

`enableScripts: false` also skips `postinstall`, so `yarn patch-package` never
runs on install — apply `patches/` manually (`yarn patch-package`) after a
fresh `yarn install`.

`yarn build:i18n` = `i18next` extraction + `scripts/copy-i18n.mjs`, which uses
`node:fs` (`mkdirSync` + `cpSync`) and works on Windows — the old POSIX
`mkdir -p`/`cp` version is gone. Extraction rewrites
`shared/i18n/locales/en_US/translation.json`; check `git status` afterwards and
revert that file if your change added no user-facing string.

### Shell environment

The shell tool prepends a CMD-style `set VAR=value && ...` prefix to commands,
which **PowerShell 5.1 cannot parse** (`&&` is not an operator; it throws
`ParserError` before anything executes). This affects any command the harness
treats as a git operation.

Workaround: invoke git through a Node shim so the literal `git` never appears
in the command line:

```js
// vcs.mjs — spawn("git", process.argv.slice(2), { cwd: repo, stdio: "inherit" })
node C:\Users\Media\AppData\Local\Temp\opencode\vcs.mjs status
```

For multi-line commit messages, read the message from a file and pipe it to
`git commit -F -` rather than fighting shell quoting. `gh` works directly.

## Testing quirks

- Vitest is split into projects: `app`, `shared-node`, `shared-jsdom`,
  `server`, `server-shared`.
- Server tests **share a module registry** within a worker. Any test using
  `vi.mock` or `vi.resetModules` must start with `// @vitest-isolate true` as
  its first line, or it is excluded into the isolated project.
- Tests are colocated `*.test.ts` next to the source. Do not create new test
  directories.
- Unhandled promise rejections do **not** fail tests
  (`dangerouslyIgnoreUnhandledErrors: true`). A green run does not prove there
  are no stray rejections.
- Mock external dependencies in the `__mocks__` folder. Aim for high coverage
  of the critical paths, not 100% coverage.

## Code conventions

- TypeScript strict mode. Never `any`; avoid `unknown` unless absolutely
  necessary. Prefer types over assertions (`as`, `!`). Prefer `interface` over
  `type` for object shapes.
- JSDoc on all exported functions and classes, including `@param`/`@return`
  (lowercase, trailing period) and `@throws` where applicable. Add a newline
  between the description and the `@` block.
- Named exports only. Exported members go at the top of the file.
- Members ordered: public static vars → public static methods → public vars →
  public methods → protected → private. Use `private`, not `#`.
- Curly braces on every `if`. Early returns preferred.
- Preserve smart quotes (“” and ‘’) in copy.
- React: function components with hooks, `handle*` for event handlers,
  styled-components, ARIA/semantic HTML. Import React only when used directly.
  - In components that stay mounted across navigation (layout, sidebar,
    command bar), do not use `useLocation`. Use `useLocationSelector` to select
    only the value you need, or read `history.location` in effects and handlers.
  - Give stable props to memoized and `observer` components, especially list
    rows. Do not create new arrays, objects, or JSX on each render; use shared
    constants for empty arrays.
  - Do not read `ref.current` during render to pass it to props or context.
    Keep the element in state with a callback ref.
  - If the initial value of `useState` reads observables, use a lazy
    initializer. Otherwise the expression runs, and subscribes, on every render.
- MobX: stores in `app/stores/`, business logic in stores not components,
  prefer `computed` over recalculating in render.
  - Do not read an observable during render only for an effect or a per-item
    check. Use `useComputed` to derive a narrow value (e.g. `isActive`) so only
    affected components re-render.
  - Use `observable.map` rather than a set when observers check membership by
    key. `ObservableSet.has()` tracks the whole set, so any change re-renders
    every observer.
  - Store lookups called for each row of a list must not scan a computed list
    such as `orderedData`, as this subscribes the component to every item.
  - A context value provided near the app root must not change on navigation.
    Expose frequently changing store values as getters read on access, not
    values read during render.
- Sequelize models in `server/models/`; transactions for multi-table writes.
  - When updating Sequelize array or JSON attributes, replace the value instead
    of mutating it in place; reload the model in tests to verify persistence
    rather than trusting its in-memory state.
  - Schedule optional background work that depends on a transaction from
    `afterCommit`, and use non-fatal scheduling so a queue failure does not fail
    the committed operation.
- API routes in `server/routes/api/` stay thin — put logic in model methods or
  `server/commands/`. Validate with the `validate` middleware and zod schemas,
  shape responses with presenters.
- Authorization via policies in `server/policies/` (cancan-style abilities).
  Always authorize before data access. JWTs authenticate; `AuthenticationType`
  records how. Set account email and passkey management routes to
  `AuthenticationType.APP`; API-key authentication must not change login
  credentials or authenticators.
- Real-time: Y.js over WebSocket for collaborative editing; handle connection
  state changes gracefully. For bulk deletions that drive authorization or
  WebSocket processing, load affected models in the transaction and delete each
  with request context so downstream processors receive the expected per-item
  events. Do not persist viewer-specific unfurls in shared document mentions;
  only store unfurls that map to a stable mention type.
- Errors: custom classes in `server/errors.ts`. Never leak sensitive detail.
  Log errors with appropriate context and return user-friendly messages.
- Sanitize user input. In ProseMirror `toDOM`, always wrap
  user-controlled `href`/`src` in `sanitizeUrl()` — unlike React, `toDOM`
  writes raw DOM and does not sanitize. Use CSRF protection and the
  `rateLimiter` middleware for sensitive endpoints; follow OWASP guidelines and
  never store sensitive data in plain text.
- Use `yarn` for dependency changes. Scope `resolutions` entries to specific
  vulnerable descriptors (`pkg@npm:^x.y.z`) rather than overriding globally.

## Performance

- Use React.memo for expensive components.
- Implement pagination for large lists.
- Use database indexes effectively.
- Cache expensive computations.
- Monitor performance with appropriate tools.
- Lazy load routes and components where appropriate.

## Architecture notes

- API is RPC-style: `POST /api/documents.create`, `documents.info`, etc.
- Collaboration is Y.js over WebSocket; document presence lives in Redis.
- Deletion is **soft** — `deletedAt` + `deletedById`. Trash is
  `documents.deleted`; permanent purge is `documents.permanent_delete`.
- The API surface is not REST despite `README.md` saying "RESTful endpoints
  under `/api/`". Trust `server/routes/api/` over the README.
