# Issues — ai-chat-sessions

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /ulw-execute. Append new entries below - never overwrite._

---

## Wave 1 / Todo 1 — ai_chat migration

- **The `vcs.mjs` git shim ignores the Bash tool's `workdir` parameter.** It
  hardcodes `cwd` to the main checkout, so every `node ...\vcs.mjs status` run
  reported the state of `D:/Work-Project/Outline-YGPKB/outline-ygpkb`, **not**
  the active worktree — it showed "working tree clean" while my new migration
  was sitting untracked in the worktree. Workaround: pass an explicit
  `node C:\Users\Media\AppData\Local\Temp\opencode\vcs.mjs -C
  "D:/Work-Project/Outline-YGPKB/outline-ygpkb-wt/ai-chat-sessions-w1" status
  --short`. Any lane that relied on `git status` to detect its own changes was
  looking at the wrong repo. Worth fixing the shim before the next wave.
- The same CMD-prefix hazard still fires when a command contains *any* of the
  words the harness treats as a git operation, even inside a scriptblock. Keep
  cleanup commands and git calls in separate Bash invocations.
- `20200915010511-create-search-queries.js` drops a table that has an inline
  `Sequelize.ENUM` column without dropping the enum type, so its `down` is not
  safe to roll back and re-apply. Not fixed here (out of scope) — flagging so
  nobody copies it as a migration template.
- `yarn lint <path>` silently ignores the path and lints the entire repo, which
  buries any real signal under ~129 baseline warnings. Scope with the binary
  directly.

---

## Wave 1 / Todo 2 — AIChatSession/AIChatMessage models

- No new blockers. One ergonomic trap worth writing down:
  **`yarn oxlint <files>` is completely silent on a clean run.** It emits no
  summary line and exits 0, which is indistinguishable at a glance from "the
  command did nothing". Confirmed live by linting a probe file with a
  deliberate `no-unused-vars` (that *does* print an error), then deleting it.
  Anyone relying on scoped lint output here must treat "no output" as pass only
  after that probe, otherwise it is an unverified assumption.
- `yarn test:server <path>` prefixes every run with a Vite
  `configLoader: 'native'` warning rendered through PowerShell as a
  `NativeCommandError` block. It is cosmetic and does not affect `$LASTEXITCODE`
  — do not read it as a failure.
- Downstream lanes must import `AIChatSession` / `AIChatMessage` as **named
  exports from `@server/models`** (the barrel), not by deep path, and the
  enum names are `AIChatMessageRole` and `AIChatMessageStatus`.

---

## Wave 1 / Todo 5 — user hard purge and retention

- `server/queues/processors/UserDeletedProcessor.ts` was left untouched on
  purpose: it reacts to the **soft** `users.delete` event, so purging there
  would destroy chat history on a *recoverable* delete and still leave the
  `ai_chat_sessions` rows orphaned. The purge belongs on the retention cron.
- Live FK audit against `outline-test` (information_schema +
  `pg_constraint`): **`ai_chat_sessions.userId` → `users` is NO ACTION**
  (deltype `a`), `ai_chat_sessions.teamId` → `teams` is CASCADE,
  `ai_chat_messages.sessionId` → `ai_chat_sessions` is CASCADE. So a team purge
  already takes its chat data via the team cascade, but a *user* delete never
  does — which is exactly the gap this todo closes.
- **Scope assumption recorded:** `userPermanentDeleter` purges the user's
  `ai_chat_sessions` and does **not** hard-delete the `users` row. 28
  NO ACTION FK columns reference `users` (`events.userId`, `events.actorId`,
  `documents.createdById/lastModifiedById/deletedById`, `shares.userId`,
  `revisions.userId`, `attachments.userId`, `users.invitedById` self-reference,
  …), so a hard delete of a user row would be rejected by the FK unless ~20
  tables were purged in a strict order — a separate, much larger operation than
  the retention gap. The purge is ordered as the brief requires (chat data
  before any possible users-row hard delete) and the constraint is documented in
  the command's JSDoc.
- `git status` in this repo prints a custom grouped/truncated listing
  (`~ Modified: N files` … `+5 more`) rather than porcelain. Use
  `ls-files --others --exclude-standard` and `diff --name-only` through the
  shim when you need the real, complete file list.

## Wave 1 / Todo 3 — session policy and presenters

- **Running `server/presenters` dirties `__snapshots__/user.test.ts.snap`.**
  Vitest rewrites it during the run; `git diff` reports zero content hunks, but
  the CRLF stat-cache marks the file `M`. Harmless, but it looks like someone
  else's edit in a shared worktree. Fix: `git checkout --
  server/presenters/__snapshots__/user.test.ts.snap` after any full presenters
  run. Do not assume another agent caused it.
- **New server tests land in the `server-shared` vitest project, not
  `server`.** Vitest routes them by import graph, and both new files pull in
  shared code. `yarn test:server <path>` still runs them; the failure banner
  reads `|server-shared|`, which is not a misconfiguration.
- **The policy test touches the database** via `buildTeam`/`buildUser`, so it
  is not a pure unit test. The presenter test is DB-free.
- **Writing this file required a workaround.** Any command whose text contains
  the literal `git` gets a CMD-style `set VAR=... &&` prefix injected, which
  PowerShell 5.1 cannot parse, and the whole command fails before running. Used
  `$g="g"+"it"` and interpolated instead. This is the third time in this
  project that a harness quirk cost a retry.

## Wave 1 / Todo 4 — ai chat write commands

- **The plan's concurrency QA scenario cannot be verified behaviourally on this
  host.** `Promise.all` of two appends did not interleave inside the database,
  so the test stayed green with the row lock deleted. The lock is now asserted
  structurally on `findByPk` options; the end-to-end "two rows, distinct seq"
  assertion is kept because it guards the invariant even though it cannot
  distinguish lock from no-lock. If someone later wants a real race, the only
  remaining discriminator is observing `pg_stat_activity.wait_event_type =
  'Lock'` on the appending backend from a third connection.
- **`retryOnUniqueConstraintError` will mask a missing lock forever.** Because
  it retries the whole transaction, a wrong `seq` self-heals on the second
  attempt. That is exactly why the "no retry was logged" assertion is not a
  usable regression test here - the race it watches for rarely occurs.
- **Uncovered by design:** `aiChatSessionDestroyer` and `aiChatSessionCreator`
  are exercised only from inside `aiChatMessageCreator.test.ts`, because the
  brief restricted the deliverable to four file paths and a fifth test file was
  not allowed. If a dedicated `aiChatSessionDestroyer.test.ts` is wanted later,
  move the two `describe` blocks there.
- **No orphaned locks:** every test transaction commits or rolls back before
  the next assertion, and the fixture session is always created through
  `withAPIContext` (which commits), so no `FOR UPDATE` is ever held across a
  test boundary.

## Wave 1 / Todo 19 — colocated CleanupDeletedUsersTask test

- **`server/queues/AGENTS.md` claims "each task `.ts` has a colocated test",
  which is not true of the repo.** Only 29 of the ~93 jobs under
  `server/queues/tasks/` have a colocated `*.test.ts`. Two sibling
  `CleanupDeleted*` jobs — `CleanupDeletedTeamsTask.ts` and
  `CleanupDeletedTeamTask.ts` — have none, and neither do most of the other
  cron tasks. The convention is aspirational, and the gap is pre-existing
  upstream, not a Wave 1 regression. Worth a separate cleanup todo rather than
  folding it into this one.
- **`userPermanentDeleter.test.ts` was importing a task from
  `server/queues/tasks/` into `server/commands/`, inverting the dependency
  direction** (commands should not depend on the queue layer in tests, and a
  reader of the command suite had no way to know a cron job existed). Now
  removed; the command suite depends only on the command.
- **No reducer: coverage went up, not sideways.** The command suite keeps 5
  tests (destroy+cascade, other-users isolation, `deletedAt` guard, idempotency,
  empty sessions). The task suite adds 5 (cron getter, options getter, purge
  outside window, keep inside window, keep undeleted). Total across the two
  files: 8 → 10, and the two previously-uncovered getters are now covered.
- **Transient risk during the prove-it-bites experiment only:** `RetentionDays`
  was set to 0 in `CleanupDeletedUsersTask.ts` for one run and restored
  immediately after. The file is untracked, so `git diff` could not confirm the
  restore — verified by grepping the constant instead (line 12 is
  `const RetentionDays = 30;`). Untracked source files edited for an
  experiment cannot be audited by `diff --name-only`; grep the line.
- **Not applicable:** no migration was run (the `ai_chat_sessions` /
  `ai_chat_messages` tables were already applied to `outline-test`), no
  dependency changed, nothing committed, `yarn format` and `yarn build:i18n`
  were both avoided per the Windows-host hazards.

## Wave 2 / Todo 6 — ai schema extension

- **`yarn tsc` does not exit 0 on this worktree right now, by design.**
  `server/routes/api/ai/scope.ts(88,10): error TS18048: 'messages' is possibly
  'undefined'.` That is the single error, it is caused directly by making
  `messages` optional in `AiChatSchema`, and `scope.ts` is owned by todo 7.
  Do not "fix" it from a lane that does not own the file. Evidence captured in
  `%LOCALAPPDATA%\Temp\opencode\evidence\w2-todo6.txt`.
- **`AiChatMaxSessionTitleLength = 200` is a chosen constant, not a spec.** The
  DB column is `title` (`STRING`); no acceptance criterion fixed a bound. If
todo 8 (session creator) wants a different ceiling, change it there rather
  than widening the schema twice.
- **The `.refine()` path `["body", "messages"]` is unverified against a live
  400.** It was verified at the schema layer only (the mapped message is
  `messages: messages is required when sessionId is not provided`, and
  `ValidationError` is a 400), not over HTTP. `ai.chat` has no such test yet;
  the sibling lane adding routes should add one if it wants the wire-level
  proof.
- **`ai.messages.list` has no `limit` field** �?" only `sessionId` and the
  `beforeSeq` cursor, because the brief said to keep it minimal and match the
  todo-13 client contract. If the list route ever needs a page size, add it
  there; do not widen this schema speculatively.

---

## Wave 2 / Todo 7 — scope decoupling and upstream resolution

- **`ApiContext<T.Req>` is awkward to fake in a test; `{ ...ctx, input: { body,
  query: {} } }` is the escape hatch.** `BaseSchema` declares `body: z.unknown()`
  and `query: z.unknown()`, so both are *required* keys of `AiChatSchemaReq`
  even though their values are unknown. A literal `{ input: { body } }` is
  therefore missing `query`. Spreading a real `withAPIContext` ctx and overriding
  `input` typechecks with no cast:
  `{ ...ctx, input: { body, query: {} } }`. (Sourcing a narrower `Pick<APIContext,
  "state"> & { input: … }` param type does NOT work — `findOwned` demands a full
  `Context | APIContext`.)
- **`Array.prototype.at` typechecks despite `lib: ["es2020"]`.** `tsconfig.json`
  is `target: es2020` with no `es2022` lib, yet `messages?.at(-1)` and
  `result.error.issues.at(0)` both compile (TypeScript 7.0.2). Do not avoid
  `.at()` on lib grounds; verify with `tsc` instead.
- **Filter does NOT narrow a property — only the element.** `rows.filter((row)
  => isForwardableRole(row.role))` leaves `row.role` typed `string`, because
  `Array.prototype.filter`'s type-predicate overload narrows `T`, not a field of
  it. Used an explicit `for … if (row.role) push(…)` loop instead.
- **A refusal test cannot discriminate "gate reads the DB" from "gate reads the
  client array" on its own.** `promptText` joins *every* user message in the
  window and the probe is an OR over up to 8 terms, so a single grounded message
  rescues any number of ungrounded ones. My first version of the session-backed
  refusal sent a grounded client array and got **500**, not 200 — the fetch mock
  is `vi.fn()` (returns `undefined`) and the gate had allowed the request.
  The fixture that does discriminate: put the grounded text in a client turn
  that is NOT `messages.at(-1)`, so it is outside the resolved window.
- **Prove-it-bites for the gate, measured:** mutating
  `findUngroundedReason(user, resolvedMessages)` back to
  `findUngroundedReason(user, messages ?? [])` fails exactly 3 of 13
  (`expected 500 to deeply equal 200`, and `expected "vi.fn()" to be called 1
  times, but got 0 times` twice). ai.test.ts stays green under that mutation —
  every existing case sends a standalone `messages` array with no `sessionId`,
  which is exactly why it cannot prove this.
- **A `system`-role row cannot be written to the DB** — `role` is a Postgres enum
  of the two roles, so a stored `system` message is uninsertable (22P02). The
  `role ∈ {user, assistant}` re-assertion therefore cannot be proven end-to-end
  through a session; it is pinned on `toUpstreamMessages`, which is exported for
  exactly that reason.
- Sibling lane landed `aiSessions.ts` / `aiSessions.test.ts` and edited
  `index.ts` mid-run; the final 47-test run (scope + ai + upstreamMessages) was
  green **with those files mounted**.

## Wave 2 / Todo 8 - session and message RPC endpoints

- **The todo-8 brief's rate-limiter rationale is wrong, and I did not encode it.**
  It says "limiter keys are IP-scoped (`rateLimiter.ts:34,52`), so these limits
  are per-IP rather than per-user" and cites `server/utils/RateLimiter.ts`. That
  citation is wrong twice over: lines 34 and 52 of that file are
  `_defaultRateLimiter` and the end of `getRateLimiter`, not anything about
  addressing. The real behaviour is in `server/middlewares/rateLimiter.ts:30-52`,
  where `getRateLimiterIdentifiers` returns `[ctx.ip]` only when there is no
  token, `[ip, credential]` for API key / OAuth, and **`[userId]` for a session
  token**. Since `auth()` runs first, an authenticated request to these routes
  is limited per user, not per IP. The source comment states the actual rule
  and points at the right file.
- **Consequence: every `RateLimiterStrategy` member is documented "per IP
  address" (`server/utils/RateLimiter.ts:184-229`) and that JSDoc is stale.**
  It predates credential- and user-keyed identifiers. It is upstream, it is not
  owned by this plan, and it is now known to mislead - flagging rather than
  editing. If a later todo wants it corrected, that file is the place.
- **`AiMessagesListSchema` has no `limit` field**, so the page size cannot be
  client-controlled. I bound it to `AiChatMaxMessages` (50) rather than adding
  one. If the client ever needs a page size, it belongs in `schema.ts`, not in a
  route-local constant.
- **Transient, resolved:** the sibling lane was mid-edit on `ai.ts` and
  `scope.ts` throughout. `yarn tsc --incremental false` exited 0 for the whole
  worktree - todo 7's `scope.ts` fix had already landed, so the todo-6 error at
  `scope.ts(88,10)` recorded earlier in this file is no longer present. No
  sibling-owned failure was observed at any point.
- **Not applicable:** no migration was run (the Wave 1 tables were already
  applied to `outline-test`), no dependency changed, nothing committed, bare
  `yarn format` and `yarn build:i18n` both avoided. `oxfmt` was run scoped to
  the three owned files instead.

## Wave 2 / Todo 9 — streaming turn persistence

**REJECTED once, then fixed. Both failures were real defects in my code. The
entry claiming this todo was delivered at 12/13 was wrong — see below.**

### Failure 1 — `oxfmt` broke the `t()` literal, failing a pre-existing test

- Root cause: I extracted the refusal into `const refusal = t("…")`. oxfmt
  breaks **assignment right-hand sides**, so it emitted
  `const refusal = t(\n  "…"\n);` and the contiguous substring `t("…")` that
  `ai.test.ts:537` asserts on no longer existed.
- **oxfmt only preserves a call that is already inside a call's argument
  list.** The original `refuseWithSseError(ctx, t("…"))` survived because
  prettier/oxfmt breaks at argument boundaries, not inside an argument.
- Fix: call `t()` twice with the same literal, both in argument position
  (`appendTurn(role, t("…"), status)` and `refuseWithSseError(ctx, t("…"))`).
  Both lines fit under 80 columns so neither is wrapped. i18next-parser
  dedupes identical literals, so there is no translation-key duplication.
- **Generalisable rule for this repo: never bind a `t()` result to a const
  where a source-text assertion pins the literal.** Put it in argument position.
- Verify the smart quote survived by codepoint, not by eye — PowerShell renders
  U+2019 as `'`. A throwaway node script counting `t("…’s…")` occurrences,
  straight-apostrophe occurrences and total U+2019 was the reliable check.

### Failure 2 — the abort flush never wrote. Root cause was NOT what I first claimed

- I first reported `requestContext.exit()` as "ineffective". **That was wrong.**
  It does bypass the guard. The real cause was two separate defects.
- **Defect A — `ctx.req.on("close")` never fires on a client disconnect.**
  `IncomingMessage` emits `close` exactly once, as soon as its body has been
  consumed, which koa-body does *before* the route handler runs. By the time
  the handler attaches its listener that event is already gone, so a real
  disconnect was invisible — meaning the pre-existing `ac.abort()` on
  disconnect (landed before this todo) was **also a silent no-op**.
  Proven with timestamped probes: `ctx.res.on("close")` fired at +101ms with
  `writableEnded=false`; `ctx.req.on("close")` never fired at all, even though
  the socket genuinely closed (the http server logged
  `ERR_STREAM_PREMATURE_CLOSE`). **Fix: listen on `ctx.res`, not `ctx.req`.**
  This is the standard Node way to detect client disconnect.
- **Defect B — the mocked `fetch` ignored `init.signal`.** A real `fetch`
  honours it. Without that, the route's `ac.abort()` reached a mock that
  ignored it, the upstream never errored, and the only exit was `end` (which
  fired when the test tore the mock down, ~4.8s later — after the assertion).
  Fix: the stalled-stream helper now takes the signal and errors its body on
  abort, exactly as undici does.
- **`requestContext.exit()` was genuinely needed** and was not the problem:
  `server/storage/database.ts:214` registers `assertConnectionOpen` on
  `beforeFind`/`beforeCount` and throws `ClientClosedRequestError` (499) when
  `requestContext.getStore()?.req.socket.destroyed`. `aiChatMessageCreator`
  reads `max(seq)` inside its transaction, so an abort-path flush failed its
  own read and the turn was lost. **Writes were deliberately never gated** by
  that hook — only reads are — so escaping the request context for this one
  write states the true invariant: its deliverable is the row, not the response.

### Other traps hit

- **`TestServer.fetch` defaults to GET.** It has no implicit `method: "POST"`
  like `TestServer.post` does. A GET with a body makes node-fetch reject, the
  route never runs, and `await providerContacted` hangs until the vitest
  timeout. Symptom looked like a production bug for a long time.
- **Erroring a `ReadableStream` in the same `pull` batch that enqueued the
  frame discards the buffered chunk** before it is ever delivered as `data`.
  The upstream-error test therefore had no partial answer to record. Fix: defer
  `controller.error` by a `setTimeout(…, 0)` so the frame is genuinely
  delivered first — which is what a real socket reset looks like.
- **`await res.text()` after aborting the client hangs.** node-fetch does not
  reject the already-returned Response body read. The abort tests must not read
  the client body at all; they poll the DB via `waitForRows`.
- **The test DB is not empty** (1218 `ai_chat_messages` rows). Global
  `count()` assertions are meaningless — use before/after deltas, or scope by
  `sessionId`.
- `console.log` inside a route handler does not reach vitest output. Use
  `process.stderr.write` for temporary probes.

### Prove-it-bites (all three exits verified to bite)

- `ctx.res.on("close")` body disabled → exactly 1 failure: the aborted
  mid-stream test.
- `upstream.on("end")` flush disabled → 7 failures (every clean-exit test).
- `upstream.on("error")` flush disabled → exactly 1 failure: the errored
  mid-flight test.
- Note: disabling only `onClientGone` (keeping `ac.abort()`) leaves the suite
  **green**, because `ac.abort()` makes the signal-honouring mock error the
  stream and the error exit covers the write. To prove the abort path itself,
  the whole close handler must be disabled.

### Verification (final)

- `yarn test:server server/routes/api/ai` → **6 files, 110/110 passed, exit 0**.
- `yarn tsc --incremental false` → exit 0.
- `node_modules\.bin\oxlint.cmd -c .oxlintrc.json <both files>` → exit 0, silent;
  liveness re-proved with a throwaway `__lintprobe.ts` (exit 1 on a real
  `no-unused-vars`), deleted immediately.
- `git diff --name-only` → `server/routes/api/ai/ai.ts` only;
  `git ls-files --others --exclude-standard` → `server/routes/api/ai/aiStreaming.test.ts`
  only.
- Not applicable: no migration, no dependency change, nothing committed, no bare
  `yarn format`, no `yarn build:i18n`. `oxfmt` run scoped to the two owned files.

## Wave 2 / Todo 10 — per-(user, session) in-flight cap

- **`aiStreaming.test.ts` has a pre-existing cross-file flake, and it is not
  caused by this todo.** Its "writes nothing and leaves the stream
  byte-identical without a sessionId" case snapshots a **global**
  `AIChatMessage.count()` and re-checks it after a request. Under
  `fileParallelism: true` (vitest.config.ts) every isolated `server/**` file
  runs in a parallel thread against the single shared `outline-test` database,
  and two committed siblings already insert chat rows there —
  `aiSessions.test.ts:107` and `upstreamMessages.test.ts:109` both
  `AIChatMessage.bulkCreate(...)`. Observed **1 of 6** parallel runs of the
  committed six files (my new file absent) failing with
  `expected 2850 to deeply equal 2849`. Their window is narrow (a bulkCreate
  returns in ~ms), so it hits rarely; a second *streaming* writer widens it.
  - Fix belongs in `aiStreaming.test.ts`: scope the count to the session under
    test, or assert a delta over rows whose `sessionId` the test owns — never a
    global count. It was **not** edited here (out of scope for this todo, and
    the brief forbids touching it).
  - Workaround for a green number until then: `--no-file-parallelism`
    (serial) is 117/117 deterministic. The default parallel command is green
    most runs but is not reliable.
- **`Redis.defaultClient` in a test is the real Redis on `127.0.0.1`**, not a
  mock, and it is shared across parallel test files. Keys a test writes must be
  namespaced per-`(user, session)` (they are) and a test that seeds a key must
  use a value distinct from any real `runId` so the compare-and-delete under
  test cannot be satisfied accidentally. `afterEach` does **not** clear Redis —
  a test that leaves a key behind would poison a later run, so every test here
  either releases its own key through the route or seeds and does not depend on
  its absence.
- **Two probe edits were made to `ai.ts` for the prove-it-bites runs and
  restored:** `"NX"` → `"XX"` (lock always overwritten → the concurrent-turn
  test failed with both bodies refused-as-streamed) and
  `releaseInFlightLock` gated on `clientGone` (abort test failed). Both
  restored and re-verified green; `tsc` exit 0 after restore.
- Not applicable: no migration run, no dependency added, nothing committed, no
  bare `yarn format`, no `yarn build:i18n`. `oxfmt` was run scoped to the two
  owned files.

## Wave 3 / Todo 11 — client models and stores

- **A sibling lane editing `RootStore.ts` made 18 of 18 tests fail with a
  misleading error.** Mid-run the sibling briefly dropped the explicit
  registration names (`registerStore(AIChatSessionsStore)` with no second
  argument), so the stores landed on `aIChatSessions` / `aIChatMessages` and
  every `rootStore.aiChatSessions` access returned `undefined`. The reported
  failures were `TypeError: Cannot read properties of undefined (reading
  'persistable')`, which looks like a defect in *my* stores but was purely the
  sibling's transient state.
  - **Mitigation adopted:** the 16 behavioural tests resolve their store through
    `rootStore.getStoreForModelName<"aiChatSessions">("AIChatSession")` rather
    than the field accessor, so a sibling naming regression fails exactly the
    two naming tests instead of cascading to the whole file. The naming tests
    themselves still assert `toBe(rootStore.aiChatSessions)`, so the regression
    is still caught — loudly, and in one place.
  - This is the concrete payoff of splitting the two stores into separate
    colocated test files: the messages suite stayed fully green throughout.
- **`Store.fetch` on a store without `Info` rejects, and the rejection must be
  awaited.** The guard is `throw new Error(...)` *inside* an `async` method, so
  `await expect(store.fetch(id)).rejects.toThrow("Cannot fetch AIChatSession")`
  is the correct assertion. A synchronous `expect(() => store.fetch(id)).toThrow()`
  would not see it.
- **Two lints fire on every new app store and are worth knowing up front:**
  `consistent-type-imports` rejects `import RootStore from "./RootStore"` when
  the class is only a constructor-parameter type (use `import type`), and
  `no-unused-vars` fires on any test helper import left behind after splitting a
  test file. Both were caught by scoped oxlint, both exit 1.
- **`app/models/` has no barrel `index.ts`** — unlike `server/models/`. Client
  models are imported by deep path (`~/models/Star`), so nothing needed
  registering when the two new models were added.
- Not applicable: no migration, no dependency added, nothing committed, no bare
  `yarn format`, no `yarn build:i18n`. `oxfmt` run scoped to the six owned
  files only. `yarn tsc --incremental false` exited 0 for the whole worktree at
  every checkpoint — the sibling's `RootStore.ts` never produced a type error,
  only the runtime registration flap described above.

## Wave 3 / Todo 12 — RootStore registration

- **The oxlint binary is `node_modules\.bin\oxlint.cmd`, not `.oxlint.cmd`.**
  The task brief's command `node_modules\.bin\.oxlint.cmd` does not exist and
  PowerShell reports `CommandNotFoundException` — silently easy to misread as
  "lint found no config". Use `& ".\node_modules\.bin\oxlint.cmd"`.
- **Proving a field-name trap needs a key-set assertion, not a
  `toBeUndefined()` one.** See learnings.md — this cost three iterations. The
  shape that works is
  `Object.keys(rootStore).filter((k) => k.toLowerCase().startsWith("aichat"))`
  compared against the correct key list, which prints `aIChatSessions` /
  `aIChatMessages` verbatim when the explicit names are removed.
- **Constructing `RootStore` in an app test needs `import "~/stores"` first**,
  or the module cycle throws `TypeError: default is not a constructor` at
  `app/stores/index.ts:4`. The remedy and its rationale are already written
  down in `app/stores/base/StorePersistence.test.ts:3-5`; copy that comment
  rather than inventing one.
- **The CMD-prefix hazard fired again**, this time on a long evidence-writing
  PowerShell script and on an `Add-Content` heredoc, because the harness
  prepends `set CI="true" && ...` to the command line. Recovery is the same as
  always: move the logic into a `.ps1` file and run it with `&`, or use the
  `edit` tool for the append. Do not try to write the CMD-style prefix by hand
  — it cannot be parsed by PowerShell 5.1.
- **Sibling-lane ordering is not guaranteed.** When this todo started the four
  sibling files did not exist (`git status` clean); `RootStore.ts` importing
  them was a hard `tsc` failure until they landed mid-task. That is expected,
  not a defect — the brief assigns those files to another lane and says to
  report rather than fix. Read the sibling files once they land to confirm
  `modelName` before finalising the explicit names.
- **Verification (final):** `tsc --incremental false` exit 0 for the whole
  worktree; `oxlint` scoped to both owned files exit 0 silent (liveness re-proved
  with a throwaway `__lintprobe.ts`, exit 1, deleted); `vitest --project app
  app/stores/RootStore.test.ts` 4/4 pass exit 0. Prove-it-bites: dropping both
  explicit names fails 3 of 4 with
  `expected [ 'aIChatSessions', 'aIChatMessages' ] to deeply equal [ 'aiChatSessions', 'aiChatMessages' ]`,
  restored to green. `git diff --name-only` -> `app/stores/RootStore.ts` only;
  the only untracked file I created is `app/stores/RootStore.test.ts`.
- **Not applicable:** no commit, no migration, no dependency change, no bare
  `yarn format`, no `build:i18n`. The diff is +15 -0 on `RootStore.ts`; no
  existing registration was reordered or renamed and `enablePersistence()` did
  not move.

## Wave 3 / Todo 13 — chat util session/draft/status/cursor

- **DEFECT, FOUND BY REVIEW AND NOW FIXED — I shipped "every stateless chat
  reports truncated".** My first cut made the terminal-frame requirement
  unconditional: `if (!complete) throw truncated`. That is only correct for a
  session-backed turn. `server/routes/api/ai/ai.ts:607-614` — `finish()`
  early-returns on `if (!ownedSession)` *without authoring a frame*, because a
  stateless chat is a pure byte proxy. So a request with no `sessionId` never
  emits `event: complete` and never emits `event: truncated`; it just ends, and
  my client called that truncated **after receiving a whole answer**.
  - **Why this is not a dead path** (my original report was wrong to file it as
    an accepted risk): it is the path taken by the *first turn of every new
    conversation*, sent before a session exists — the exact window this same
    todo introduced `aiChat.draft.pending` for. The panel would have replaced a
    correct reply with "The AI chat answer stopped before it finished". It also
    broke todo 9's acceptance criterion, "when `sessionId` is absent, behaviour
    is byte-identical to today".
  - **Fix:** the requirement is conditional —
    `const sessionBacked = options.sessionId !== undefined; if (sessionBacked &&
    !complete) throw truncated`. The comment at the check names the server-side
    `if (!ownedSession)` early return, so the two halves of the contract point
    at each other.
  - **Lesson: "fails closed" is not automatically correct.** I justified the
    unconditional check by the fail-closed rule that governs `errorKind()`'s
    `"stream"` default — but those are different decisions. Defaulting an
    *unlabelled* frame to `stream` fails closed because the payload is
    genuinely ambiguous. Demanding a terminal frame that the protocol only
    defines for session-backed turns is not ambiguous, it is wrong, and the
    asymmetry (stateless = whole proxy, session-backed = recorded turn) was
    sitting in the server code I had already read. **When a client-side rule
    keys on something the server conditionally produces, condition it the same
    way.**
- **The three scattered terminal-outcome tests became one 5-row `it.each`
  matrix.** Strictly stronger, not weaker: the "deltas arrived in full"
  assertion used to exist on one test and now runs on all five rows, and every
  row asserts it. Test count 43 → 45 (3 subsumed, 5 rows).
- **`AIChatPanel`'s abort swallow is UNREACHABLE today — verified, not assumed.**
  Its catch chain is: (1) `kind === "refusal"`, (2) `controller.signal.aborted`,
  (3) `err instanceof AiChatError` → `setError`, (4) else → `setError`. Arm 2
  precedes arm 3, and the controller passed to `streamAiChat` is the same object
  stored in `abortRef`, so an abort can never reach `errorText`. `AbortSignal` is
  one-way, so arms 2 and 3 are mutually exclusive by construction.
  `AIChatPanel.test.tsx:167-209` drives that arm (its mock rejects with a plain
  `Error`, not an `AiChatError`) and is green in the full app-project run.
  **Latent hazard for Wave 4, reported not edited:** the moment Wave 4 branches on
  `err.kind === "aborted"` instead of the signal — the natural refactor now that
  the kind exists — `errorText` renders the raw cancel message instead of its
  generic copy. Cosmetic, one line, Wave 4's file.
- **I filed a mislabelled prove-it-bites run in my own evidence file and caught
  it.** The run captured under a "conditional removed" heading actually executed
  *after* I had restored the fix, so it recorded 45 passed / exit 0 under a
  mutation label. Sections 19-20 re-apply the mutation and capture the real
  failure (`EXIT=1`, `expected AiChatError { kind: "truncated" } to be
  undefined`). **Generalisable: a prove-it-bites artifact is only evidence if it
  was captured while the mutation was actually in the tree. Always assert
  `EXIT != 0` in the script and fail loudly if the mutation did not bite** —
  my script now prints a `WARNING:` line on `EXIT=0` for exactly this reason.
- Not applicable: no migration, no dependency added, nothing committed, no bare
  `yarn format`, no `build:i18n`; `shared/i18n/locales/` untouched; `oxfmt` run
  scoped to the two owned files only. `app/components/AIChat/` untouched.
  `git diff --name-only` -> `app/utils/aiChat.ts`, `app/utils/aiChat.test.ts`
  and nothing else; `git ls-files --others --exclude-standard` -> empty.
- **Verification (final):** `app/utils/aiChat.test.ts` 45/45 exit 0; `app/utils`
  12 files / 159 tests exit 0; **full `yarn test:app` 35 files / 333 tests exit
  0** (includes `AIChatPanel.test.tsx`, unbroken); `tsc --incremental false` exit
  0; scoped `oxlint` exit 0 silent with the `__lintprobe.ts` liveness probe.
  Prove-it-bites, three mutations each reverted and re-verified: (a) both abort
  branches → `network` fails exactly the 2 abort tests; (b) removing the whole
  truncated throw fails exactly the 2 truncated tests; (c) removing the
  `sessionBacked &&` conditional fails **exactly 1 test** — the
  stateless-no-terminal-frame row — leaving the other four green, which is the
  proof that the conditional is precisely scoped.
- **Two pre-existing `parseSSEStream` tests had to be restated**, because the
  generator's element type changed from the raw payload to the
  `AiChatStreamEvent` union (delta extraction moved into the parser so one
  generator can carry both deltas and the terminal signal). The
  `app/components/AIChat/` panel does not consume `parseSSEStream` — only
  `streamAiChat` and `AiChatError` — so Wave 4 is unaffected.
- Not applicable: no migration, no dependency added, nothing committed, no bare
  `yarn format`, no `build:i18n`; `shared/i18n/locales/` untouched. `oxfmt` run
  scoped to the two owned files only. `git diff --name-only` -> `app/utils/aiChat.ts`
  and `app/utils/aiChat.test.ts`, nothing else; `git ls-files --others
  --exclude-standard` -> empty (the `__lintprobe.ts` liveness probe was deleted).
- **Verification (final):** `vitest --project app app/utils/aiChat.test.ts`
  43/43 exit 0; `app/utils` 12 files / 157 tests exit 0; `tsc --incremental
  false` exit 0; scoped `oxlint` exit 0 silent with the `__lintprobe.ts` liveness
  probe re-proving exit 1. Prove-it-bites: collapsing both abort branches back
  to `kind: "network"` fails exactly the 2 abort-vs-network tests; no-op-ing the
  post-loop truncated throw fails exactly the 2 truncated tests, including the
  IS-4 "deltas then no terminal frame" case. Both mutations reverted and the
  suite re-verified green after each.

---

## Wave 4 / Todo 14 — stable sidebar element

- **SIBLING-LANE BREAKAGE REPORTED, NOT TOUCHED.** `AIChatPanel.test.tsx` was
  7/7 green in this wave's baseline and is 7/7 RED at the end of it. Every
  failure is the same error, raised at `AIChatPanel.tsx:67`:

      TypeError: Cannot destructure property 'aiChatSessions' of
      'default(...)' as it is undefined.
      67|   const { aiChatSessions, aiChatMessages } = useStores();

  `useStores()` is returning undefined in the panel's test environment. That is
  the sibling lane's in-flight store migration in `AIChatPanel.tsx` (197
  inserted lines vs HEAD; the file also still has `err` un-narrowed at :221 per
  `tsc`). Nothing in `AIChatContext.tsx` participates. Whoever owns the panel
  needs to check whether its test file needs a `useStores` mock now that the
  panel reads stores.
- **`tsc --incremental false` exits 1 for the worktree, and every error is
  sibling-owned:**
  - `AIChatHistory.tsx(181,27)` TS2322 — `Button` has no `small` prop.
  - `AIChatPanel.tsx(221,49)` TS18046 — `'err' is of type 'unknown'`.
  The brief says to report rather than fix; the count and exact locations are
  in `evidence\w4-todo14.txt` section 7. Early in the task the same list had
  three more `AIChatPanel.tsx` errors (`Cannot find name 'TurnDisclosure'`
  twice, plus a second `Button` prop), so the sibling was mid-edit throughout —
  do not read an unchanged count as "the sibling is done".
- **The `AIChatPanel` remount only becomes observable when the element CHANGES.**
  Because `AIChatContent` is `observer` (= `React.memo`), a plain provider
  re-render with shallow-equal props does not re-render it, so inline JSX builds
  no fresh element and the panel is not remounted. The pre-fix code was
  therefore *not* actively churning on every provider render — the real trigger
  is anything that gives `onClose` or `AIChatContent`'s props a new identity
  (the sibling's per-keystroke props work, a provider state change, a
  `handleClose` dep change). **This means the reported bug is easy to
  under-diagnose**: a repro driven only by "re-render the provider" will look
  fixed before it is. Reproduce by changing a prop or the callback identity.
- **A `vi.mock` factory's return value is spread over the real module**, so
  mocking `useSetRightSidebar` transparently also brings in
  `useRightSidebarContent` / `RightSidebarWrappedContext` from the real file —
  no need to restate them.
 - **Not applicable:** no migration run, no dependency added, nothing committed,
   no bare `yarn format`, no `build:i18n`, `shared/i18n/locales/` untouched.

## Wave 4 / Todo 16 — close/reopen and session-switch regression tests

 - **No new blockers.** The two regression tests landed green on the first
   run after the component wiring was understood.
 - **`SidebarLayout.tsx` is uncommitted in the worktree** (16 insertions:
   the `actions` prop, an `Actions` styled component, and the header render
   of `{actions}`). This is a sibling-lane artifact from Todo 15 that was not
   committed before this task started; it is not a change made by this lane.
   Flagged so the orchestrator or the committing lane includes it — without
   it, the panel cannot render `AIChatHistory` in its header and both
   regression tests would fail to find the session rows.
 - **Not applicable:** no migration, no dependency added, nothing committed,
   no bare `yarn format`, no `build:i18n`; `shared/i18n/locales/` untouched.
   `AIChatPanel.tsx` was mutated only for the prove-it-bites run and restored
   via `git checkout` — no residual edits remain.

## F3 real-manual-QA gate (2026-10-15) — verdict: confirmed (with caveats)

Ran the real surface on the `verify/ai-chat-f3` worktree (HEAD 744bb9309).

- **Environment collision:** another worker's worktree (`ai-chat-sessions-w5`) already
  held port 3060/3061 when F3 started; the F3 backend could not bind 3060. Reconfigured
  the F3 `.env.local` to 3070/3071 (gitignored) and ran there. Main checkout + w5
  untouched.
- **Auth for curl:** minted a session JWT via the compiled `User.getSessionToken()`
  using an existing QA user `f3qa-member@example.com` (team YGPKB) and a foreign user
  `f4qa-ebca0191@example.com` (different team). Bearer auth skips CSRF and works.
- **Lifecycle curl (all captured):** create 200, list 200 (contains), delete 200
  `{"success":true}` then absent from list; `ai.messages.list` on a FOREIGN session
  → 404 with 0 rows written.
- **Streaming:** grounded session-backed turn ended with server-authored
  `event: complete {"runId":..., "finishReason":"stop"}` and persisted both rows
  (user seq1 / assistant seq2 `completed`, same runId). Ungrounded prompt → single
  `event: error` frame `{"kind":"refusal"}` in 153ms, no upstream frames.
- **CAVEAT — real gateway unavailable:** `127.0.0.1:8642` is occupied by a stub
  (`C:\Users\Media\AppData\Local\Temp\opencode\aiqa\stub-upstream.js`) whose own header
  says the Hermes gateway "is NOT running on this host". So the transport is verified
  on the wire, but the real-model path is NOT. The stub was left in place (shared temp).
- **Browser automation:** still unavailable (browser-doctor: browsers detected but
  `extensionRegistered:false`, `browsersConnected:[]`). Fell back to jsdom as recorded.
- **Close/reopen test:** `AIChatPanel.test.tsx` → 11/11 pass; the named test alone
  passes (1 passed, 10 skipped). It genuinely reopens with no re-selection; the
  `ai.messages.list` mock returns empty and `AIChatMessagesStore.list()` ADDS rather
  than replaces, so the transcript it asserts is store-restored state, not a refetch.

Cleanup: dev server on 3070 stopped, `ai-chat-f3` worktree removed, branch preserved.
