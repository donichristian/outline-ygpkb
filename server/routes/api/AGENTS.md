# server/routes/api/ — RPC API

**RPC-style, not REST**: every endpoint is `POST /api/<resource>.<action>`
(no path params, no verbs). Client: `app/utils/ApiClient.ts`. Trust this
directory over the README's "RESTful endpoints" claim.

## Anatomy of a resource

Every `<resource>/` typically holds:

- `<resource>.ts` — `router.post("resource.action", ...)` handlers
- `schema.ts` — zod schemas (built on `BaseSchema` from `routes/api/schema.ts`,
  plus derived `Req/Res` types)
- `index.ts` — wires the domain router (`<resource>.routes()`)
- `<resource>.test.ts` — API tests (+ `__snapshots__/`)

## Route middleware stack (in order)

`auth()` → `rateLimiter(RateLimiterStrategy.…)` → `validate(Schema)` (sets
`ctx.input`) → `transaction()` (sets `ctx.state.transaction`) → handler.

Handler shape: `authorize(user, "action", model)` (from `server/policies/`) →
call a `server/commands/` function → respond
`{ data: await present<Model>(ctx, model), policies: presentPolicies(user, [model]) }`.

## Middleware registration (`index.ts`)

requestContext → koa-body (multipart) → cleanupMultipartFiles → coalesceBody →
userAgent → requestTracer → `apiResponse` → `apiErrorHandler` → editor →
`apiContext` (populates `ctx.input`, `ctx.context`) → `verifyCSRFToken` →
**plugin `Hook.API` routes** → built-in domain routers.

Plugins are registered **before** built-ins so they can override endpoints.
Unknown paths raise `NotFoundError`.

## Conventions

- Keep handlers thin — logic belongs in `server/commands/` or model methods.
- Validate bodies with zod via `validate(...)`; never read `ctx.request.body`
  directly.
- Authorize before touching data. Responses embed per-object abilities via
  `presentPolicies` so the client can gate UI.
- Update `schema.ts` alongside the handler; the client types are derived from it.

## Gotchas

- Migrations are plain `.js` in `server/migrations/`; run `yarn db:migrate`
  directly — no build step.
- Route types come from `router.post(".name", ...)` string keys, matched by
  `ApiClient` — renaming an action is a breaking API change.

## Hot files

`documents/documents.ts` (+ `schema.ts`) · `collections/collections.ts` ·
`users/users.ts` · `shares/shares.ts` · `groups/groups.ts`
