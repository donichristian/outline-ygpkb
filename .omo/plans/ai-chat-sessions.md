# ai-chat-sessions - Work Plan

## TL;DR (For humans)

**What you'll get.** Persisted AI chat sessions: multiple past conversations per
user per workspace, a header history list with "New chat", and a panel that no
longer resets when you close it. Fixes the reported bug (closing the panel
discards the transcript) and adds durable storage, a session switcher, and
honest turn status.

**Why this approach.** The panel currently keeps its transcript in
component-local `useState` (`app/components/AIChat/AIChatPanel.tsx:53`) and is
mounted/unmounted through the ephemeral right-sidebar slot
(`AIChatContext.tsx:75-81` â†’ `RightSidebarContext.tsx:19`), so closing destroys it.
The server has no AI persistence at all (`server/routes/api/ai/ai.ts` is a
read-only proxy). This plan adds two tables, four RPC endpoints, and moves
transcript state into MobX stores â€” mirroring existing repo patterns
(`Star`, `starCreator`, `stars.ts`, `StarsStore`).

**What it will NOT do.** No Markdown rendering, no tools/agent loop, no
`threadId`/AG-UI rename, no durable resumable streams, no session rename/search/
pin, no per-answer citations. See "Must NOT have".

**Effort.** XL â€” 5 waves, 17 implementation todos + 4 final-verification tasks.

**Risk.** Medium. Two HEAVY todos (DB migration; the streaming write path that
must never hold a transaction across the SSE stream).

**Decisions.** Grounding boundary unchanged. Stored answers are a historical
record (disclosure model) â€” see todo 9. Messages are never persisted to
IndexedDB. Worktree per wave on ports 3060/3061.

## Scope

### Affected user and ideal state

The affected user is a **workspace member using the AI chat panel in Outline**,
on Windows, running this fork against a Hermes gateway. Today they ask a
question, get a streamed answer, close the panel â€” and lose the conversation.
They cannot find a previous answer because none exists.

| IS | Property after execution | Why |
|---|---|---|
| IS-1 | My conversation survives closing and reopening the panel | The reported defect |
| IS-2 | My conversation survives a page reload, and is identical on another device | Server-authoritative storage, not browser cache |
| IS-3 | I can list, switch between, and delete my past conversations | The requested "multiple past conversations" |
| IS-4 | I can tell when an answer was cut short or failed, instead of trusting a truncated answer as complete | Honesty about turn status |
| IS-5 | Only I can see my conversations; another member cannot read them | Per-user ownership |
| IS-6 | The knowledge-base boundary is unchanged, and persisted history does not weaken it | The feature's core promise |
| IS-7 | A draft I typed but did not send survives a reload | Known-lossy interaction |
| IS-8 | My conversations are removed when my account is permanently deleted | Retention correctness |

| GAP | Difference between that state and today | Why |
|---|---|---|
| GAP-1 | Closing the panel unmounts `AIChatPanel`, discarding `messages` | `AIChatPanel.tsx:53` + `AIChatContext.tsx:79` |
| GAP-2 | No AI session/message tables, no migration, no write path | `ai.ts` performs zero writes |
| GAP-3 | No session list, switch, or delete anywhere in the UI | Feature does not exist |
| GAP-4 | Server never parses `finish_reason`, so a provider dying mid-answer is persisted as complete | `ai.ts:177-208` is a byte proxy |
| GAP-5 | Abort is collapsed into `kind:"network"`; the DB cannot record why a turn ended | `app/utils/aiChat.ts:292,321` |
| GAP-6 | Persisting the messages store to IndexedDB resurrects deleted sessions and double-renders | `StorePersistence.ts:50-63` hydrates without pruning |
| GAP-7 | `user.destroyWithCtx` is a soft delete, so the `userId` FK cascade never fires | `User.ts:136`, `users.ts:628` |
| GAP-8 | Two submits in one tick both pass the `isStreaming` guard (React state read in a closure) | `AIChatPanel.tsx:86` |
| GAP-9 | Unsent composer text is lost on reload | No draft storage |
| GAP-10 | `messages.min(1)` blocks session-derived upstream; the derived `ChatMessages` alias breaks compilation if made optional | `schema.ts:29`, `scope.ts:8` |

### Must have

- Multiple sessions per user per team; header history list; New chat; delete.
- Transcript survives close/reopen (GAP-1) and reload (GAP-2).
- Turn status distinguishing completed / aborted / error / truncated (GAP-4, GAP-5).
- Ownership enforcement on every read and write (IS-5).
- Grounding gate unchanged and still per-send (IS-6).
- User hard-purge for retention (GAP-7, IS-8).

### Must NOT have

- No change to the grounding gate logic or its refusal semantics.
- No Markdown/rich rendering. No tools, agent loop, or structured output.
- No `withPersistence` / `useChat` / provider adapters (they would delete the
  grounding gate and the tested SSE parser).
- No IndexedDB persistence of the messages store (GAP-6).
- No durable/resumable streams.
- No session rename, generated titles, pin/favorite, or history search.
- No `threadId` rename of `sessionId`.

## Verification strategy

- **Per-todo:** the exact commands in each todo's Acceptance criteria. Types via
  `yarn lint` (oxlint type-aware). Tests via `yarn test:server <path>` /
  `yarn test:app <path>`. Migrations verified up **and** down.
- **Integration** lives in the existing `server/routes/api/ai/ai.test.ts`
  (539 lines, `@vitest-isolate true`) â€” extend it, do not regress its streaming
  failure matrix. **Amended by F1:** the streaming *write path* was ultimately
  covered by two NEW colocated files (`aiStreaming.test.ts`,
  `upstreamMessages.test.ts`) rather than by extending `ai.test.ts`, which stays
  green and untouched. Isolation was judged better than mixing persistence
  assertions into the proxy's failure matrix; the plan's original instruction is
  superseded.
- **Concurrency** is proven by a test that forces two simultaneous appends to one
  session and asserts distinct `seq` (todo 4).
- **Manual QA** per todo names a literal `curl -i` or DB assertion with an
  evidence path â€” never "verify it works".
- **Final wave:** F1â€“F4, all must approve. F3 performs real manual QA against a
  running stack on port 3060.
- **Known host limitation:** browser automation has never worked on this host
  (`docs/AI-CHAT-DESIGN.md:413-416`). Playwright is time-boxed (todo 17); the
  jsdom regression test is the guaranteed gate for the close/reopen fix.

## Execution strategy

**Orchestration.** The executor orchestrates only; every implementation, test and
QA action is delegated to a worker. Waves run in order; todos within a wave are
independent and run concurrently.

**Worktree discipline.** Every wave runs in its own task-owned worktree
(`<repo>-wt/<plan>-<wave>`), landing on the integration base before the next
wave. Never implement in the main checkout. Do **not** pass `--worktree`; let
the executor create them.

**Per-wave environment prerequisite (applies to EVERY wave's worktree).** Each
wave's worktree is a fresh checkout, so the ports and database must be
provisioned inside it:

```
# inside the wave's worktree
PORT=3060
VITE_DEV_PORT=3061
URL=http://localhost:3060
```

3060/3061 sit inside this project's reserved 3050-3100 range
(`docs/TECHNICAL-GUIDE.md:161`); the main tree holds 3050/3051
(`docs/TECHNICAL-GUIDE.md:165-166`). Three hard constraints: `PORT` and
`VITE_DEV_PORT` **must differ** or HMR breaks (`AGENTS.md:134-135`); `URL`'s port
**must match** `PORT` (`vite.config.ts:92`); stay strictly inside 3050-3100.
Use the isolated dev database (see todo 1). `yarn build:server` is **mandatory**
before `yarn db:migrate` because migrations are TypeScript (`server/AGENTS.md`);
`build/` is generated and never committed.

**Windows shell hazard.** This host's shell prefixes commands with a CMD-style
`set VAR=value && ...` that PowerShell 5.1 cannot parse, so any `git` command
fails with a `ParserError` before executing. Invoke git through the Node shim
described in `AGENTS.md` ("Shell environment") instead of running `git` directly.

**Port collision under `--make-pr`.** If PR mode gives concurrent lanes their
own worktrees, each needs a distinct port pair from 3050-3100. Recommended: run
this plan in **direct mode** (no `--make-pr`) so waves serialize and 3060/3061
suffice.

## Todos

### Wave 1 â€” Server persistence backbone

- [x] 1. Create `ai_chat_sessions` and `ai_chat_messages` with migration

  **References:** `server/migrations/20260416000000-create-document-insights.js`
  (transactional migration precedent); `server/models/base/IdModel.ts`;
  `docs/AGENTS.md` ("run `yarn db:create-migration --name my-migration`").
  **HEAVY â€” DB schema/migration.**

  **Acceptance criteria:**
  - New file `server/migrations/20261014000000-create-ai-chat-sessions.js`.
  - `ai_chat_sessions`: `id` UUID PK, `teamId` UUID NOT NULL FKâ†’`teams` ON DELETE
    CASCADE, `userId` UUID NOT NULL FKâ†’`users`, `title` STRING(255) NULL,
    `createdAt`, `updatedAt`. Index `[teamId, userId, updatedAt]`.
  - `ai_chat_messages`: `id` UUID PK, `sessionId` UUID NOT NULL FKâ†’
    `ai_chat_sessions` ON DELETE CASCADE, `role` ENUM('user','assistant'),
    `seq` INTEGER NOT NULL, `content` TEXT NOT NULL, `status`
    ENUM('completed','aborted','error','truncated') NOT NULL DEFAULT 'completed',
    `runId` UUID NULL, `createdAt`, `updatedAt`.
  - **UNIQUE index on `[sessionId, seq]`** (NOT a plain index).
  - `createTable("ai_chat_sessions")` runs **before** `createTable("ai_chat_messages")`
    â€” the FK parent must exist first, or Postgres rejects it.
  - Both `createTable`s inside **one** `sequelize.transaction`; `down` drops
    messages then sessions.

  **QA scenarios:**
  - Happy: `$env:NODE_ENV="development"; yarn build:server; yarn db:migrate`
    â†’ both tables exist. Evidence: `yarn db:migrate` output showing the migration
    applied.
  - Happy: `yarn db:rollback` â†’ both tables dropped, no error.
  - Failure: roll back and re-migrate â†’ no `type "..._role" already exists` error
    (the migration is transactional, so `CREATE TYPE` rolls back with it).
    Evidence: second `db:migrate` output.

  **Recommended task executor category:** `deep-low` â€” the FK create-order and the
  transactional-enum behavior are easy to get silently wrong; the worker settles
  them from the cited precedent.

- [x] 2. Add `AIChatSession` and `AIChatMessage` models and register them

  **References:** `server/models/Star.ts` (IdModel + BelongsTo/ForeignKey),
  `server/models/index.ts` (re-export per model; `database.ts` auto-registers via
  `Object.values(models)`).

  **Acceptance criteria:**
  - `server/models/AIChatSession.ts` extends `IdModel`; fields `teamId`, `userId`,
    `title`; `@HasMany(() => AIChatMessage, "sessionId")`; static
    `findOwned(ctx, id, user)` returning a row scoped
    `where: { id, userId: user.id, teamId: user.teamId }` or `null`.
  - `server/models/AIChatMessage.ts` extends `IdModel`; fields `sessionId`, `role`
    (ENUM), `seq`, `content`, `status`, `runId`; `@BelongsTo(() => AIChatSession, "sessionId")`.
    **No `userId` and no `teamId`** â€” authorization is resolved through the session.
  - Both re-exported from `server/models/index.ts`.
  - JSDoc on every exported symbol per `AGENTS.md`.

  **QA scenarios:**
  - Happy: `yarn test:server server/models` passes; a new
    `server/models/AIChatSession.test.ts` asserts `findOwned` returns null for a
    foreign user's id. Evidence: vitest output.
  - Failure: `yarn lint` clean on both files.

  **Recommended task executor category:** `quick` â€” mechanical mirror of
  `server/models/Star.ts` plus two re-export lines.

- [x] 3. Add session policy and presenters

  **References:** `server/policies/star.ts`
  (`allow(User, ["read","update","delete"], Star, isOwner)`);
  `server/presenters/star.ts`; the index files `server/policies/index.ts` and
  `server/presenters/index.ts`.

  **Acceptance criteria:**
  - `server/policies/aiChatSession.ts` registers abilities for `AIChatSession`
    **only**. **No message-level `isOwner` policy** â€” a message has no `userId`,
    so it could never evaluate.
  - `import "./aiChatSession";` added to `server/policies/index.ts`.
  - `server/presenters/aiChatSession.ts` exports `presentAIChatSession`
    (`id`, `title`, `createdAt`, `updatedAt`, and `status`/`seq`/`runId` for
    messages) and both are re-exported from `server/presenters/index.ts`.
  - **No `teamId` or `userId` leaks** in the session presenter output.

  **QA scenarios:**
  - Happy: new `server/presenters/aiChatSession.test.ts` asserts the exact output
    shape and absence of `teamId`/`userId`. Evidence: vitest output.
  - Failure: a policy test asserts a non-owner is denied read/update/delete.

  **Recommended task executor category:** `quick` â€” one-line policy plus two pure
  mappers, both with named in-repo precedents.

- [x] 4. Add write commands with row-locked `seq` assignment

  **References:** `server/commands/starCreator.ts` (`Props { user, ctx }`);
  `server/commands/documentCollaborativeUpdater.ts:65,89-92` (the
  `sequelize.transaction` + `lock: transaction.LOCK.UPDATE` precedent);
  `server/storage/database.ts:114-138` (`retryOnUniqueConstraintError`, whose
  contract states the fn must include the transaction);
  `server/context.ts:9-32` (`createContext({ user, authType, ip, transaction })`);
  `server/commands/subscriptionCreator.ts:131-136` (createContext usage).
  **HEAVY â€” transaction/concurrency boundaries.**

  **Acceptance criteria:**
  - `server/commands/aiChatSessionCreator.ts` â€” creates an owned empty session.
  - `server/commands/aiChatSessionDestroyer.ts` â€” `destroyWithCtx` (messages
    cascade via FK).
  - `server/commands/aiChatMessageCreator.ts` â€” appends a message with this exact
    shape:
    ```ts
    return retryOnUniqueConstraintError(() =>
      sequelize.transaction(async (t) => {
        const ctx = createContext({ user, authType, ip, transaction: t });
        // 1. lock the session row FIRST
        const session = await AIChatSession.findByPk(sessionId, {
          transaction: t, lock: t.LOCK.UPDATE, rejectOnEmpty: true,
        });
        // 2. re-verify ownership against the LOCKED row (closes TOCTOU)
        // 3. seq = max(seq)+1  â€” safe only because the lock is held
        // 4. insert the message row
        // 5. bump session.updatedAt via targeted update
        // 6. set title ONLY when currently null: session.title ?? derive(messages)
        return message;
      })
    );
    ```
  - `retryOnUniqueConstraintError` wraps the **entire transaction closure**, not
    the insert statement â€” a `UniqueConstraintError` aborts the enclosing
    transaction, so a statement-level retry cannot recover.
  - Every write uses `*WithCtx` so the audit `Event` row is emitted, and runs in
    its own short transaction. `ctx.state.transaction` is **never** mutated on a
    long-lived streaming ctx.
  - Title truncated to 255 chars; set only when null (concurrent-first-turn race).

  **QA scenarios:**
  - Happy: `server/commands/aiChatMessageCreator.test.ts` asserts `seq` increments,
    `updatedAt` advances, and a second turn does **not** rewrite `title`.
    Evidence: vitest output.
  - Happy: **concurrency test** â€” two `Promise.all` appends to one session produce
    distinct `seq` values and both rows persist. Evidence: vitest output.
  - Failure: assert no `Logger.warn("No transaction provided to insertEvent")` is
    emitted during a normal write.

  **Recommended task executor category:** `deep-low` â€” hairy concurrency: the
  row lock must be taken before `max(seq)`, and the retry must wrap the whole
  transaction. The exact shape is given above; the reasoning to apply it is not.

- [x] 5. Add user hard-purge for retention

- [x] 19. Colocated test for `CleanupDeletedUsersTask` (discovered during todo 5;
  numbered at discovery time â€” executes at the end of Wave 1)

  **Discovered by orchestrator review of todo 5 â€” repo convention gap.**
  `server/queues/AGENTS.md` requires every new task class to carry a **colocated
  `XxxTask.test.ts`**. `CleanupDeletedUsersTask` is currently covered only from
  `server/commands/userPermanentDeleter.test.ts`, which is the wrong home for it
  and is invisible to anyone running the task's own suite.

  **Acceptance criteria:**
  - `server/queues/tasks/CleanupDeletedUsersTask.test.ts` exists and asserts the
    cron contract: `get cron().interval` is `TaskInterval.Hour`, `options`
    matches the task-priority convention, and `perform` purges a user past the
    30-day window while leaving a user inside it and a non-deleted user alone.
  - The assertions are moved out of `server/commands/userPermanentDeleter.test.ts`
    rather than duplicated there.
  - `yarn test:server server/queues/tasks/CleanupDeletedUsersTask.test.ts` exits 0
    and `yarn tsc --incremental false` exits 0.

  **QA scenarios:**
  - Happy: the task's own suite runs standalone and is green.
  - Failure: temporarily set `RetentionDays` to 0 and confirm the task test fails.

  **Recommended task executor category:** `quick` â€” move existing assertions to
  their conventional home and add the cron-contract assertions.

  **References:** `server/commands/teamPermanentDeleter.ts:98-200` (hard purge,
    `force: true`); `server/queues/tasks/CleanupDeletedTeamsTask.ts` (cron
    scanner) and `CleanupDeletedTeamTask.ts:20` (invokes the deleter);
  `server/commands/teamPermanentDeleter.ts:35-39` (the `if (!team.deletedAt)
  throw` guard); `server/models/User.ts:136` + `server/models/base/ParanoidModel.ts`
  (soft delete); `server/test/` conventions.
  **HEAVY â€” data retention/deletion path.**

  **Acceptance criteria:**
  - `server/commands/userPermanentDeleter.ts` hard-deletes
    `ai_chat_sessions` with `force: true` where `{ userId }`; messages cascade.
  - `server/queues/tasks/CleanupDeletedUsersTask.ts` is a cron scanning
    `User.unscoped().findAll({ where: { deletedAt: { [Op.not]: null } } })` past a
    retention window (30 days, mirroring `CleanupDeletedTeamsTask.ts`) and calls
    the deleter per user. **This task is the caller** â€” without it the purge
    never runs. Tasks are auto-discovered by `server/queues/tasks/index.ts`; no
    manual registration.
  - **Do NOT modify `server/queues/processors/UserDeletedProcessor.ts`.** It
    reacts to the soft `users.delete` event and uses no `force: true`; adding the
    purge there would create soft-deleted orphans and purge on a recoverable
    delete.

  **QA scenarios:**
  - Happy: a soft-deleted user older than the window has their
    `ai_chat_sessions` rows hard-deleted after the task runs. Evidence: DB row
    count before/after.
  - Failure: a soft-deleted user **inside** the window keeps their rows.

  **Recommended task executor category:** `deep-low` â€” a new deletion path with a
  retention window; the forbidden target (`UserDeletedProcessor.ts`) must be left
  untouched, which is a reasoning constraint rather than a mechanical one.

### Wave 2 â€” Server API surface

- [x] 6. Extend schemas: optional `messages`, exported element type

  **References:** `server/routes/api/ai/schema.ts` (current `AiChatSchema`,
  `messages` required at line 29, `AiChatMessageSchema` module-local at 21-24);
  `.refine()` precedent at `server/routes/api/notifications/schema.ts:38` and
  `server/routes/api/accessRequests/schema.ts:26`; `server/middlewares/validate.ts:8-16`.

  **Acceptance criteria:**
  - `export type AiChatMessageInput = z.infer<typeof AiChatMessageSchema>;` â€”
    the element type must be exported (it is currently module-local).
  - `messages` becomes `z.array(AiChatMessageSchema).min(1).max(AiChatMaxMessages).optional()`.
  - A `.refine()` on the object enforcing: `messages` is **required when
    `sessionId` is absent**; may be **omitted when `sessionId` is present**.
  - New schemas for `ai.sessions.create/list/delete` and `ai.messages.list`.
  - **The per-element `role` enum is unchanged** â€” array optionality must not
    weaken the `system`-role rejection.

  **QA scenarios:**
  - Happy: `yarn test:server server/routes/api/ai` green â€” every existing case
    sends non-empty `messages` and still passes.
  - Failure: `{ sessionId }` with no `messages` â†’ accepted (400 only when
    `sessionId` is also absent).

  **Recommended task executor category:** `quick` â€” a schema edit plus a
  `.refine()` following the cited in-repo pattern.

- [x] 7. Decouple `ChatMessages` in scope.ts and resolve upstream messages

  **References:** `server/routes/api/ai/scope.ts:8`
  (`type ChatMessages = AiChatSchemaReq["body"]["messages"]`), `:87-89`
  (`promptText` calls `.filter` unconditionally), `:220-224`
  (`findUngroundedReason`); `server/routes/api/ai/ai.ts:87` (destructures
  `messages`), `:105` (passes to `findUngroundedReason`), `:137-141` (forwards
  the array verbatim upstream).

  **Acceptance criteria:**
  - `scope.ts:8` becomes `type ChatMessages = AiChatMessageInput[];` â€” a
    standalone **non-optional** array. This is REQUIRED: leaving it aliased to the
    schema field makes it `... | undefined` the moment `messages` goes optional,
    and `promptText`'s `.filter` fails to compile.
  - `ai.ts` builds a resolved, non-optional `ResolvedMessages` before any consumer:
    - `sessionId` present â†’ the single new user turn is persisted (todo 8/9), then
      the upstream window is **derived from committed rows**, most recent
      `AiChatMaxMessages` (50), re-asserting `role âˆˆ {user, assistant}`.
    - `sessionId` absent â†’ the schema-guaranteed `ctx.input.body.messages`.
  - **`findUngroundedReason` and the upstream body both receive the resolved
    array**, never `ctx.input.body.messages` directly.
  - Grounding logic itself is **not** modified.

  **QA scenarios:**
  - Happy: `yarn tsc` clean â€” no `| undefined` reaching `.filter`.
  - Failure: with `sessionId` present, the upstream body contains only rows from
      the DB, not the client array. Evidence: captured upstream request body.

  **Recommended task executor category:** `deep-low` â€” cross-module type surgery
  whose failure mode is a compile error that only appears after the schema edit.

- [x] 8. Add session and message read/write endpoints

  **References:** `server/routes/api/stars/stars.ts` (route stack:
  `auth â†’ rateLimiter â†’ validate â†’ transaction â†’ authorize â†’ command â†’ present`);
  `server/middlewares/transaction.ts`; `server/utils/RateLimiter.ts:184-229`
  (members: `TenPerMinute`, `TwentyFivePerMinute`, **`OneHundredPerMinute`**);
  `server/routes/api/ai/ai.ts:79-85` (the 404 feature gate).

  **Acceptance criteria:**
  - Route keys exactly `ai.sessions.create`, `ai.sessions.list`,
    `ai.sessions.delete`, `ai.messages.list`.
  - **Every route checks the `TeamPreference.AIChat` + env feature gate FIRST
    and throws `NotFoundError()`** before any ownership check, matching `ai.ts`
    â€” otherwise the response distinguishes "feature off" from "not yours".
  - Limiters: `OneHundredPerMinute` on both `list` endpoints,
    `TwentyFivePerMinute` on create/delete, `TenPerMinute` unchanged on `ai.chat`.
    Comment that limiter keys are **IP-scoped** (`rateLimiter.ts:34,52`).
  - `ai.messages.list` takes `{ sessionId }` and authorizes **on the session**
    (`findOwned` â†’ `authorize(user, "read", session)`), never on a message.
  - `ai.messages.list` paginates by cursor: `seq < :beforeSeq` (**not** `offset`,
    which shifts under concurrent appends). Response carries `{ messages,
  truncated, cursor }`.
  - Writes use `transaction()` middleware; streaming route `ai.chat` does not.

  **QA scenarios:**
  - Happy: create â†’ list â†’ info-equivalent â†’ delete round-trips. Evidence:
    `curl -i` transcript with JSON bodies.
  - Failure: user B calls `ai.messages.list` with user A's `sessionId` â†’ 404/403,
    and **no row is written**. Evidence: `curl -i` status + DB count.

  **Recommended task executor category:** `unspecified-high` â€” a standard
  multi-file feature (4 endpoints) with a known pattern to mirror.

- [x] 9. Persist turns in the streaming path, with terminal frame and status

  **References:** `server/routes/api/ai/ai.ts:105-118` (grounding gate and its
  early `return`), `:122-127` (abort on client close), `:177-208` (the byte-proxy
  upstream pump); `server/routes/api/ai/scope.ts:196-204` (the accepted
  hallucination ceiling), `:237-250` (grounding is a boolean admit/deny).
  **HEAVY â€” streaming write path; must never hold a transaction across the stream.**

  **Acceptance criteria:**
  - Order inside the handler: validate â†’ resolve ownership (`findOwned` when
    `sessionId`) â†’ **persist the user turn BEFORE grounding** â†’ `findUngroundedReason`
    â†’ on refusal, persist the refusal as an assistant turn **then**
    `refuseWithSseError` â†’ return.
  - On refusal, persist the **exact `t(...)` string sent to the client** (the
    literal at `ai.ts:115`), not the `OutOfScopeRefusal` constant. Note in a
    comment that the stored string is **locale-frozen at send time**.
  - **The assistant turn is flushed on all three exits**: `upstream.on("end")`,
    `upstream.on("error")`, and the client-abort path â€” an abort fires `error`,
    never `end`, so persisting only on `end` loses the answer.
  - **Never persist an empty assistant turn** (`content` is `TEXT NOT NULL` and
    the client optimistically appends `content: ""`).
  - **F2 â€” the server authors its own terminal frame.** Parse the last upstream
    frame for `finish_reason` and emit `event: complete` or `event: truncated`
    before flushing. Do **not** rely on `data: [DONE]` (the OpenAI SDK hides it).
    A stream with a non-null `finish_reason` is complete; otherwise mark the row
    `status: "truncated"`.
  - **F4** â€” mint `runId` per call and persist it on both rows of the turn.
  - When `sessionId` is absent, behavior is **byte-identical to today** and
    **no rows are written** (backward compatibility).

  **QA scenarios:**
  - Happy: a grounded turn writes user + assistant rows in `seq` order, readable
    via `ai.messages.list`. Evidence: DB rows + `curl -i`.
  - Happy: a **refused** prompt writes BOTH the user question and the refusal â€”
    reopening shows a question, not an orphan refusal. Evidence: DB rows.
  - Failure: client abort mid-stream still persists the partial assistant turn
    with `status: "aborted"`. Evidence: DB row.
  - Failure: no `sessionId` â†’ zero rows written, stream unchanged. Evidence: DB
    count before/after.

  **Recommended task executor category:** `deep-high` â€” the hardest todo: three
  write exits, a server-authored terminal frame derived from `finish_reason`, and
  a strict rule that no transaction is ever held across the SSE stream. The
  ordering constraint is a correctness argument, not a lookup.

- [x] 10. Add a per-(user, session) in-flight cap

  **References:** `server/storage/redis.ts` (Redis is already a dependency);
  `server/utils/RateLimiter.ts` (IP-scoped keying, `rateLimiter.ts:34,52`).

  **Acceptance criteria:**
  - Before opening the upstream stream, acquire a Redis lock keyed
    `(userId, sessionId)` with `SET NX EX`. If already held, refuse the request
    rather than opening a second concurrent upstream call.
  - The lock is released on end, error and abort.

  **QA scenarios:**
  - Happy: one turn acquires and releases the lock; a second sequential turn
    succeeds. Evidence: `curl -i` 200 twice.
  - Failure: two simultaneous turns on one session â†’ the second is refused, not
    streamed twice. Evidence: status codes.

  **Recommended task executor category:** `quick` â€” a Redis `SET NX EX` guard with
  release on the three existing exits.

### Wave 3 â€” Client data layer

- [x] 11. Add client models and stores with explicit persistence flags

  **References:** `app/models/Star.ts` (`@Field`, `static modelName`);
  `app/stores/StarsStore.ts`; `app/stores/base/Store.ts:150-152`
  (`enablePersistence` no-ops unless `this.persistable`), `:248,255`
  (`this.persistence?.persist()`), `:467-479` (`fetch` throws when `Info` is not
  in `actions`), `:591-594` (`orderedData` sorts `createdAt` DESC);
  `app/stores/base/StorePersistence.ts:50-63` (hydrate adds, never prunes);
  `app/stores/RootStore.ts:190,196-210` (`getStoreNameForModelName` falls back to
  `pluralize(lowerFirst(modelName))`, which yields `aIChatSessions` â€” wrong),
  `:92` (explicit-name precedent).

  **Acceptance criteria:**
  - `app/models/AIChatSession.ts` and `app/models/AIChatMessage.ts`, each with
    `static modelName` (`"AIChatSession"` / `"AIChatMessage"`) and `@Field` on
    API-backed fields.
  - `app/stores/AIChatSessionsStore.ts`: `actions = [List, Create, Delete]`,
    `apiEndpoint = "ai.sessions"`, **`persistable = true`**.
  - `app/stores/AIChatMessagesStore.ts`: `actions = [List]` only,
    `apiEndpoint = "ai.messages"`, **`persistable = false`**.
  - **`Info` is absent from both**, so `Store.fetch(id)` throws loudly rather
    than 404-ing. No code may call `fetch(id)`.
  - `AIChatSessionsStore` exposes `@computed sessionsByRecency` ordered by
    `updatedAt` DESC â€” `orderedData` sorts `createdAt` and is the wrong order.
  - `AIChatSessionsStore.list` **replaces** the local session set (removes ids
    absent from the response) rather than merging, so a server- or
    other-device-deleted session cannot be resurrected by IndexedDB hydrate.

  **QA scenarios:**
  - Happy: `app/stores/AIChatSessionsStore.test.ts` asserts each action hits the
    right RPC path and `sessionsByRecency` orders by `updatedAt`.
  - Failure: `getStoreForModelName("AIChatMessage")` resolves `aiChatMessages`
    (guards the `aIChatMessages` naming trap). Evidence: unit test.
  - Failure: after `list`, a locally-present session absent from the response is
    removed.

  **Recommended task executor category:** `unspecified-high` â€” two models plus two
  stores, but the `persistable` flags and the replace-not-merge rule are the whole
  point and are easy to get backwards.

- [x] 12. Register both stores explicitly in RootStore

  **References:** `app/stores/RootStore.ts:92` (`registerStore(OAuthAuthenticationsStore,
  "oauthAuthentications")`), `:119` (`enablePersistence()` after registration),
  `:127-138`.

  **Acceptance criteria:**
  - `this.registerStore(AIChatSessionsStore, "aiChatSessions");` and
    `this.registerStore(AIChatMessagesStore, "aiChatMessages");` â€” explicit names,
    placed **before** `AuthStore` registration.
  - **Both the explicit name AND `static modelName` are required**: the explicit
    name fixes the field key, the modelName is what `getStoreForModelName`
    matches when resolving relations.

  **QA scenarios:**
  - Happy: `useStores().aiChatSessions` is defined at runtime. Evidence: unit test
    or a store-instantiation assertion.
  - Failure: `yarn lint` clean; no `invariant` throw at boot.

  **Recommended task executor category:** `quick` â€” two registration lines; the
  naming trap is already spelled out in the acceptance criteria.

- [x] 13. Extend the client chat util: sessionId, draft, status, cursor

  **References:** `app/utils/aiChat.ts` (`streamAiChat`, `AiChatError`,
  `AiChatErrorKind`, `parseSSEStream`, `parseFrame`, `extractDelta`),
  `:90` (`finish_reason` is already declared but never read), `:292,321`
  (abort collapsed into `kind:"network"`); `app/AGENTS.md` ("Do not hand-edit
  shared/i18n/locales").

  **Acceptance criteria:**
  - `streamAiChat(messages, options)` accepts an optional `sessionId` and sends it
    **in the request body**, not as a header or transport option.
  - Add `AiChatErrorKind` `"truncated"`; split the abort branch so a user Stop is
    **not** reported as `kind: "network"`.
  - Session CRUD helpers via `ApiClient` (`createSession`, `listSessions`,
    `listMessages`, `deleteSession`) â€” the streaming path keeps its raw `fetch`.
  - Draft helpers on `localStorage`: key `aiChat.draft.<sessionId>` plus
    `aiChat.draft.pending` for the pre-create window; debounced write, cleared on
    send, GC'd on session delete. Best-effort, never a correctness dependency.

  **QA scenarios:**
  - Happy: `app/utils/aiChat.test.ts` asserts `sessionId` appears in the body when
    supplied and is absent otherwise.
  - Failure: a truncated stream surfaces `kind: "truncated"`, distinct from
    `network` and from a user Stop.

  **Recommended task executor category:** `unspecified-high` â€” extends one
  transport module and adds CRUD helpers plus draft storage.

### Wave 4 â€” Panel UI

- [x] 14. Make the provider store-backed and the sidebar element stable

  **References:** `app/components/AIChat/AIChatContext.tsx:66-93` (`AIChatContent`
  effect: `setSidebar(<AIChatPanel/>)` / `setSidebar(null)`), `:105-144`
  (`AIChatProvider`, `requested` boolean), `:32-58` (module bridge);
  `app/components/RightSidebarContext.tsx:19`;
  `app/scenes/Document/hooks/useDocumentSidebar.tsx:156-165` (the **stable-element
  precedent** the Document sidebar uses to survive panel switches).

  **Acceptance criteria:**
  - `AIChatProvider` continues to own open/close only; transcript and session
    state live in the stores (todo 11).
  - The element handed to `setSidebar` must have **stable identity**: keep
    `onClose` in a `useCallback` with a stable dep list and do not thread
    per-keystroke state through its props.
  - Closing still calls `setSidebar(null)` â€” that is what drives the slide-out
    animation in `Layout`.

  **QA scenarios:**
  - Happy: open panel, send a message, **close, reopen** â†’ transcript intact.
    Evidence: jsdom test result (see todo 16).
  - Failure: switching sessions while streaming does not remount the panel.

  **Recommended task executor category:** `deep-low` â€” the fix for the reported
  bug; a naive props change reintroduces remount churn that only shows as the
  transcript silently resetting.

- [x] 15. Add the history list, New chat, and disclosure to the panel

  **References:** `app/components/AIChat/AIChatPanel.tsx` (whole file; `messages`
  at `:53`, submit guard at `:86`, transcript render at `:187-211`, styles at
  `:260-348`); `docs/AI-CHAT-DESIGN.md` Â§6.1 (`scrollable={false}` +
  `min-height: 0` â€” **the panel must keep these or the composer is clipped**) and
  Â§6.2 (flex-basis traps); `app/scenes/Document/components/SidebarLayout.tsx`.

  **Acceptance criteria:**
  - New `app/components/AIChat/AIChatHistory.tsx`: a dropdown anchored in the
    `SidebarLayout` header, listing sessions by `title`/`updatedAt` with a "New
    chat" action and per-item delete.
  - Delete requires a confirmation step; deleting the active session starts a new
    one.
  - The transcript renders from the messages store ordered by `seq` ASC â€” **not**
    `orderedData` (which is `createdAt` DESC).
  - Assistant turns with `status` `truncated` / `aborted` / `error` are visibly
    marked so a short answer is never read as complete (IS-4).
  - A one-line disclosure is shown (IS-6). **Amended by F1:** the criterion
    originally said sessions "are private to the user and may reference content
    whose access has since changed". That framing was rejected during
    implementation â€” it describes an access-control risk the feature does not
    have. The shipped disclosure frames the real risk instead: answers are
    generated text that may be wrong or out of date, i.e. **durable
    fabrication**. Rationale for the original framing's rejection: the proxy
    never injects document content (`ai.ts:137-141`) and grounding is a boolean
    admit/deny (`scope.ts:237-250`), so the residual risk is **durable
    fabrication**, the same class already accepted at `scope.ts:196-204`. The
    test locks the corrected wording.
  - `SidebarLayout scrollable={false}` and `min-height: 0` are preserved.
  - All new strings use `t(...)`; no hand-edited locale files.

  **QA scenarios:**
  - Happy: two sessions exist; switching shows the correct transcript for each.
    Evidence: jsdom test.
  - Failure: delete without confirming changes nothing.

  **Recommended task executor category:** `visual-engineering` â€” the visible
  feature: a header dropdown, list rendering, status markers, and a disclosure.
  Must preserve the `min-height: 0` / `scrollable={false}` fixes from
  `docs/AI-CHAT-DESIGN.md` Â§6.1â€“6.2 or the composer clips.

- [x] 16. Regression test for the reported bug

  **References:** `app/components/AIChat/` colocated tests;
  `vitest.config.ts:117-130` (the `app` project is jsdom); `app/AGENTS.md`
  ("Tests: colocated `*.test.ts`").

  **Acceptance criteria:**
  - A jsdom test that mounts the panel, appends a message, unmounts (simulating
    close), remounts, and asserts the transcript is **still present**. This is
    the regression guard for IS-1 and must fail against the pre-fix behavior.
  - A second test asserting the session list renders and switch selects the right
    transcript.

  **QA scenarios:**
  - Happy: `yarn test:app app/components/AIChat` green.
  - Failure: **prove the test bites** â€” temporarily revert the store wiring and
    confirm the test fails, then restore.

  **Recommended task executor category:** `quick` â€” two colocated jsdom tests.

### Wave 5 â€” Time-boxed E2E and docs

- [x] 17. Attempt Playwright E2E; fall back to jsdom on host limits

  **References:** no `playwright.config.*` exists in this repo (verified);
  `docs/AI-CHAT-DESIGN.md:413-416` records that browser automation has been
  unavailable on this host ("Windows named-pipe discovery is not implemented").

  **Acceptance criteria:**
  - **Time-boxed.** Add `playwright.config.ts` targeting `http://localhost:3060`
    and a `test:e2e` script, with scenarios: close/reopen keeps the transcript;
    reload rehydrates from the server; session switch and delete; draft restore.
  - **If the host blocks browser automation, stop and record it** â€” land on the
    jsdom tests as the gate and state plainly that the cache-reconciliation
    regression has **no E2E gate**. Do not commit a knowingly-broken harness.
  - If E2E is green, F3 runs the browser surface. If it is not, F3 runs the jsdom
    surface and its report says which was used.

  **QA scenarios:**
  - Happy: `yarn test:e2e` passes, or the host limitation is documented with the
    exact error. Evidence: command output or the recorded error.

  **Recommended task executor category:** `unspecified-high` â€” introduces a
  harness that does not exist yet, and requires an honest fallback decision when
  the host blocks it.

- [x] 18. Update the AI chat documentation

  **References:** `docs/AI-CHAT-DESIGN.md:34` ("Persistence â€” none" â€” now false),
  `:34-35`, `:137-141`, `:157-166` (failure-mode table), `:196-204`;
  `docs/AI-CHAT.md:211` (documents `messages` as required 1â€“50), `:248-251`.

  **Acceptance criteria:**
  - `AI-CHAT-DESIGN.md`: replace "Persistence â€” none" with the session model;
    document the terminal frame and turn status; add the corrected stored-answer
    risk (durable fabrication, **not** access-control exfiltration â€” the proxy
    never injects document content); add the retention stance.
  - `AI-CHAT.md`: document all four new endpoints with `curl` recipes, and
    correct the `messages` contract â€” it is **optional when `sessionId` is
    present**.
  - Existing curl recipes in `AI-CHAT.md` must still be valid unchanged.

  **QA scenarios:**
  - Happy: every documented `curl` command in `AI-CHAT.md` is copy-pasteable.
    Evidence: doc diff.
  - Failure: no stale "Persistence â€” none" claim remains. Evidence: grep returns
    nothing.

  **Recommended task executor category:** `writing` â€” prose edits to two existing
  docs; the risk is stating a false threat model, which the criteria pin down.

## Wave 6 â€” Final-wave remediation

Raised by F1/F2/F4. Each row is a concrete, verified defect, not a note.

- [x] 20. IS-7: wire the draft helpers into the composer (F4 â€” critical)

  The helpers exist in `app/utils/aiChat.ts:611-706` and are unit-tested, but
  **no component calls them**. `AIChatPanel.tsx:13` imports only `{ AiChatError,
  streamAiChat }`; `input` is plain `useState("")` and `handleChange` only calls
  `setInput`. An unsent draft is still lost on reload â€” GAP-9 is unchanged in
  the product.

  **Acceptance criteria:** `handleChange` calls `writeDraft(text, sessionId ??
  undefined)`; the panel seeds `input` from `readDraft(...)` on mount and on
  session change; `clearDraft(...)` is called on send. A jsdom test types without
  sending, unmounts, remounts, and asserts the input carries the text â€” it must
  **fail** against today's panel.

- [x] 21. IS-1: restore the active session on panel mount (F4 â€” major)

  Data survives close/reopen, but the panel remounts with `sessionId === null`
  (`AIChatPanel.tsx:68`) and nothing auto-selects (`AIChatPanel.tsx:87-89`), so
  the user reopens to an **empty** conversation. Worse, the regression test's
  `selectSession()` helper re-clicks the dropdown on every mount
  (`AIChatPanel.test.tsx:442-447`), so it cannot fail.

  **Acceptance criteria:** the selected session id survives the unmount (hold it
  in `AIChatSessionsStore` or select `sessionsByRecency[0]` once `list()`
  resolves). The regression test must open â†’ send â†’ close â†’ reopen with **no
  dropdown interaction** and assert the transcript â€” the `selectSession()`
  helper is removed so the test fails against today's behaviour.

- [x] 22. Emit the audit `Event` on the session timestamp bump (F2 â€” major)

  `aiChatMessageCreator.ts:119` uses a raw static `AIChatSession.update`, which
  does not fire the instance `@AfterUpdate` hook, so **every chat turn writes a
  title/`updatedAt` with no audit event**. The code comment justifies it by
  avoiding a concurrent clobber, but the row is already held under
  `FOR UPDATE`, so that cannot occur.

  **Acceptance criteria:** use `session.updateWithCtx(txCtx, updates)`; assert an
  `Event` row is emitted for the update; drop the `silent: true` handling.

- [x] 23. Answer 404, not 403, for a missing or foreign session (F2 â€” minor)

  `aiSessions.ts:119` and `:145` pass `findOwned`'s `null` straight into
  `authorize`, which throws `AuthorizationError` (403), while `ai.ts:291` and
  `resolveUpstreamMessages` throw `NotFoundError` (404) for the identical
  condition. The file's own JSDoc argues 404 is intended, and the tests
  paper over it with `expect([403, 404]).toContain(status)`.

  **Acceptance criteria:** `if (!session) { throw NotFoundError(); }` before
  `authorize`; the two tests tightened to `toEqual(404)`.

- [x] 24. Remove dead code and misleading comments in the panel (F2 â€” minor)

  `AIChatPanel.tsx:100,108-110` â€” `let current` / `void current` is read by
  nothing, and the comment claiming a stale response "is dropped" is false (only
  the rejection is swallowed; rows are merely stamped with the old `sessionId`).
  `:113-118` duplicates the same four-line comment verbatim.
  `AIChatHistory.tsx:116` â€” `side={isMobile ? "bottom" : "bottom"}`, both
  branches identical.

  **Acceptance criteria:** the dead flag and the false comment are gone, the
  duplicated block is removed, the no-op ternary is collapsed; the accurate
  replacement comment explains what actually happens.

- [x] 25. Route the new user-facing copy through `t()` (F2 â€” minor)

  `turnMarker` returns bare English ("Response cut short", "Stopped", "Failed")
  and `AiChatError` messages are rendered verbatim by `errorText`. Root
  `AGENTS.md` extracts translations from literals, so these can never localize.

  **Acceptance criteria:** `turnMarker` returns a translation key and `t()` is
  called at the render site; `errorText` maps `kind`/`status` to `t()` copy
  instead of surfacing `error.message` raw.

- [x] 26. Deduplicate the AI-chat feature gate (F2 â€” minor)

  The three-condition gate is written twice in the same folder:
  `assertAiChatEnabled` in `aiSessions.ts:46` and inline in `ai.ts:264`.
  Security-relevant logic duplicated; a fix to one silently misses the other.

  **Acceptance criteria:** one exported definition, imported by both; a test
  proving all five routes 404 when the gate is closed.

## Wave 7 â€” Second-round remediation

Raised by the F1/F2 re-reviews of Wave 6.

- [x] 27. Restore the `updatedAt` bump on every turn (F1 â€” major, REGRESSION)

  Row 22's fix introduced a new defect. `updateWithCtx` â†’ `set(updates)` â†’
  `save()` computes `options.fields` from `changed()`, and Sequelize only pushes
  `updatedAt` **when there is at least one changed field**; with none, it
  returns early before the UPDATE and before the `@AfterUpdate` hook
  (`sequelize/lib/model.js:2374,2393,2470-2473`). Since `updates` is empty on
  any turn after the first (title already set), turns 2..N now write **no
  UPDATE, no `updatedAt`, and no audit Event**. `sessionsByRecency` and the
  dropdown's relative timestamp both read that column, so a conversation used
  today renders as "2 days ago".

  **Acceptance criteria:** every append bumps `updatedAt` and emits an
  `ai_chat_sessions.update` Event, first turn and all subsequent turns alike. A
  test appends **twice** and asserts both â€” the current test appends once,
  which is why this was invisible. Remove or correct the false comment claiming
  `save` always writes `updatedAt`.

- [x] 28. Remove the dead CRUD helpers and fix draft GC on session delete (F2 â€” minor)

  `createSession`/`listSessions`/`listMessages`/`deleteSession` and three
  exported interfaces in `app/utils/aiChat.ts` have **zero production callers**;
  they duplicate `AIChatSessionsStore` / `AIChatMessagesStore`. Worse,
  `deleteSession`'s `clearDraft(id)` is the only draft GC on session delete â€”
  production calls `aiChatSessions.delete()` (`AIChatHistory.tsx:84`), which
  never GCs, so **every deleted conversation orphans a localStorage draft**.

  **Acceptance criteria:** the dead functions, interfaces and their tests are
  removed; `clearDraft(session.id)` runs in `handleConfirmDelete` after the
  store delete succeeds; a jsdom test deletes a session and asserts the draft
  key is gone.

- [x] 29. Correct the stale JSDoc on `openAIChatPanel` (F2 â€” minor)

  `AIChatContext.tsx:161-163` says "Todo 6 (the command-bar action) should call
  this hook" â€” that work is already shipped
  (`app/actions/definitions/navigation.tsx:210`). Same false-comment class row
  24 was opened to eliminate.

  **Acceptance criteria:** the JSDoc states the real contract â€” the command-bar
  action calls the module bridge `openAIChatPanel`, which no-ops when the
  provider registered no handler â€” and the todo number is gone.

- [x] 30. Scope the stateless-chat row-count assertion (F2 follow-up â€” flaky test)

  `aiStreaming.test.ts` :: `writes nothing and leaves the stream byte-identical
  without a sessionId` asserts `AIChatMessage.count()` â€” a **global** count.
  It passes alone (13/13) and fails whenever a sibling file that inserts message
  rows outside the test transaction runs concurrently (observed: `expected 6993
  to deeply equal 6994`). The behaviour under test is correct; the assertion is
  not isolated.

  **Acceptance criteria:** the assertion is scoped to this test's own user (or
  session) so a concurrent suite cannot perturb it; the file passes both alone
  and alongside `aiChatMessageCreator.test.ts`.

- [x] 31. Fix the stale test-name pointer in `docs/AI-CHAT-E2E.md` (F2 follow-up)

  `docs/AI-CHAT-E2E.md:42` cites two tests deleted by row 28:
  `listMessages should return the messages/truncated/cursor envelope` and
  `deleteSession should hit ai.sessions.delete with the session id`.

  **Acceptance criteria:** both dead names are dropped, the surviving name is
  kept, and the draft-GC coverage that moved to `AIChatHistory.test.tsx` is
  cited. Every test name the document mentions must exist in the file it cites.

## Final verification wave

Runs in parallel; all must approve. Surface results and wait for the user's
explicit okay before declaring complete.

- [x] F1. Plan compliance audit â€” every todo's acceptance criteria and QA
  scenario actually ran, with evidence paths that exist. Reject any completion
  backed only by a worker summary or a grep hit.

- [x] F2. Code quality review â€” adherence to `server/AGENTS.md`, `app/AGENTS.md`,
  `app/stores/AGENTS.md`; no `any`, no `@ts-ignore`; JSDoc on exported symbols;
  `*WithCtx` on every write; no raw Sequelize in a route.

- [x] F3. Real manual QA â€” against a running stack on port 3060, with real
  evidence: `curl -i` for the session lifecycle; a browser check of the history
  dropdown if the host allows it, otherwise a recorded jsdom result. Confirm the
  close/reopen regression is fixed on the real surface.

- [x] F4. Ideal-state fidelity â€” IS-1 through IS-8 checked one by one against the
  delivered behavior. Any shortfall becomes a new `- [ ] N.` row, never a note.

## Commit strategy

One commit per completed todo, Conventional Commits with scope, branching from
the integration base per wave:

```
feat(ai-chat): add ai_chat_sessions and ai_chat_messages migration
feat(ai-chat): add session and message write commands with row-locked seq
feat(ai-chat): add ai.sessions and ai.messages RPC endpoints
fix(ai-chat): persist assistant turn on stream end, error and abort
feat(ai-chat): add AIChatSessions and AIChatMessages stores
fix(ai-chat): keep AI chat transcript across panel close and reopen
docs(ai-chat): document session endpoints and turn status
```

Never commit `build/`. Run `yarn lint` before each commit â€” **Husky is not
installed on this fork, so the pre-commit hook does not run** (`AGENTS.md`).
`yarn format:check` reports ~2601 pre-existing unformatted files; format only
files this change touches.

## Success criteria

| IS | Delivering todo(s) | QA scenario that proves it | Evidence |
|---|---|---|---|
| IS-1 transcript survives close/reopen | 11, 14, 16 | jsdom close/reopen regression test | vitest output for `app/components/AIChat` |
| IS-2 survives reload, identical across devices | 8, 9, 11 | `ai.messages.list` returns rows after reload | `curl -i` + DB rows |
| IS-3 list / switch / delete | 15 | history dropdown renders; switch shows correct transcript | jsdom test |
| IS-4 turn status is honest | 9, 13, 15 | truncated stream marks the row; client raises `kind:"truncated"` | DB row + unit test |
| IS-5 only I see my conversations | 3, 8, 12 | user B reads user A's session â†’ 404/403, no write | `curl -i` status + DB count |
| IS-6 KB boundary unchanged | 7, 9, 15 | grounding refusal still refuses; persisted history does not bypass it | existing `ai.test.ts` refusal cases stay green |
| IS-7 draft survives reload | 13, 15 | draft helper round-trips through `localStorage` | unit test |
| IS-8 removed on permanent deletion | 5 | purge task removes rows past the window | DB row count |
| (correctness) distinct `seq` under concurrency | 4 | two concurrent appends get distinct `seq` | concurrency unit test |
| (correctness) no transaction held across the stream | 4, 9 | assert no `No transaction provided` warning; short writes only | test output |
