# server/ — Koa + Sequelize + Bull

Backend for the Outline fork. RPC-style API, soft-delete by default, audit
events on every write, Y.js collaboration, Bull queues.

## Entry points & boot

- `index.ts` — `throng` process supervisor. `master()` runs pending-migration
  check + env print only; the heavy model graph loads lazily in workers via
  `import("./main")`. Count: 1 for worker-only, else `WEB_CONCURRENCY`.
- `main.ts` — `start(id, disconnect)`: load plugins, build Koa + http/https,
  install `helmet`/`onerror`/rate limiter/`/_health`, then init each service in
  `env.SERVICES` from `services/index.ts`.
- `services/` (lazily imported): `web` (mounts API/MCP/auth/oauth/SPA),
  `worker` (Bull), `cron` (CronTasks), `collaboration` (Hocuspocus `/collaboration`),
  `websockets` (Socket.IO `/realtime`), `admin` (Bull Board, prod-blocked).
- `env.ts` — 895-line zod-validated config, single source of truth.

## Structure

```
server/
├── routes/       api/ (RPC), auth/, oauth/, mcp/, discovery/, app.ts → routes/api/AGENTS.md
├── models/       Sequelize models + base/ + helpers/ → models/AGENTS.md
├── commands/     Cross-model write workflows (documentCreator, documentMover…)
├── policies/     cancan-style abilities, one file per model
├── presenters/   Serialize model → API shape; policy.ts serializes abilities
├── middlewares/  authentication, validate, transaction, rateLimiter, csrf, csp…
├── queues/       Bull tasks + processors → queues/AGENTS.md
├── services/     Bootable modes (web/worker/cron/collaboration/websockets/admin)
├── collaboration/ Hocuspocus Y.js extensions
├── storage/      database.ts (Sequelize + Umzug), redis.ts, requestContext.ts
├── migrations/   307 migrations (compiled by build:server before db:migrate)
├── emails/       Templates + mailer.tsx
├── utils/        66 helpers (startup, PluginManager, ssl, jwt, ShutdownHelper…)
└── converters/   Import/export formats (Docx, PDF, CSV, TextPack)
```

## Request flow (example: documents.create)

`routes/api/index.ts` middleware order: requestContext → koa-body → coalesceBody
→ userAgent → requestTracer → **apiResponse** → **apiErrorHandler** → editor →
**apiContext** (sets `ctx.input`) → verifyCSRFToken → plugin `Hook.API` →
domain routers. Per-route: `auth()` → `rateLimiter()` → `validate(zodSchema)` →
`transaction()` → handler. Handler authorizes via `policies` → calls a
`commands/` function → responds with `present<Model>(ctx, model)` +
`presentPolicies(user, [model])`.

## Conventions

- **RPC, not REST**: `POST /api/<resource>.<action>`. Trust `routes/api/`.
- **Writes must thread a context**: use `model.saveWithCtx(ctx, …)` /
  `createWithCtx` / `destroyWithCtx` — raw `.save()/.create()` skips the audit
  `Event` row. Events need `ctx.state.transaction` and `ctx.ip`.
- **Authorize before data access** (`server/policies/`). Routes stay thin;
  logic goes in model methods or `commands/`.
- **Validate** with `validate(schema)` middleware; zod schemas in
  `routes/api/<resource>/schema.ts`. Shape responses with `presenters/`.
- **Soft delete everywhere** (`deletedAt`/`deletedById`); hard purge only via
  specific commands/tasks.
- Errors: custom classes in `errors.ts`; never leak sensitive detail.

## Gotchas

- `build/` is generated — never edit/commit. `yarn build:server` compiles TS
  migrations before `db:migrate`.
- `db:migrate` requires `NODE_ENV=development`.
- Server tests share a module registry per worker — any test using `vi.mock` /
  `vi.resetModules` must start with `// @vitest-isolate true`.

## Hot files

`routes/api/documents/documents.ts` (2088) · `models/helpers/ProsemirrorHelper.tsx`
(1532) · `models/Document.ts` (1521) · `models/helpers/DocumentHelper.tsx` (1292) ·
`models/Collection.ts` (1045) · `env.ts` (895)
