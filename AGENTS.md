# AGENTS.md

Guidance for AI agents working in this repository.

**This is a fork of [Outline](https://github.com/outline/outline)** with local
Windows-native development tooling. Upstream conventions still apply; the
fork-specific parts are called out below.

Read these before working here:

- `docs/TECHNICAL-GUIDE.md` — Windows setup, ports, DB/Redis, troubleshooting
- `docs/ARCHITECTURE.md` — upstream architecture
- `docs/NON-TECHNICAL-GUIDE.md` — non-engineering overview

## Where to look

| Task | Location | Notes |
|------|----------|-------|
| Frontend feature/bug | `app/` | React 19 SPA, MobX stores, react-router v5. See `app/AGENTS.md`. |
| API endpoint | `server/routes/api/<resource>/<resource>.ts` | RPC-style `POST /api/x.y`. See `server/AGENTS.md`. |
| DB model / soft-delete | `server/models/*.ts` + `models/helpers/` | Sequelize. See `server/models/AGENTS.md`. |
| Multi-step write workflow | `server/commands/` | Cross-model orchestration (create/move/import). |
| Authorization rule | `server/policies/*.ts` | cancan-style; one file per model. |
| Rich-text editor | `shared/editor/` | ProseMirror. See `shared/editor/AGENTS.md`. |
| Shared types/utils | `shared/` | Used by both app + server. See `shared/AGENTS.md`. |
| Third-party integration | `plugins/<name>/` | `server/` + `client/` split. See `plugins/AGENTS.md`. |
| Background job / queue | `server/queues/` | Bull tasks + processors. See `server/queues/AGENTS.md`. |
| Command bar / context menu action | `app/actions/definitions/` | Definitions consumed by menus + kbar. |

## Subdirectory knowledge base

This file is the root of a hierarchy. Load the child file nearest the code you
touch (children never restate parent content):

- `app/AGENTS.md` — SPA structure, stores, models, routing, conventions
- `app/stores/AGENTS.md` — MobX store patterns
- `app/components/AGENTS.md` — shared component library
- `app/scenes/AGENTS.md` — route-level pages
- `server/AGENTS.md` — Koa app, boot, request flow, commands/policies
- `server/models/AGENTS.md` — Sequelize models + base classes
- `server/routes/api/AGENTS.md` — RPC route conventions
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
├── plugins/      23 integrations, each server/ + client/ (slack, github, …)
├── scripts/      Windows dev launchers (dev-start/check/stop/reset.ps1, dev.js)
├── docs/         Technical + architecture guides
├── build/        GENERATED — never edit or commit
└── server/migrations/   307 Sequelize migrations (compiled before db:migrate)
```

## Path aliases (critical for crawling imports)

Defined in `tsconfig.json`; **duplicated** in `vitest.config.ts`, `vite.config.ts`
(only `~` and `@shared`), and `.swcrc`. Keep all in sync.

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
yarn lint                # oxlint, type-aware
yarn format              # oxfmt (write); yarn format:check to verify
yarn tsc                 # typecheck — use --incremental false as CI does
yarn test path/to/x.test.ts   # single file (preferred)
yarn test:app  test:server  test:shared
yarn build:server        # required before db:migrate (compiles TS migrations)
yarn db:migrate          # needs NODE_ENV=development set
yarn db:create-migration --name my-migration
```

`yarn test` runs with `TZ=UTC`. Server tests need PostgreSQL and Redis on
`127.0.0.1` (`outline-test` database, `.env.test`).

Pre-commit runs `oxfmt`, `oxlint --fix`, and `yarn build:i18n` on staged
JS/TS via Husky + lint-staged. Translation strings are **extracted
automatically** — never hand-edit `shared/i18n/locales/`.

`yarn format:check` currently reports ~2601 pre-existing files as
unformatted, and `yarn lint` has many pre-existing warnings. Both are
baseline noise, not caused by your change. Do **not** run bare `yarn format`
to "fix" them — it rewrites the whole repo. Format and lint only the files
you touched, and compare against the baseline before assuming you broke
something.

### Verify in this order

`yarn lint` → `yarn tsc` → `yarn test <file>`. Typecheck before tests; a
type error usually explains a test failure.

## Windows environment

No Docker, no WSL, no bash (WSL is not installed and virtualization is
disabled in firmware). Use the `yarn` commands, not `make` targets — the
`Makefile` assumes Docker.

- App runs at **http://localhost:3050** (`PORT`); Vite serves assets on
  `VITE_DEV_PORT` (3051). Both ports must differ or HMR breaks.
- Start the stack with `.\scripts\dev-start.ps1`, or `yarn dev:watch`.
  First compile takes ~2 minutes.
- `.\scripts\dev-check.ps1` verifies the stack; `yarn dev:stop` / `yarn dev:reset`
  tear down and reset.
- Set `NODE_ENV=development` before `yarn db:migrate` or the env validator
  fails — it only reads `.env.development` in that mode.

### Husky is not installed

`core.hooksPath` is unset and `.husky/_` does not exist, so **the pre-commit
hook does not run** — format, lint, and i18n extraction are silently skipped
on every commit. Run `yarn lint`, `yarn format:check`, and `yarn build:i18n`
manually before committing. Do not assume a commit was checked.

`yarn build:i18n` also **fails on Windows** (`command not found: mkdir`): the
`copy:i18n` script uses `mkdir -p` and `cp`, which need a POSIX shell. It
partially writes `shared/i18n/locales/en_US/translation.json` with CRLF churn
before erroring. Check `git status` after running it and revert that file if
your change did not add or modify any user-facing string.

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

## Code conventions

- TypeScript strict mode. Never `any`; avoid `unknown`. Prefer types over
  assertions (`as`, `!`).
- JSDoc on all exported functions and classes, including `@param`/`@return`
  (lowercase, trailing period) and `@throws` where applicable.
- Named exports only. Exported members go at the top of the file.
- Members ordered: public static vars → public static methods → public vars →
  public methods → protected → private. Use `private`, not `#`.
- Curly braces on every `if`. Early returns preferred.
- Preserve smart quotes (“” and ‘’) in copy.
- React: function components with hooks, `handle*` for event handlers,
  styled-components, ARIA/semantic HTML. Import React only when used directly.
- MobX: stores in `app/stores/`, business logic in stores not components,
  prefer `computed` over recalculating in render.
- Sequelize models in `server/models/`; transactions for multi-table writes.
- API routes in `server/routes/api/` stay thin — put logic in model methods or
  `server/commands/`. Validate with the `validate` middleware and zod schemas,
  shape responses with presenters.
- Authorization via policies in `server/policies/` (cancan-style abilities).
  Always authorize before data access.
- Errors: custom classes in `server/errors.ts`. Never leak sensitive detail.
- Sanitize user input. In ProseMirror `toDOM`, always wrap
  user-controlled `href`/`src` in `sanitizeUrl()` — unlike React, `toDOM`
  writes raw DOM and does not sanitize.
- Use `yarn` for dependency changes. Scope `resolutions` entries to specific
  vulnerable descriptors (`pkg@npm:^x.y.z`) rather than overriding globally.

## Architecture notes

- API is RPC-style: `POST /api/documents.create`, `documents.info`, etc.
- Collaboration is Y.js over WebSocket; document presence lives in Redis.
- Deletion is **soft** — `deletedAt` + `deletedById`. Trash is
  `documents.deleted`; permanent purge is `documents.permanent_delete`.
- The API surface is not REST despite `README.md` saying "RESTful endpoints
  under `/api/`". Trust `server/routes/api/` over the README.