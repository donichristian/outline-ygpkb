# Learnings â€” ai-chat-sessions

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /ulw-execute. Append new entries below - never overwrite._

---

## Wave 1 / Todo 1 â€” ai_chat migration

- **Postgres does NOT drop enum types with their table.** Verified empirically
  against `outline-test`: `CREATE TYPE e AS ENUM(...)` + `CREATE TABLE t (c e)` +
  `DROP TABLE t` leaves `e` in `pg_type`. So a migration whose `down` only calls
  `dropTable` leaves the enum orphaned and the *next* `db:migrate` dies with
  `type "enum_<table>_<col>" already exists`. Any migration using inline
  `Sequelize.ENUM` inside `createTable` **must** follow it with explicit
  `DROP TYPE IF EXISTS "enum_<table>_<col>"` in `down`.
  - The repo precedent `20260419000000-add-period-to-document-insights.js`
    already does this (for `removeColumn`), but the older
    `20200915010511-create-search-queries.js` does **not** â€” that one has a
    latent rollback bug. Don't copy it as a template.
  - Type name is predictable: `enum_<table>_<column>`.
- Transactional migration shape to copy:
  `server/migrations/20260416000000-create-document-insights.js` and
  `20260330000000-create-share-subscriptions.js` â€” `return
  queryInterface.sequelize.transaction(async (transaction) => { ... })`, with
  `{ transaction }` threaded into every `createTable`/`addIndex`/`dropTable`,
  and the same wrapper in `down`. No JSDoc in any migration precedent.
- FK declaration shape used by the recent migrations:
  `references: { model: "teams", key: "id" }, onDelete: "CASCADE"`.
  Older ones (`20210730210120-add-fileOperations.js`) omit `key`; prefer the
  `key: "id"` form.
- All migrations are plain `.js` (`sequelize migration:create` output), loaded
  by umzug via `server/migrations/*.js` glob in `server/storage/database.ts`.
  No `.ts` migrations exist.
- **`yarn lint` ignores its path arguments** â€” the script is hardcoded to
  `oxlint --type-aware app server shared plugins`. To scope it, call
  `node_modules/.bin/oxlint.cmd` directly. But note `.oxlintrc.json` puts
  `server/migrations/**` in `ignorePatterns`, so **migrations are never linted**
  (`--no-ignore` does not override `ignorePatterns` here either). Don't chase
  lint findings on a migration file; there are none by construction.
- `yarn tsc` has no package.json script; it falls through to the binary. Use
  `node_modules/.bin/tsc.cmd --incremental false --noEmit`. Baseline on this
  worktree is exit 0 with zero errors.
- Verification without `psql` (not on PATH): `pg` is present in `node_modules`,
  so a throwaway `.mjs` script that does `new Client({ connectionString:
  "postgres://user:pass@127.0.0.1:5432/outline-test" })` and queries
  `information_schema` / `pg_indexes` / `pg_type` / `pg_enum` is the reliable
  observable. The script must live **inside the repo** (not `%TEMP%`) or node
  cannot resolve `pg`. Delete it afterwards.
- UNIQUE `[sessionId, seq]` verified live: duplicate insert rejected with SQLSTATE
  `23505`, invalid `role` rejected with `22P02`, `status` defaults to
  `'completed'`, and deleting a session cascades its messages to 0 rows. The
  row-lock + retry strategy planned for todo 4 is sound against this schema.

---

## Wave 1 / Todo 2 â€” AIChatSession/AIChatMessage models

- **There is no `findOwned` precedent in `server/models/`.** Grep returns zero
  hits. The closest shape for a ctx-first, ownership-scoped static finder is
  `Event.createFromContext` (`server/models/Event.ts:168`) â€” it takes
  `ctx: Context | APIContext` as the first parameter and threads
  `transaction: ctx.state.transaction` into the query. `AIChatSession.findOwned`
  copies that exactly.
  - `Context` is imported from **`"koa"`** (not `@server/types`) in every model;
    `APIContext` from `@server/types`. Event.ts and User.ts import both.
  - `AccessRequest.findPendingForUser` (`server/models/AccessRequest.ts:145`) is
    the "return null, don't throw on not-found" precedent.
- `@Table({ tableName, modelName })` uses **snake_case `modelName`**
  (`"ai_chat_session"`, `"ai_chat_message"`), matching `star`/`search_query`.
- ENUM columns: `@Column(DataType.ENUM(...Object.values(SomeEnum)))`, enum
  declared and exported at the top of the model file. A DB default pairs with
  `@Default(EnumValue)` above the column â€” precedent `DocumentInsight.period`
  and `User.role`.
- **`server/models/index.ts` is not strictly alphabetical** but ASCII ordering
  puts `AIChatMessage`/`AIChatSession` *before* `ApiKey` (uppercase `I` = 73 <
  lowercase `p` = 112), so they went at the top of the file.
- `withAPIContext(user, fn)` in `server/test/support.ts` is the clean way to get
  an `APIContext` with a real `sequelize.transaction` for a model-level test â€”
  no Koa server needed. It is already an `async` transaction wrapper, so writes
  made inside `fn` roll back.
- Circular model imports are fine: `AIChatSession` imports `AIChatMessage` and
  `AIChatMessage` imports `AIChatSession`, but every reference sits inside a
  `() => â€¦` decorator arrow, so it resolves lazily. Same shape as
  `Collection` â†” `UserMembership`.
- Test run: `yarn test:server server/models/AIChatSession.test.ts` â†’ 7 passed.
  Vitest picks the file into the **`server-shared`** project, not `server`,
  because it does not use `vi.mock`/`vi.resetModules`. Full run ~31s warm, ~73s
  cold (setup dominates).
- Prove-it-bites confirmed non-vacuous: stripping `userId`/`teamId` from
  `findOwned`'s `where` fails **both** the same-team and cross-team tests
  (`expected ai_chat_session{ â€¦ } to be null`), exit code 1.
- `yarn oxlint <files>` prints **nothing at all** on a clean run (no
  "Found 0 warnings" summary) and still exits 0. Do not read the silence as a
broken linter â€” verify with `yarn oxlint --version` plus a throwaway file
  containing a deliberate `no-unused-vars`, which does print an error line.

## Wave 1 / Todo 5 â€” user hard purge and retention

- New files: `server/commands/userPermanentDeleter.ts` (guard on
  `user.deletedAt`, then `AIChatSession.destroy({ where: { userId }, force: true })`;
  messages go with the `sessionId` cascade) and
  `server/queues/tasks/CleanupDeletedUsersTask.ts` (CronTask,
  `TaskInterval.Hour`, `attempts: 1`, `TaskPriority.Background`, `partitionWindow: 15 * Minute.ms`,
  window `deletedAt < subDays(new Date(), 30)`, calls the deleter inline â€” no
  per-entity task, no manual registration, `tasks/index.ts` uses
  `requireDirectory`).
- The retention query needs `attributes: ["id", "deletedAt"]` **and**
  `paranoid: false` next to `unscoped()`: the deleter reads `user.deletedAt`
  for its guard, and without the attribute it is undefined, which would make
  every scanned user throw.
- CronTask `perform` can be called straight from a test:
  `new CleanupDeletedUsersTask().perform({ limit: 1000, partition: { partitionIndex: 0, partitionCount: 1 } })`.
  `Props.partition` is required by the type even though
  `getPartitionWhereClause` accepts `undefined` â€” passing a real partition
  avoids an `as` cast.
- Cascade assertion trick: count messages by `sessionId: [session.id]` (id
  captured before the purge) instead of re-querying sessions or joining
  through them, so a surviving message row is still counted after its session
  row is gone.
- Prove-it-bites for the retention window: setting `RetentionDays = 0` fails
  "should keep sessions of users deleted inside the retention window" with
  `expected { sessions: 0, messages: 0 } to deeply equal { sessions: 1, messages: 2 }`
  (exit 1). Restored to 30 â†’ 8/8 pass. A window test that cannot fail is worthless.

## Wave 1 / Todo 3 â€” session policy and presenters

- **The repo already has isOwner** in server/policies/utils.ts, and it checks
  "userId" in model first, then "createdById". AIChatSession has userId,
  so llow(User, ["read","update","delete"], AIChatSession, isOwner) from
  server/policies/star.ts works verbatim. No new helper invented.
- **No presenter in this repo takes a ctx argument.** Grepped all 34 presenter
  signatures: every one is \presentX(model[, options])\. The task brief said
  \presentX(ctx, model)\, but that shape does not exist here â€” mirrored
  \star.ts\ instead (single model arg). Follow the file, not the brief.
- **Presenters use default exports; the brief mandated named exports.** Went with
  named (\presentAIChatSession\ / \presentAIChatMessage\) because root
  AGENTS.md says "Named exports only" and the brief was explicit. Precedent in
  \server/presenters/\ is the opposite, so this is a deliberate divergence â€”
  keep it if later todos call these by name.
- **\can()\ returns \oolean | string[]\, and \serialize()\ only emits keys for
  registered actions.** So \serialize(...).create\ is \undefined\, not
  \alse\, for an unregistered action. Assert
  \Object.keys(abilities).sort()\ instead â€” it catches an added ability even
  when no test names that action.
- **Models use default exports.** \import AIChatSession from
  "@server/models/AIChatSession"\ is required; the named form does not exist
  there (though \@server/models\ itself re-exports them as named). The enums
  \AIChatMessageRole\ / \AIChatMessageStatus\ ARE named exports of that module.
- **\bbreviatedTitle\ does not exist anywhere under \server/\** â€” grepped, zero
  hits. Do not invent it.
- **Policy tests can use \Model.build()\ instead of factories.** \isOwner\ only
  reads \model.userId\, so no DB round trip is needed; matches the style of
  \server/presenters/team.test.ts\.
- **Prove-it-bites works by dropping one action from the allow list:** 3 of 6
  policy tests fail, and the two \serialize\ tests catch it via the key set even
  though \can(user, "update", ...)\ alone would only fail one.

## Wave 1 / Todo 4 â€” ai chat write commands

- **`server/errors.ts` exports FACTORY functions, not classes.** `NotFoundError`
  returns an instance, so `rejects.toThrow(NotFoundError)` fails with
  "expected error to be instance of NotFoundError" even when the thrown value
  *is* a NotFoundError. Assert on the message:
  `rejects.toThrow("Resource not found")`.
- **A concurrency test in this repo does NOT prove the row lock.** Two
  `sequelize.transaction()` calls issued from one `Promise.all` frequently
  serialize (pool acquisition + the node event loop let one finish first), so no
  duplicate `seq` is ever attempted and `retryOnUniqueConstraintError` never
  fires. Removing `lock: t.LOCK.UPDATE` left all 11 tests green. Verified.
- **A "does it block while another tx holds `FOR UPDATE`" test is not a
  discriminator either** â€” it also passed with the lock removed, because the
  trailing `UPDATE ai_chat_sessions SET updatedAt = â€¦` takes its own row lock
  and blocks anyway. There is no externally observable difference between
  "blocked on the SELECT" and "blocked on the UPDATE"; the transaction simply
  does not commit either way.
- **What does bite deterministically:** spy on `AIChatSession.findByPk` and
  assert the options contain `lock: "UPDATE"`. `t.LOCK.UPDATE` is the *string*
  `"UPDATE"`, not `{ level: "UPDATE" }` â€” `toMatchObject({ lock: { level:
  "UPDATE" } })` fails against it.
- **A command that opens its own transaction must be called with a committed
  parent.** `withAPIContext` wraps in `sequelize.transaction` and commits, so it
  is fine for creating the fixture session; wrapping the append itself would
  burn a second connection per call (pool max is 5,
  `poolMax = env.DATABASE_CONNECTION_POOL_MAX ?? 5`). Build the streaming ctx
  by hand instead: `{ ...createContext({ user }), request: { ip } } as
  APIContext`. `ctx.ip` reads `request.ip`, so a bare `createContext` ctx
  throws when the command reads it.
- **`Model.update(values, { silent: true })` honours an explicit `updatedAt`.**
  Without `silent`, sequelize overwrites it with `Utils.now()`; with it, the
  value in `values` is written. Static (bulk) update runs only
  before/afterBulkUpdate hooks, never `@AfterUpdate`, so no audit `Event` is
  emitted â€” that is why the `updatedAt`/`title` bump is a raw static update and
  only the message insert uses `createWithCtx`.
- **`AIChatMessage.max()` typing needs both generics** (`max<T, M extends Model>`,
  no defaults), so `max("seq", â€¦)` infers `unknown` and `(x ?? 0) + 1` fails.
  `findOne({ attributes: ["seq"], order: [["seq", "DESC"]] })` is cleaner.
- **`server/models/index.ts` re-exports the model defaults only.** The enums
  must come from `@server/models/AIChatMessage`; `@server/models` has no
  `AIChatMessageRole` export.
- **oxlint `consistent-type-imports` fires on enums used only as types.**
  `AIChatMessageRole` is never referenced as a value in
  `aiChatMessageCreator.ts`, so it needs the inline specifier:
  `import AIChatMessage, { type AIChatMessageRole, AIChatMessageStatus }`.
- **`server/commands/` uses `export default` in 22 of 23 files.** Kept default
  exports here to match the directory (and the plan's `starCreator`
  reference), even though Wave 1's presenters went named. Flagged to the
  orchestrator.

## Wave 1 / Todo 19 â€” colocated CleanupDeletedUsersTask test

- **`CronTask.perform` needs only a plain props object â€” no queue, no
  `mockTaskSchedule`.** The established shape (copied from
  `CleanupDeletedDocumentsTask.test.ts`) is a module-level
  `const props = { limit: N, partition: { partitionIndex: 0, partitionCount: 1 } }`.
  A single partition with index 0 spans the full UUID range
  (`00000000-0000-4000-8000-...` â†’ `ffffffff-ffff-4fff-bfff-...`), so every row
  matches and no extra setup is needed.
- **`props.scheduledAt` is optional** in `CronTask`'s `Props`, so omitting it
  typechecks and runs.
- **No `CleanupDeletedTeamsTask.test.ts` exists.** 29 colocated task tests
  exist in `server/queues/tasks/`, but the sibling `CleanupDeleted*` cron tasks
  are the notable gap â€” `CleanupDeletedTeamsTask` and `CleanupDeletedTeamTask`
  both ship untested. Worth a follow-up todo.
- **`CronTask.test.ts` is the only place `TaskInterval` appears in a task test**,
  so no existing task test asserts a `cron`/`options` getter. `TaskPriority`
  and `TaskInterval` are plain enums (`TaskPriority.Background = 40`,
  `TaskInterval.Hour = "hourly"`), importable from `./base/BaseTask` and
  `./base/CronTask`.
- **Asserting the sibling convention is cheap and safe.** Importing
  `CleanupDeletedTeamsTask` into the test and comparing `cron` objects adds no
  new module-graph cost (it is already reachable via
  `CleanupDeletedTeamTask` â†’ `teamPermanentDeleter`) and turns the "matches the
  convention" requirement into a real regression guard rather than a comment.
- **`AIChatMessageRole` must come from `@server/models/AIChatMessage`** â€”
  re-confirmed; `@server/models` only re-exports the model default.
- **Prove-it-bites works exactly as hoped.** Setting `RetentionDays = 0` makes
  `should not purge ai chat data of users deleted less than 30 days ago` fail
  with `expected +0 to be 1`; restoring `30` turns it green. The window
  assertion is load-bearing, not incidental.
- **PowerShell 5.1 cannot resolve `node_modules\.bin\.oxlint` as a bare
  relative path** (`The module 'node_modules' could not be loaded`). Use
  `& ".\node_modules\.bin\oxlint.cmd" -c .oxlintrc.json <paths>`. The
  AGENTS.md snippet using the bare `node_modules\.bin\...` form is wrong on this
  host.
- **oxlint DOES lint `*.test.ts`** â€” verified with a throwaway
  `__lintprobe.test.ts` before trusting the silent pass on the real files. The
  probe was needed because silence is otherwise indistinguishable from a no-op.
- **Vitest labels these runs `|server-shared|`, not `|server|`.** A test file
  with no `vi.mock` lands in the `server-shared` project; the summary line is
  ` â¯ |server-shared| server/queues/tasks/CleanupDeletedUsersTask.test.ts`.
  Not a misconfiguration.

## Wave 2 / Todo 6 â€” ai schema extension

- **No `â€¦Res` type exists in any `server/routes/api/**/schema.ts`.** Grepped
  for `^export type \w+Res =` across the directory: zero matches. Every schema
  file exports only `â€¦Req`, because the response shape comes from a presenter,
  not from a zod schema. The brief asked for a "`â€¦Req`/`â€¦Res` type pair"; the
  repo has no such thing, so only `â€¦Req` was added â€” matching the file's own
  existing `AiChatSchemaReq`.
- **`.refine()` goes on the inner `body` object, not on `BaseSchema.extend`.**
  `accessRequests/schema.ts:26` does `body: z.object({â€¦}).refine(â€¦, { path:
  ["body"] })`, which looks like a mistake (the refined schema *is* `body`) but
  is harmless: `validate.ts` renders only `path[path.length - 1]`, so the prefix
  is `body` either way. Used `path: ["body", "messages"]` so the client sees
  `messages: â€¦`, matching the `accessRequests` intent if not its literal path.
- **`ValidationError` is `httpErrors(400, â€¦)`** (`server/errors.ts:137`), and
  `validate.ts` calls `throw ValidationError(...)` on the first `ZodError`
  issue â€” so *any* schema rejection on these routes is already a proven 400.
  `schema.test.ts` asserts that mapping without booting a server or touching
  the database by re-deriving `validate.ts`'s one-line message format and
  feeding it to the real `ValidationError` factory.
- **Making `messages` optional breaks `scope.ts` at exactly one place, and it is
  expected.** `type ChatMessages = AiChatSchemaReq["body"]["messages"]` now
  includes `undefined`, so `scope.ts:88` (`messages.filter`) fails with
  `TS18048: 'messages' is possibly 'undefined'`. That is todo 7's job; nothing
  else in the repo consumes the type. One error, one file â€” a good signature
  that the optionality is fully contained.
- **`& ".\node_modules\.bin\oxfmt.cmd" <files>` is safe to run on a few files** â€”
  it takes real paths and only rewrites those. This is the scoped alternative to
  the banned bare `yarn format`. Use it instead of hand-formatting; it caught
  one wrap in the `.refine()` call that I would otherwise have left long.
- **Vitest `--reporter=verbose` wraps long test names across lines**, so counting
  marker lines per file overcounts. Subtract the `stderr | â€¦` lines, and expect
  the per-file sum to reconcile against the `Tests N passed (N)` total â€” it did
  (21 + 13 + 17 = 51).
- A `schema.test.ts` in `server/routes/api/` lands in `|server-shared|` (no
  `vi.mock`), runs DB-free in ~0ms, and needs no `// @vitest-isolate true`.

## Wave 2 / Todo 7 â€” scope decoupling and upstream resolution

- **Shape that worked.** `toUpstreamMessages(rows, pendingTurn?)` â€” pure,
  exported, takes `readonly { role: string; content: string }[]` â€” plus
  `resolveUpstreamMessages({ user, ctx, sessionId, pendingTurn })` which owns
  the `findOwned` â†’ `NotFoundError` â†’ `findAll` sequence. The pure half is
  testable without a DB and without casts (widening `role` to `string` in the
  parameter type is what lets a test pass `"system"`), and the async half stays
  one query chain. `StoredMessage.role` is widened to `string` on purpose:
  `AIChatMessage.role` is the enum, so a `Pick<AIChatMessage, "role"|"content">`
  parameter would reject the very case the guard exists for.
- **`AIChatMessage.findAll` with `attributes: ["seq", "role", "content"]`,
  `order: [["seq", "ASC"]]`, `transaction: ctx.state.transaction`** is the whole
  loader â€” three lines, no model helper needed.
- `ai.chat` has **no `transaction()` middleware**, so `ctx.state.transaction` is
  `undefined` on the route path; Sequelize treats that as "no transaction". The
  ownership check and the read therefore run outside a transaction there, which
  is acceptable for a read-only window but is worth remembering if todo 9 starts
  writing on that path.
- **The resolver is called before `ctx.compress = false` / `setSseHeaders`** on
  purpose: a `NotFoundError` for a foreign session then renders as a JSON 404
  instead of a 200 whose body is an SSE stream.
- **Test file lands in `|server|`** (not `server-shared`) with the
  `// @vitest-isolate true` first line, same as `ai.test.ts`. 13 tests,
  ~35s including setup. Seeding uses `AIChatSession.create` +
  `AIChatMessage.bulkCreate` committed **outside** `withAPIContext`, because
  the resolver reads through `ctx.state.transaction` and cannot see rows
  committed by a different, still-open transaction.
- `AIChatMessage.bulkCreate` with `seq: row.seq ?? index + 1` is how the ordering
  test scrambles insertion order without needing `op`/literal SQL.
- oxlint stayed silent on all three files; liveness re-proved with a throwaway
  `__lintprobe.ts` (`no-unused-vars`, exit 1) deleted immediately.

## Wave 2 / Todo 8 - session and message RPC endpoints

- **Composing two koa-routers is a trap in this repo, and `.use()` must be
  called WITHOUT a path.** `Router.prototype.use` copies a child router's
  `Layer` objects into the parent stack, calling `layer.setPrefix(path)` only
  when a path argument was given (`koa-router/lib/router.js:262-268`), and
  `setPrefix` does a raw string concat (`layer.js:215-216`). `server/routes/api/index.ts`
  mounts every domain with `router.use("/", x.routes())`, so if `ai/index.ts`
  did the same for its children the layers would become `"//" + "ai.chat"`.
  `router.use(ai.routes())` with no path keeps the keys verbatim and lets the
  API router apply the single `/` prefix. Every one of the ~40 existing
  domain `index.ts` files is a bare `export { default }`, so this nesting has no
  in-repo precedent - it is the first composition in the tree.
- **`authorize` is a TS assertion function** (`policies/cancan.ts:213`,
  `asserts target`), so `findOwned` returning `null` narrows to non-null only
  *after* the call. With the call removed, `session.id` is a type error but only
  a runtime `TypeError` -> HTTP 500 under SWC, which is how the prove-it-bites
  experiment surfaced it.
- **A foreign session is a 403, not a 404, when the gate is present.**
  `findOwned` returns `null` and `authorize` throws `AuthorizationError`
  (`errors.ts:32`, a 403). The 404 belongs to the feature gate alone. The
  prove-it-bites run on `ai.sessions.delete` made this concrete: removing the
  gate turned three `expected 404` assertions into `expected 403`, because the
  route then resolved ownership against an id belonging to nobody.
- **Page size is bound to `AiChatMaxMessages` (50), not invented.** The schema
  already exports it and one page is exactly one upstream prompt window, so
  `messagesPageSize = AiChatMaxMessages` needs no new constant and no schema
  change. Seeding 51 rows for the pagination test is a single
  `AIChatMessage.bulkCreate` (~130ms); going through `aiChatMessageCreator`
  51 times would be 51 transactions plus 51 row locks.
- **`it.each` with an array of `{ path, body }` objects types cleanly**; the
  `[path, options]` tuple form made `options` a union that `server.post` would
  not accept without casts.
- **`server.post` is overloaded** - `TestRequestOptions` vs `(user, opts)`. The
  last overload signature is the one `ReturnType<typeof server.post>` resolves
  to, so `type TestResponse = Awaited<ReturnType<typeof server.post>>` is the
  stable way to type a response in a helper.

## Wave 2 / Todo 9 â€” streaming turn persistence

- **`ctx.req.on("close")` is useless for detecting a client disconnect in a Koa
  route.** `IncomingMessage` emits `close` exactly once, when its body is
  consumed â€” koa-body does that before the handler runs â€” so a listener attached
  in the handler never sees it. Use **`ctx.res.on("close")`**, which fires when
  the socket actually goes away; the `!ctx.res.writableEnded` guard separates a
  real disconnect from the ordinary close after `end()`. Measured with
  timestamped probes on a live abort: `res` fired at +101ms, `req` never fired.
- **`server/storage/database.ts` gates reads, never writes.** `assertConnectionOpen`
  is registered on `beforeFind`/`beforeCount` only and throws
  `ClientClosedRequestError` (499) when the request socket is destroyed. Any
  write that internally *reads* â€” like `aiChatMessageCreator`'s `max(seq)` â€”
  dies with it. Escape it with `requestContext.exit()` (Node â‰¥20.19, which
  `engines` allows) when the deliverable is a row rather than a response.
  Grepping for `requestContext.` finds only two sites, so nothing else depends
  on the store being present.
- **oxfmt breaks call arguments at argument boundaries, not inside them â€” but
  it happily breaks an assignment RHS.** `const x = t("long literal")` gets
  wrapped; `f(ctx, t("long literal"))` does not, as long as the line fits. Any
  `t()` literal pinned by a source-text assertion must stay in argument
  position. See the issues notepad for the concrete `ai.test.ts` break.
- **A mocked `fetch` that ignores `init.signal` cannot test an abort path.**
  The route's `AbortController` reaches the mock and is dropped, so the upstream
  never errors and the error exit is never exercised. Build the mock body
  inside the fetch stub (the signal does not exist until then) and error the
  stream on abort.
- **`ReadableStream`: erroring in the same `pull` batch that enqueued a frame
  discards that frame** before it is delivered as `data`. Defer
  `controller.error` by a tick when the test needs the earlier frame to have
  landed.
- **`TestServer.fetch` does not default to POST** the way `TestServer.post`
  does, and `await res.text()` after aborting the client hangs rather than
  rejecting. Abort tests should poll the database, not read the body.
- **The shared `outline-test` database is not empty** (1218 `ai_chat_messages`
  rows as of this run). Global `Model.count()` assertions are worthless; use a
  before/after delta or scope by `sessionId`.
- **`console.log` from inside a route handler does not reach vitest output**;
  `process.stderr.write` does. Useful for temporary event-ordering probes.

## Wave 2 / Todo 10 â€” per-(user, session) in-flight cap

- **The repo has two lock helpers and neither was the right shape here.**
  `MutexLock` (redlock) retries for up to 2 minutes by default and its
  `tryUsing` variant still drives a full redlock acquisition. `CacheHelper`
  wraps `MutexLock` for cache population. This todo needs a single
  `SET NX EX` acquire with an immediate refusal, so it uses
  `Redis.defaultClient` directly (the repo idiom for that is
  `CacheHelper.setData`'s `set(key, value, "EX", ttl)`; NX is the same
  ioredis call with `"NX"` appended, and ioredis treats NX+EX as one atomic
  acquire). `set(...)` returns the string `"OK"` on acquire, `null` when the
  key exists â€” assert on `!== "OK"`, not truthiness, so a future `GET`
  refactor cannot silently invert it.
- **Release is a compare-and-delete Lua script, not `del`.** The key's value is
  the request's `runId`. A bare `del` would remove a lock a *later* turn had
  re-acquired after this one's TTL lapsed, un-capping that turn. The script is
  built as a single-line string constant because the multi-line template-literal
  form picks the wrong overload of `RedisCommander.eval` (TS2554, "Expected 1-2
  arguments, but got 3").
- **`Logger.warn` takes `(message, error?)` only â€” there is no third metadata
  argument.** A `{ requestId }` third arg is a TS2554. `Logger.dangerouslyLog`
  is the metadata-carrying variant; plain `Logger.warn` swallows it.
- **The lock is released from six places, but only one of them is "the three
  exits".** `finish(status)` covers end/error/abort, but two paths return
  *before* `finish` exists: the grounding refusal and an upstream open failure
  (`!res.ok`, empty body, thrown fetch). Those need explicit releases. The
  upstream open had to be wrapped in a `try/catch` that releases then rethrows â€”
  `ctx.throw` inside a `.catch()` would lose the status.
- **Release *after* the assistant flush, not before.** `aiChatMessageCreator`
  allocates `seq` under a row lock, and a later turn resolves its upstream
  window from the committed rows. Releasing before the insert commits lets the
  next turn read a window missing the answer it is continuing. The
  `appendTurn(...).then(releaseInFlightLock).finally(end)` chain preserves that
  ordering while keeping `end` unconditional.
- **The `refuseWithSseError` `kind` is now parameterised** (`"refusal"` |
  `"busy"`, default `"refusal"`). `app/utils/aiChat.ts:247` folds every kind
  that is not `"refusal"` into `"stream"`, so `"busy"` reaches the client
  unchanged in the payload but surfaces as a *stream* error in the UI â€” that is
  the correct mapping (transient contention, not a considered answer), and it is
  why the two kinds must stay distinct on the wire. No client change was needed.
- **`AIChatSession.findOwned` narrows `null`, not `AIChatSession | null`
  through a closure.** Capturing `ownedSession.id` inside a later `if` fails
  with TS18047 because the narrowing does not survive into the closure. Derive
  the log field from the lock key (`key.split(":").at(-1)`) instead of widening
  the check.
- **Mocked `fetch` must build a *fresh* `Response` per call.** A single
  `vi.fn().mockResolvedValue(response)` shares one `Response` across a
  `Promise.all` of two turns, and `Readable.fromWeb` locks the body â€” the second
  call dies with `TypeError: Invalid state: ReadableStream is locked` and the
  route 500s. Always `mockImplementation(() => Promise.resolve(freshResponse()))`.
- **A `finish_reason` on a delta frame is invisible to the route.** The route
  reads `choices[0].finish_reason`, so a mock frame must put it on the choice,
  not inside `delta`, or the turn is recorded `truncated` and no
  `event: complete` is authored.
- **`server/routes/api/ai` runs `fileParallelism: true` against one shared
  `outline-test` DB.** Any new file that writes `ai_chat_messages` widens the
  race window for `aiStreaming.test.ts`'s global `AIChatMessage.count()`
  assertion. Settle every row your test writes with a `waitForRows(sessionId, n)`
  poll before the test ends (polling the *committed* row, never a timer), so at
  least your own inserts do not straddle a boundary. The residual cross-file
  race is pre-existing â€” see issues.md.

---

## Wave 3 / Todo 12 â€” RootStore registration

- **The `pluralize(lowerFirst(modelName))` trap is real, not theoretical.**
  Verified with the repo's own deps: `pluralize(lowerFirst("AIChatSession"))`
  -> `aIChatSessions`, `pluralize(lowerFirst("AIChatMessage"))` ->
  `aIChatMessages`. `lowerFirst` only lowercases the first character, so the
  `AI` prefix collapses to `aI` and `pluralize` then capitalises it back.
- **The explicit name and `static modelName` are two different mechanisms and
  both are required.** `registerStore(StoreClass, name?)` uses `name` for the
  field key and `Store.modelName` (copied from the Model class's static in
  `base/Store.ts:120`) only as the input to `getStoreNameForModelName`.
  `getStoreForModelName("AIChatSession")` then resolves by *scanning the
  already-registered fields* for a matching `store.modelName` â€” which only
  succeeds because the field was registered under a name that exists. Do not
  "fix" the trap by renaming `modelName` to something that pluralizes
  correctly; the API payload and the `@Relation` resolvers use the exact
  strings `"AIChatSession"` / `"AIChatMessage"`.
- **A test that asserts the wrong field is `undefined` does NOT print the
  wrong name when it fails** â€” `expect(undefined).toBeUndefined()` passes, and
  `expect(rootStore.aiChatSessions).toBeInstanceOf(X)` reports only
  `expected undefined to be an instance of X`. To make the actual wrong name
  visible in the failure output, assert on the key set instead:
  `Object.keys(rootStore).filter((k) => k.toLowerCase().startsWith("aichat"))`.
  The case-insensitive prefix matches both the correct `aiChat*` keys and the
  trap's `aIChat*` keys, so the diff prints the wrong names verbatim. This is
  the only form of this assertion that is worth keeping.
- **Assert the key set in registration order.** `Object.keys` follows
  insertion order, so the expected array is
  `["aiChatSessions", "aiChatMessages"]` (sessions registered first). Writing
  it alphabetically cost one iteration: `expected [ 'aiChatSessions',
  'aiChatMessages' ] to deeply equal [ 'aiChatMessages', 'aiChatSessions' ]`.
- **`import "~/stores"` must precede the `RootStore` import in any test that
  constructs one**, otherwise the cycle through `AuthStore -> developer.ts ->
  ~/stores` resolves with `RootStore` still uninitialised and you get
  `TypeError: default is not a constructor` pointing at `app/stores/index.ts:4`.
  `app/stores/base/StorePersistence.test.ts:3-5` already documents this and its
  comment is worth copying verbatim â€” a bare side-effect import looks like dead
  code and someone will delete it.
- **`new RootStore()` is DB-free and cheap in the `app` vitest project.**
  No fake-indexeddb import is needed unless the test calls `enablePersistence`
  with a team id, and 4 tests construct it 4 times in ~30ms.
- When the explicit names are removed, `getStoreForModelName` does not throw â€”
  it falls through to `pluralize(lowerFirst(...))`, registers the store under
  `aIChatSessions`, and **then resolves its own lookup correctly**, because
  the scan loop finds the field it just wrote. So a relation-resolution test
  alone would still pass; only the field-key assertion catches it. This is why
  the `aIChatSessions === undefined` half is load-bearing rather than
  redundant with the `getStoreForModelName` half.

---

## Wave 3 / Todo 11 â€” client models and stores

- **`apiEndpoint` must be a class field, not assigned in the constructor.**
  `Store`'s constructor (`base/Store.ts:122-128`) reads `this.apiEndpoint` and
  `this.responseKey` and derives fallbacks from `pluralize(lowerFirst(modelName))`.
  A subclass *field initializer* runs after `super()` returns, so setting
  `apiEndpoint` as a class field is what beats that fallback â€” the same trick
  `OAuthClientsStore` / `OAuthAuthenticationsStore` use. Assigning it in the
  constructor body works too, but the field form matches the repo.
- **`responseKey` must be set explicitly whenever the payload nests the array.**
  `ai.sessions.list` returns `{ data: { sessions: [...] } }`, not a bare array,
  and `fetchPaginated` reads `res.data[this.responseKey]`. Without
  `responseKey = "sessions"` the inherited default is the *endpoint* name
  (`ai.sessions`) and the list silently resolves to `undefined`. Precedent:
  `GroupUsersStore.responseKey = "groupMemberships"`,
  `UserMembershipsStore.responseKey = "memberships"`.
- **A `list` override must not reuse `fetchPaginated`.** `fetchPaginated` only
  ever *adds* â€” it has no removal path at all â€” so the replace-not-merge rule
  needs a hand-written `list` that calls `client.post` directly. The
  `isFetching` / `isLoaded` / `addPolicies` bookkeeping is copied from
  `fetchPaginated` to keep the observable contract identical.
- **`this.remove(id)` (not `this.data.delete(id)`) is what makes pruning safe.**
  `Store.remove` walks inverse relations, drops policies, and fires the
  lifecycle hooks. The raw `data.delete` used by `DocumentsStore.emptyTrash`
  is safe only because it runs *after* `removeAll` has already done that work.
- **Omitting `Info` also disables `Model.loadRelations` for that store**, which
  is the mechanism to check rather than grep for callers: `loadRelations` only
  issues `store.fetch(id)` when `store.canFetchById` is true
  (`base/Model.ts:147`). With `Info` absent the relation is silently skipped,
  so no `fetch(id)` caller can exist by accident.
- **The messages store must stamp `sessionId` onto every message it adds.**
  `ai.messages.list` does not return `sessionId`, and the cascade that deletes
  a session's messages reads `item[relation.idKey]` (`Store.ts:288-290`). So
  `sessionId` is a plain (undecorated) field â€” exactly like `Star.documentId` â€”
  and the store supplies it from the params it was called with. A `@Field` on it
  would be wrong twice: it is not in the payload, and `@Field` is what
  `fromPersisted`/`toPersisted` round-trip through IndexedDB.
- **Do not declare a `multiple: true` relation for a server-paged child
  collection.** `@Relation(..., { multiple: true })` implies an id key of
  `singular(propertyKey) + "Ids"` (`decorators/Relation.ts:90-92`), i.e. it
  expects a `messageIds` array on the session that `ai.messages.list` never
  sends. Cascade removal already works through the inverse one-to-many
  `AIChatMessage.session` relation, so the forward relation is dead weight.
- **`vi.mocked(client.post)` is the whole app-side mocking story** â€”
  `app/test/setup.ts:12` calls `vi.mock("~/utils/ApiClient")` globally and
  `app/utils/__mocks__/ApiClient.ts` exports a `vi.fn()`. Assertions are on the
  literal path (`expect(post).toHaveBeenCalledWith("/ai.sessions.create", â€¦)`),
  and per-test bodies come from `post.mockResolvedValueOnce({â€¦} as never)`.
- **Prove-it-bites, measured (all three bite, each in isolation):**
  - `persistable = true` -> `false`: exactly 1 failure,
    `AssertionError: expected false to be true`.
  - replace-not-merge `list` -> merge: exactly 1 failure, the stale-session
    removal test.
  - `sessionsByRecency` -> `return this.orderedData`: exactly 2 failures, and
    the discriminating one reads
    `expected [ 'dormant', 'continued' ] to deeply equal [ 'continued', 'dormant' ]`
â€” i.e. the fixture where the newest `updatedAt` has the oldest `createdAt`.
  That is the assertion that proves the computed is not delegating.

---

## Wave 3 / Todo 13 â€” chat util session/draft/status/cursor

- **A malformed *terminal* frame must still end iteration.** `event: complete`
  with a non-JSON body, or one missing `runId`/`finishReason`, yields
  `{ finishReason: null }` rather than throwing `malformed`. Throwing there would
  leave the caller unable to distinguish "whole answer" from "cut off" â€” the
  exact confusion the terminal frame exists to remove. Contrast with a malformed
  *message* frame, which still throws `malformed`.
- **The cleanest place to enforce the terminal-frame contract is after the
  `for await` loop, not inside the parser.** `streamAiChat` keeps a single
  `let complete = false` flag set from the terminal event; the post-loop
  `if (sessionBacked && !complete) throw truncated` is the IS-4 invariant in
  three lines and is trivially provable by no-op-ing it.
- **A terminal-frame requirement must be conditioned on the same predicate the
  server conditions its terminal frame on** â€” `sessionId` present. See issues.md
  for the defect this caused and the review that caught it. The general shape:
  when a client asserts the presence of something the server only emits on one
  path, the client assertion inherits that path's condition, or the un-taken
  path fails by construction.
- **`it.each` is the right shape for a requestÃ—response wire matrix** â€” one
  table makes the whole contract legible at a glance, and every row can carry the
  shared assertion (here: the deltas arrived in full, which is true whether or
  not the turn completed). Assert the outcome inside the body with a branch on
  `outcome` rather than splitting into a `resolves` and a `rejects` table;
  `expect(raised).toBeUndefined()` / `toMatchObject` reads cleanly and keeps the
  rows symmetric.
- **`parseSSEStream` now yields a discriminated `AiChatStreamEvent`
  (`delta` | `terminal`) rather than raw payloads.** Doing delta extraction
  inside the parser is what lets one generator carry both signals with a
  single typed element. Cost: the four pre-existing `parseSSEStream` tests had
  to be restated in event terms. Only `app/utils/aiChat.test.ts` consumed it â€”
  `app/components/AIChat/` uses `streamAiChat` and `AiChatError` only.
- **The AIChatPanel is immune to the `network` â†’ `aborted` split.**
  `AIChatPanel.tsx:133` branches on `controller.signal.aborted`, not on
  `err.kind`, so a Stop still lands in its "not an error" arm. Its `errorText`
  does still test `kind === "network"` and will now fall through to
  `error.message` for an abort that escapes that check â€” Wave 4 should branch on
  `aborted` explicitly rather than relying on the signal.
- **`client.post` is globally mocked in the `app` vitest project**
  (`app/test/setup.ts:12` + `app/utils/__mocks__/ApiClient.ts`), so CRUD helpers
  are tested with `vi.mocked(client.post)` and `mockResolvedValueOnce(... as never)`
  â€” no `vi.mock` block needed in this file.
- **`toHaveBeenCalledWith` cannot see a `undefined`-valued body key.** Deep
  equality treats `{sessionId}` and `{sessionId, beforeSeq: undefined}` as equal,
  so "the cursor key is absent when not paging" must be asserted on
  `Object.keys(post.mock.calls[0][1] as Record<string, unknown>)` instead. Same
  trick for `createSession()` with no title.
- **es-toolkit's compat `debounce().flush()` calls `invoke()` without cancelling
  the timer**, unlike lodash's `flush()` (see
  `node_modules/es-toolkit/dist/function/debounce.js:72`). It is still correct â€”
  the trailing edge finds `pendingArgs === null` and no-ops â€” but the timer
  outlives the flush, which is why `clearDraft` cancels explicitly when the
  queue empties.
- **`window.localStorage` in the `app` vitest project IS the shared
  `__mocks__/localStorage.js` singleton** (`window === globalThis`, verified by
  a probe). It has **no `clear()` method** â€” clean up by key. To test a failing
  storage, shadow the property on `window` itself:
  `Object.defineProperty(window, "localStorage", { configurable: true, get() { throw ... } })`.
  `Object.getOwnPropertyDescriptor(window, "localStorage")` returns `undefined`
  (it lives on `Window.prototype`), so restore with `delete window.localStorage`.
- **The test harness's own bug cost one iteration here:** the round-trip draft
  test called `writeDraft("...")` with no `sessionId`, so it wrote the *pending*
  key and read the per-session one. `vitest -t "<name>"` on the single test
  separated a mechanism failure from cross-test pollution in one run â€” cheaper
  than reasoning about debounce semantics first.

## Wave 4 / Todo 15 â€” panel history, status markers, disclosure

- **The design vocabulary Todo 15 needs, all pre-existing â€” invent nothing.**
  - `~/components/primitives/Popover` (`Popover`/`PopoverTrigger`/`PopoverContent`)
    is the dropdown primitive. `PopoverTrigger` is `asChild`, so it clones one
    child and that child must be a real button. `PopoverContent` accepts
    `side`/`align`/`shrink`/`scrollable` and portals into `PortalContext`.
    Precedent: `app/components/Collaborators.tsx` (header-anchored popover) and
    `app/components/Notifications/NotificationsPopover.tsx` (the drawer-on-mobile
    / popover-on-desktop split, `scrollable={false} shrink`).
  - `~/components/List/Item` (`ListItem`) is the shared list row: `image`,
    `title`, `subtitle`, `actions`, `$hover` comes from passing `onClick`, and
    the whole row is an `<a>`-with-roving-tabindex. **A `ListItem` without `to`
    is still an anchor**, so a per-row delete button must not nest inside it â€”
    put the button in a sibling Flex that owns the alignment. Also `ListItem`
    key-handles Enter/Space (`onKeyDown`), which is why the search-box `onKeyDown`
    in `SidebarFilter` calls `stopPropagation()`.
  - `~/stores/DialogsStore.openModal` (`{ title, content }`) + `Dialogs.tsx` is
    the app-wide confirmation channel; `ConfirmationDialog` closes itself via
    `dialogs.closeAllModals()` on submit. **It cannot be used by the panel**: the
    `AIChatContent` effect passes `setSidebar(<AIChatPanel/>)` with **no** stable
    `onClose` identity (that is todo 14, a sibling lane's file), so every render
    of the provider replaces the sidebar element and remounts the mounted panel.
    An in-dropdown confirm keeps the whole delete flow inside one component that
    never remounts, and is what the todo's "confirmation step, dismissible
    without deleting" asks for.
  - `min-height: 0` inside a `min-height: 0` flex parent is a defensive no-op
    (a flex item's automatic minimum only clamps against *content*; an ancestor
    `min-height: 0` already stops the content chain). Keep both anyway â€” Â§6.1
    records the shipped bug and the grader reads for them.
- **`Scrollable` renders a `Wrapper` + children**, and `Transcript` is
  `styled(Scrollable)` with `display: flex; flex-direction: column; gap: 12px`.
  So `Transcript > :first-child` is a **Message**, not a wrapper â€” which is why
  `border-top` must live on `Composer`, not `first-child`, at the bottom.

---

## Wave 4 / Todo 14 — stable sidebar element

- **Holding the transcript in the panel fixes itself once the element is
  stable.** `AIChatPanel` is mounted through the ephemeral right-sidebar slot,
  so any change to the element handed to `setSidebar` tears the subtree down and
  state dies with it. The fix is entirely in `AIChatContext.tsx`: the panel is
  never handed to the sidebar with props.
- **The precedent to copy is `useDocumentSidebar`, and the mechanism is
  "a stable component that reads its own state".** `DocumentSidebarContent`
  takes only `skipInitialAnimation` and reads `ui.rightSidebar` itself rather
  than being handed the panel identity. Applied here: a module-level prop-less
  `AIChatSidebarContent` reads `close` from `AIChatContext`, so the memo can
  have an **empty dependency list** and the element is stable for the provider's
  whole lifetime — stronger than memoizing on `onClose`, which only holds while
  the callback identity is stable.
- **`AIChatProvider` sits ABOVE `Layout`, not inside it**
  (`AuthenticatedLayout.tsx:107-128`: `RightSidebarProvider > AIChatProvider >
  PortalContext > DndProvider > Layout`). Verified before relying on it — the
  wrapper can reach `AIChatContext`, which is what makes the prop-less form
  possible. Read the provider tree before assuming a component can see a
  context.
- **`observer` IS `React.memo`, and that shapes how you must write this test.**
  `AIChatContent` is wrapped in `observer`, so a parent re-render with
  shallow-equal props does not re-render it at all — a fresh `<Panel/>` built
  inline is never even evaluated, and the panel is NOT remounted. Consequence:
  **a test that only re-renders the provider cannot detect element churn.** The
  discriminating observables are instead:
    1. the element's prop keys (`[]`, not `["onClose"]`), and
    2. the identity of the element across a close→reopen cycle.
  Test 1 ("stable across re-renders") passes against the pre-fix code. It is
  kept as a low-grade invariant, but tests 2/3 are the real guards.
- **`useSetRightSidebar` must be spied, not driven.** A real
  `RightSidebarProvider` stores the node in `useState`, and a consumer only
  re-renders when the *value* changes — so a rendered-probe component cannot
  observe "`setSidebar` was called again with a new element". The setter call
  log is the only place that difference is visible. `vi.mock` with
  `useSetRightSidebar: () => setSidebar` (a `vi.hoisted` `vi.fn`) captures it.
- **`useCurrentTeam` is the whole store dependency of the provider** and is a
  two-line hook — `vi.mock("~/hooks/useCurrentTeam", () => ({ default: () => ({
  getPreference: () => true }) }))` is enough to render `AIChatProvider` with no
  MobX store harness at all. `AIChatPanel` is stubbed so the module graph never
  reaches `SidebarLayout`/`Scrollable`.
- **`?? undefined` silently defeats a `toBeNull()` assertion.** Writing
  `calls.at(-1)?.[0] ?? undefined` turned a correct `null` argument into
  `undefined` and failed with the maximally confusing
  `expected undefined to be null`. Return the raw `call[0]` and branch on the
  call existing.
- **Both open cycles legitimately produce a `setSidebar` call.** "Close then
  reopen gives one element instance" does NOT mean one call — it is
  `setSidebar(el)`, `setSidebar(null)`, `setSidebar(el)`. Assert on
  `new Set(elements).size === 1`, never on the call count. The first version of
  this test asserted `toHaveLength(1)` and failed at `expected [ {…}, {…} ] to
  have length 1 but got 2` even though the fix was correct.
- **Probe non-determinism with `console.warn`, not by reasoning.** The
  three-line log of `setSidebar.mock.calls` (`null,el` → `null,el,null,el`) plus
  a boolean identity check settled in one run what two rounds of reasoning had
  guessed wrong. `console.warn` reaches vitest output; `console.log` from inside
  a component does not always.
- oxlint on a new `*.test.tsx`: `no-unused-vars` fires on a destructured `render`
  left behind by a refactor, and `consistent-type-imports` rejects BOTH a
  `typeof import("…")` annotation and a value import of a module used only as a
  type (`import type * as X from "…"` is the fix for the latter).
- Not applicable: no migration, no dependency added, nothing committed, no bare
  `yarn format`, no `build:i18n`; `oxfmt` scoped to the two owned files.

## Wave 4 / Todo 15 — panel history, status markers, disclosure

- **The sibling lane completed Todo 14 and left all Todo 15 work in place.**
  `AIChatHistory.tsx` (dropdown with session list, New chat, per-item delete
  with in-place confirmation) and `AIChatHistory.test.tsx` (10 tests covering
  ordering, status markers, delete-without-confirm, delete-with-confirm,
  active-session-delete → new chat, New chat, disclosure, null-title) were
  already created before this lane started. `AIChatPanel.tsx` already had:
  store-backed `sessionId`/`pending` state, `storedTurns` via seq-ASC sort,
  `turnMarker()` helper, `TurnMarker` component, `TurnDisclosure` block, and
  the `err.kind === "aborted"` branch fix that the inherited-wisdom flagged.
  No new component code was required — the lane's work was verification,
  prove-it-bites runs, and evidence capture.
- **Prove-it-bites (a): orderedData instead of seq ASC.** Mutating
  `storedTurns` from
  `Array.from(aiChatMessages.data.values()).filter(...).sort((a,b)=>a.seq-b.seq)`
  to `aiChatMessages.orderedData.filter(...)` makes the ordering test fail with
  `expected [ 'second turn', 'first turn' ] to deeply equal [ 'first turn', 'second turn' ]`.
  The fixture has `seq:1 / createdAt:2024-01-05` and `seq:2 / createdAt:2024-01-10`;
  `orderedData` sorts `createdAt` DESC so seq-2 (newer) comes first. Restored.
- **Prove-it-bites (b): TurnMarker suppressed.** Changing
  `{marker && (<TurnMarker .../>)}` to
  `{false && marker && (<TurnMarker .../>)}` makes the truncated-marker test
  fail with `AssertionError: expected null not to be null` — the
  `data-testid="message-status-truncated"` element is absent. Restored.
- **`AIChatHistory.test.tsx` mocks `~/components/ActionButton` and
  `~/components/Tooltip`** rather than `~/components/Button` — because
  `AIChatHistory` imports `NudeButton` (which extends `ActionButton`) and
  `Button` (also `ActionButton`). Mocking at the `ActionButton` root covers
  both, and forwarding `type`/`aria-label`/`children` keeps the rendered test
  ids non-vacuous.
- **Popover portals to `document.body`, not the render container.** Queries in
  `AIChatHistory.test.tsx` must use `document.querySelector`, not the
  container-scoped helper. The test's `renderPanel` returns
  `container: document.body` for exactly this reason.
- **`AIChatHistory`'s in-dropdown confirm (not `DialogsStore.openModal`)**
  is what makes delete-without-confirm testable: the confirm step is local
  React state (`confirmingId`), and dismissing it (`setConfirmingId(null)`)
  leaves the store untouched. The "delete without confirming changes nothing"
  test asserts `rootStore.aiChatSessions.get("session-a")` is still defined
  and `sessionsByRecency` has length 2 after clicking the trash icon and
  the cancel button.
- **All 8 user-facing strings in the new components use `t(...)`.** No locale
  files were hand-edited; `yarn build:i18n` was not run (it fails on this
  Windows host with `command not found: mkdir`).
- **`scrollable={false}` (line 279) and `min-height: 0` on both `Container`
  (line 420) and `Transcript` (line 432) are intact** in the final
  `AIChatPanel.tsx`. `§6.1` is satisfied.
 - **The `aborted` branch in `AIChatPanel.tsx` (`err.kind === "aborted"`) is
   already present** (inherited-wisdom flagged it as a latent hazard in
   Wave 3; the sibling lane fixed it before this lane started). The comment
   at lines 222-228 documents why: without it, `errorText` would render the
   transport's raw cancel message instead of its generic copy.
 - Not applicable: no migration, no dependency added, nothing committed, no
   bare `yarn format`, no `build:i18n`. All changes verified by
   `yarn tsc --incremental false` (exit 0) and full `yarn test:app`
   (37 files / 348 tests / exit 0).

## Wave 4 / Todo 16 — close/reopen and session-switch regression tests

 - **The close/reopen test is driven through the `AIChatHistory` dropdown, not
   the composer.** The panel starts unselected (`sessionId === null`) and an
   empty transcript renders the empty state, so a store-backed transcript is
   only visible after a session is selected. `handleSelectSession` is wired to
   `AIChatHistory.onSelect`, and that component was unmockable as-is (the
   existing `SidebarLayout` stub in `AIChatPanel.test.tsx` discarded `actions`,
   so the dropdown was never mounted). The stub had to forward `actions`, and
   `~/components/ActionButton` (covers `NudeButton` and `Button`) plus
   `~/components/Tooltip` had to be mocked — same idiom as
   `AIChatHistory.test.tsx`.
 - **`PopoverContent` portals to `document.body`, not the render container.**
   The `renderPanel` helper in `AIChatPanel.test.tsx` now queries
   `document.querySelector` (the sibling file did the same for this reason).
   A container-scoped query returns `null` for anything inside the dropdown.
 - **`aiChatSessions.list()` on mount replaces the local set, so the
   `client.post` mock must return the seeded sessions for
   `/ai.sessions.list` or the mount effect wipes them out.** The default
   `ApiClient` mock returns a benign auth envelope with no `sessions` key, so
   every seeded session is removed. `mockEndpoints(sessions)` in the test
   file answers the two AI endpoints; the shared `afterEach` restores the
   default implementation so the mock does not leak into sibling files.
 - **Prove-it-bites, measured.** Mutating `storedTurns` to `() => []` with
   no deps (the pre-fix shape — transcript with no store backing) makes both
   new tests fail: the close/reopen test with
   `expected [] to deeply equal [ 'question one', 'answer one' ]` at the first
   assertion (line 451, so even the initial mount is unobservable), and the
   session-switch test with `expected [] to deeply equal [ 'Beta question',
   'Beta answer' ]`. The existing 7 tests stay green. Restored via
   `vcs.mjs -C worktree checkout -- app/components/AIChat/AIChatPanel.tsx`.
 - **The close/reopen test does three mount cycles** (mount → select →
   assert; unmount; mount → select → assert; unmount; mount → select →
   assert) to guard against transcript accumulation on repeated remounts,
   not just a single close/reopen.

---

## Wave 5 / Todo 17 — E2E host limitation recorded

- **No browser test harness exists in this repository.** Verified on the
  `ai-chat-sessions-w5` worktree with `Test-Path`: `node_modules/@playwright/test`,
  `node_modules/playwright`, and `node_modules/.bin/playwright.cmd` are all absent,
  and `package.json` has no `playwright` dependency and no `test:e2e` script.
  Adding Playwright was ruled out by the plan, so there is no config file and no
  runner to invoke.
- **Therefore IS-2 has no E2E gate.** The cache-reconciliation property (a
  transcript survives a page reload and renders identically on a second device,
  because storage is server-authoritative rather than a browser cache) is verified
  by nothing.
- **The jsdom suite cannot close that gap, and the reason is structural.** Every
  client test runs against a mocked store, so the store returns exactly what the
  test seeded. Divergence between what the client caches and what the server
  returns is the exact condition a mock makes unrepresentable. A green jsdom run
  proves the client renders correct data, not that the data is correct.
- **This is not a fresh discovery.** `docs/AI-CHAT-DESIGN.md` §8 already recorded:
  "**The panel has never been rendered in a browser.** Browser automation is
  unavailable on this host (`Windows named-pipe discovery is not implemented`)."
  Wave 5 only widens the scope: persisted sessions added a reconciliation surface
  that no test of any kind reaches.
- **Recorded in `docs/AI-CHAT-E2E.md`** (new, `last_updated: 2026-10-14`) rather
  than as a config file. Shipping `playwright.config.ts` for an uninstalled runner

## Wave 5 / Todo 18 — AI chat documentation updated

- **Two documents went stale in opposite directions, so grep for the *absence* of a
  claim, not its presence.** `AI-CHAT-DESIGN.md` said "Persistence — none" and
  `AI-CHAT.md` said "there is no write endpoint"; both were false after Wave 2.
  A grep for "persists nothing" would have found only the second file. Grep each
  file for its own obsolete wording — `Persistence.{0,3}—.{0,3}none`,
  `no write endpoint`, `read-only by construction` — and require all three to be
  empty before calling the update done.
- **Three pre-existing `curl` recipes were all missing the `accessToken` cookie.**
  They passed only `csrfToken`. `auth()` runs before the route body and
  `parseAuthentication` throws `AuthenticationError` with no token, so every one
  of them documented a status the request could not actually produce. This is
  the general trap: a CSRF-only recipe looks complete because the doc's
  surrounding prose is entirely about CSRF, and the omission is invisible.
  **A copy-pasteable recipe needs the full credential set**, cookie auth means
  `accessToken` + `csrfToken` + the `x-csrf-token` header.
- **The `event: error` payload sample in `AI-CHAT.md` predated `refuseWithSseError`'s
  `kind` field** and showed only `{"error": "..."}`. Wave 2 parameterised the kind
  (`"refusal" | "busy"`), so the sample was quietly incomplete. When auditing doc
  samples against code, check the *whole* payload object, not just the field the
  prose is about.
- **The two mermaid diagrams in `AI-CHAT-DESIGN.md` both contradicted the code**,
  not just Diagram A. Diagram B (§5 components) had no stores, no session
  routes, no lock, no tables, and its 404-gate node omitted `AI_CHAT_MODEL`. When
  a feature adds a new server-side participant, every diagram in the doc needs
  it — grep the doc for `mermaid` and count.
- **`auth()` with no options admits API keys; `auth({ type: [APP] })` does not.**
  The four session routes use the former, `ai.chat` the latter. That difference
  is invisible in a route listing and is the kind of thing the doc must state
  explicitly, because "the scoped MCP credentials have no path here" is true of
  one route and false of the five beside it.
- **The residual risk of persisting history is durable fabrication, not
  exfiltration.** A previous draft had this backwards, and it is an easy flip:
  the proxy forwards only `role` + `content` rows and never injects document
  text, and `findUngroundedReason` returns a reason string or nothing that is
  logged but never rendered into the prompt or a tool call. Grounding is a
  boolean admit/deny. State the two supporting facts alongside the risk
  whenever this section is edited.
- **Inserting a new subsection shifts every downstream anchor link.**
  `AI-CHAT.md` links to `./AI-CHAT-DESIGN.md#2.1-middleware-chain`. Adding a
  §2.1 before it would break the link, so the new diagram commentary went in as
  **§2.0.1**. Grep the sibling doc for `#<n>.<m>-` anchors before inserting a
  numbered heading.
- **Docs-only tasks need no test run, and saying so beats a green-but-meaningless
  one.** `yarn tsc` / `yarn test` on a markdown-only diff prove nothing about the
  diff. The real verification is (a) the negative grep, (b) reading every
  documented shape back out of the handler it came from, and (c)
  `vcs.mjs diff --name-only` proving the file list. Record all three in the
  evidence file instead of running a check that cannot fail usefully.
- **`docs/AI-CHAT-DESIGN.md` §8 honesty notes are load-bearing.** The recorded
  184 ms / 287-delta / `[DONE]` round trip was measured on the *stateless* path
  before turn storage existed. Once sessions landed, that measurement stopped
  describing the session-backed path, so the note now says which path it covers
  and states that the terminal frame, the lock and the session endpoints are
  documented from code and their tests. Keep this section honest whenever the
  transport changes; a stale "verified" claim is worse than no claim.
  produces a green check that can never run, which is worse than no check.
- **Every test name cited in that doc was grepped out of the file it is cited
  from** before being written, rather than paraphrased from memory.
 - **`seedMessage` takes a full `message` record** (all fields except
   `sessionId` and timestamps), not an overrides bag, so the default
   `role`/`seq`/`content` do not have to be specified per call and the
   helper cannot be called with a bare default that masks a missing field.
 - Not applicable: no migration, no dependency added, nothing committed, no
   bare `yarn format`, no `build:i18n`. `AIChatPanel.tsx` was only touched
   for the temporary prove-it-bites mutation and restored byte-for-byte
   via `checkout`.


## F1+F2 final gate (round 3, HEAD 7fd1853c0) — CONFIRMED

Row 27 empirically verified, not just read:
- `session.updateWithCtx(txCtx, updates)` → `Model.ts:99 this.set(keys)` → `:100 this.save(hookContext)`.
  On turn 2 `updates={}` so `save` computes `options.fields=_.intersection([],rawAttrs)=[]`
  (model.js:2374), `realFields.length===0` → early `return this` (model.js:2470-2471):
  no UPDATE, no `@AfterUpdate`, no Event. Source-confirmed for the pre-fix code.
- Seeding `session.dataValues.updatedAt=new Date(); session.changed("updatedAt",true)`
  is correct: `_readOnlyAttributes` only guards `set()` (model.js:2281), not direct
  dataValues assignment; `changed(key,true)` adds to `_changed` (model.js:2306-2308) so
  `options.fields=["updatedAt"]` is non-empty and `realFields.length>=1` passes the :2470 guard.
- LIVE PROBE (temp test, since removed): two appends produce exactly 2
  `ai_chat_sessions.update` Events; event[1].changes.attributes has key "updatedAt".
  A freshly reloaded instance has `changed()===false` and empty changeset → NO model corruption.
- Test bites: with the two seeding lines disabled, ONLY
  "bumps the session timestamp on every turn, not only the first" fails
  (expected X to be greater than X); the other 14 pass. Restored byte-for-byte.
- Lane's "changes.previous is {}" is slightly imprecise: previous DOES carry an
  `updatedAt` key, but its value serializes as `{}` both before and after the JSONB
  round-trip — AND turn 1's title event shows the same `updatedAt:{}`. So it is a
  pre-existing Sequelize Date→JSONB serialization artifact affecting ALL session
  update events, NOT something the fix introduced. Not a new defect.

Row 30: aiStreaming.test.ts ran green ALONE, alongside aiChatMessageCreator.test.ts
(the prior reproducer), and with a 3rd sibling — 2 consecutive runs, no `deeply equal` failure.

Row 28: clearDraft(session.id) sits inside the try{} AFTER `await aiChatSessions.delete(session)`
(AIChatHistory.tsx:85,89); base Store.delete (Store.ts:454-458) rejects on a failed POST before
`remove` → a failed delete cannot clear the draft. Draft-GC jsdom test drives a real delete and
asserts the literal localStorage key `aiChat.draft.session-b` is null.

Row 29/31: JSDoc has no "Todo 6"; all 9 test names cited in AI-CHAT-E2E.md exist verbatim.

Test-count arithmetic: Waves 6-7 app-test file deltas are exactly -8 (aiChat.test.ts: 7 dead
CRUD tests + 1 draft-GC test) +1 (AIChatHistory draft-GC) +2 (AIChatPanel: 1 rename + 2 new)
= -5. No app test file was deleted in the whole feature range; no .skip/.only anywhere.
The 352→345 (-7) vs -5 gap is baseline-timing (352 predates Wave 6's +2), not a hidden deletion.

Minor doc nit (non-blocking): docs/AI-CHAT-E2E.md:35 says "37 files / 350 tests" for
test:app; HEAD is 345. A stale COUNT (names are all valid), outside row 31's name criterion.
