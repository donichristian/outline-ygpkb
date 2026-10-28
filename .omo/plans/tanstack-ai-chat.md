# Plan: AI Chat — Lighter Transport Prove (slice 1)

- status: ready
- intent: clear
- review_required: false
- reviews: metis (passed, folded), momus (spec->plan gate, folded), oracle (blockers folded)
- slug: tanstack-ai-chat
- created: planning session (Prometheus / ulw-plan)
- decision: **P2 — hand-rolled Koa SSE first, zero new deps; TanStack AI deferred to slice 2**
- branch: `feat/ai-chat` cut from `development` (NOT `main`), in an isolated git worktree; PR base is `development`

## Git & worktree discipline (PRECONDITION — do this first)

Per `AGENTS.md:77-86`, the branch hierarchy is **`main` → `development` →
feature branches**. ALL feature work branches off **`development`**, never
`main`; PRs are opened **against `development`**.

This plan MUST be executed in an **isolated git worktree** so it never disturbs
the shared `development` checkout (another agent is working on this branch).

- **Worktree + branch setup (run before any todo):**
  ```sh
  # from the main repo root, using the vcs shim for git (see AGENTS.md shell note)
  git worktree add ../outline-ygpkb-aichat -b feat/ai-chat development
  # then do ALL work in ../outline-ygpkb-aichat
  ```
  - Branch name: `feat/ai-chat` (feature branch, prefix `feat/`).
  - Base: **`development`** (NOT `main`). Confirm the base is `development` before
    branching; a branch off `main` would bypass the integration branch and miss
    already-merged work.
- **Isolation:** create the worktree from a clean, up-to-date `development`
  (`git fetch` then branch from `origin/development` if local is behind). Never
  commit to the shared checkout; never `git stash`/switch branches in the main
  working tree.
- **During work:** commit per todo (Conventional Commits with scope, e.g.
  `feat(ai): …`) inside the worktree only.
- **Handoff:** open a PR from `feat/ai-chat` **into `development`**. Do NOT target
  `main`.
- **On completion:** remove the worktree (`git worktree remove`) once merged/abandoned.

## Goal

Add a workspace-gated AI chat to the Outline fork, delivered first as a
**transport spike**: a streaming `POST /api/ai.chat` Koa route that proxies the
local OpenAI-compatible gateway (`http://localhost:20127/v1`,
`/chat/completions`, `stream: true`) to a React chat panel rendered as a
**right-sidebar slide-over**, gated by a new `TeamPreference.AIChat`.

Slice 1 adds **NO new npm dependencies**. It proves the properties that make an
in-app AI chat feasible in this codebase: SSE flush through Koa, `koa-compress`
bypass, socket-timeout survival, CSRF on a streamed POST, abort-on-disconnect,
and a clean error taxonomy. TanStack AI is layered on this proven transport in
slice 2 (see "Slice 2 (deferred)").

## Affected user & ideal state

| User | Today | Ideal state after |
|------|-------|-------------------|
| Outline member | Must leave the app for an external Hermes CLI/Telegram bot | Opens an in-app panel, asks a question, sees a streamed answer |
| Workspace admin | No control over in-app AI | `AI chat` toggle in Settings > AI; the endpoint 404s when off |
| Security owner | Read-only posture enforced by absence of write tools | Same guarantee: no write path, chat has no server persistence |

Ideal-state properties (each closes a gap below):
1. Every answer streams token-by-token; no spinner-then-dump.
2. Nothing renders and no endpoint is reachable when the gate is off/unset.
3. Chat can only READ — no create/update/delete path exists in the route.
4. Long answers are not killed by the socket inactivity timeout.
5. Answers respect per-user session auth exactly like every other API route.
6. The feature degrades quietly when the provider env is unset (no crash).

## Gap list (today -> ideal) with reason

| # | Gap | Reason |
|---|-----|--------|
| G1 | No in-app chat surface | feature does not exist |
| G2 | No `TeamPreference.AIChat` | cannot gate the feature |
| G3 | No `/api/ai.chat` route | no server entry point |
| G4 | No streaming transport in `ApiClient.ts` | JSON-only client; SSE needs its own fetch reader |
| G5 | No Web->Node stream bridge in an API route | Koa expects a Node `Readable` |
| G6 | `koa-compress` sits above `/api` | would buffer/compress SSE |
| G7 | `REQUEST_TIMEOUT` 10s socket inactivity | kills slow-first-token streams |
| G8 | No provider integration | no LLM client/route |
| G9 | No abort-on-disconnect | leaks upstream gateway requests on `stop` |
| G10 | No error taxonomy for streams | flushed headers can't carry a JSON error |

## Verified constraints (ground truth — do not re-litigate)

- **Same-origin, no vite proxy.** SPA is served by Koa; `/api` mounted at
  `server/services/web.ts:90`. Vite serves only `/static/`.
- **CSRF applies** to `POST /api/ai.chat`: `chat` is not in
  `AuthenticationHelper.methodToScope` so it resolves to `Scope.Write`
  (`shared/helpers/AuthenticationHelper.ts:16-30`, `server/middlewares/csrf.ts:48-74`).
  Client must send header `x-csrf-token` read from cookie `__Host-csrfToken`
  (secure) or `csrfToken` (http) — `app/utils/csrf.ts:10-12`, `shared/constants.ts:44-53`.
- **`fetchServerSentEvents`/plain `fetch` bypasses `ApiClient`**, so the CSRF
  header and version headers must be attached manually (Momus C7).
- **Streaming escape hatches:** `ctx.body = Readable.fromWeb(res.body)` passes
  `apiResponse` untouched (`server/routes/api/middlewares/apiResponse.ts:5-23`
  skips `Readable`/`Buffer`; zip precedent `server/utils/koa.ts:58`); OR MCP
  raw response `ctx.respond=false` + `ctx.res.writeHead/write/end`
  (`server/routes/mcp/index.ts:100-129`) — the fallback.
- **`koa-compress`** is global (`server/services/web.ts:72`); default filter is
  `compressible` (`node_modules/koa-compress/lib/index.js:60`) which matches
  `text/event-stream`; bypass is `ctx.compress = false` (read at line 102).
  No per-route precedent exists — this plan adds the first.
- **Timeout is connection-level:** `server.setTimeout(env.REQUEST_TIMEOUT)`
  (`server/main.ts:152`) — NOT per-route. Per-request fix is
  `ctx.req.setTimeout(...)` inside the handler.
- **`koa-body` drains the request** into `ctx.request.body` before any route
  (`server/routes/api/index.ts:63-77`), so the handler reads `ctx.request.body`.
- **`apiErrorHandler`** only re-shapes thrown errors and cannot rewrite a
  flushed response (`server/routes/api/middlewares/apiErrorHandler.ts`).
- **TeamPreference wiring:** `shared/types.ts:506` (enum) + `:524` (type);
  `shared/constants.ts:98` (`TeamPreferenceDefaults`); CRITICAL
  `server/routes/api/teams/schema.ts:46-83` is `.strictObject().partial()` so a
  new key MUST be added or `teams.update` rejects it. Omitting the key from
  `TeamPreferenceDefaults` is a SILENT default-`false` (fields are all optional;
  `server/models/Team.ts:367`). Generic loops need no change
  (`server/commands/teamUpdater.ts:74`, `server/presenters/team.ts:26`).
- **Settings UI:** `app/scenes/Settings/Features.tsx` is already titled "AI"
  (`SparklesIcon`); MCP toggle pattern at `:25-32` (handler) and `:59-112` (row).
- **Right sidebar:** `RightSidebarContext` is an EPHEMERAL React node
  (`app/components/RightSidebarContext.tsx`; rendered by `app/components/Layout.tsx:41,73`),
  distinct from the persisted `UiStore.rightSidebar` enum
  (`app/stores/UiStore.ts:35`). Slice 1 uses the ephemeral context node.
- **Live gateway verified:** `:20127` `/v1/models` returns 200 (OpenAI-compatible,
  streaming-capable). `:3050` `/_health` 200, `/mcp` 401 challenge.
- **Tooling:** Husky is not installed; run `yarn lint` / `yarn tsc` manually.
  `yarn build:i18n` fails on Windows. Git must go through the `vcs.mjs` shim.

## Must-NOT-have (guardrails)

- No write tools/endpoints — the chat route is read-only HTTP; it must not call
  any `commands/` write path.
- No browser-supplied (BYOK) provider keys; the gateway key stays server-side.
- No touching other agents' files; prefer new files; minimize edits to shared
  hot files (`web.ts`, `env.ts`, `teams/schema.ts`, `Features.tsx`, `index.ts`).
- No new test directories — colocated `*.test.ts` only.
- No hand-editing `shared/i18n/locales/` (new string ships as untranslated EN).
- No global changes to `REQUEST_TIMEOUT` or the `compress()` config.
- No new npm dependencies in slice 1.
- Do not rename the `ai.chat` action after lock (it is a CSRF control).
- Do not touch `graphify-out/`; `.omo/` is planning-only.
- **All work happens in a dedicated worktree on branch `feat/ai-chat` cut from
  `development` — never on `main`, never in the shared checkout.**
- PR base is **`development`**; never open a PR against `main`.

## Dependency DAG (acyclic)

```
0 (worktree + feat/ai-chat from development)   ← PRECONDITION
   └─> 1 (env vars)
          └─> 2 (TeamPreference: types+type+constants+schema)
                 └─> 3 (server SSE route + schema)  ← also needs 1
                        └─> 4 (client SSE reader hook)
                               └─> 5 (right-sidebar slide-over UI)
                                      └─> 6 (frontend gate wiring)
7 (Settings toggle)  ← needs 2
8 (tests)            ← needs 3,4,5
9 (docs + slice-2 stub) ← needs all
```
Ordering rule: `TeamPreference` (todo 2) must land before the route gate (todo 3)
and the Settings toggle (todo 7). Route (3) must precede client (4) and UI (5).
Todo 0 (worktree/branch) must precede everything.

## Verification gate (run in this order, after every batch)

```
yarn lint
yarn tsc
yarn test <the colocated test file you touched>
```

---

## Todos

- [x] 1. `server/env.ts`: add optional `AI_CHAT_BASE_URL`, `AI_CHAT_API_KEY`, `AI_CHAT_MODEL` vars (fail-soft) - route can read provider config with no crash when unset
  Recommended task executor category: unspecified-high
  - Target: `server/env.ts` — add three zod fields. Follow the existing optional/env-gated pattern (`@IsOptional`; use `@CannotUseWithout("AI_CHAT_BASE_URL")` for key/model if that decorator is available at `env.ts:335/342/580`, else plain `.optional()`).
  - **Must NOT** mark `AI_CHAT_API_KEY` as `@Public` (would leak the key to the browser).
  - Copy-from: the nearest existing optional var block in `server/env.ts` (read the file; reuse its decorator style).
  - Acceptance: with none of the three set, the server boots and `/_health` returns 200; `env.AI_CHAT_BASE_URL === undefined`.
  - QA (happy): `yarn tsc` passes. QA (failure): boot with `AI_CHAT_API_KEY` set but no `AI_CHAT_BASE_URL` → either a clear validation error (if `@CannotUseWithout`) or key ignored — document which; must NOT crash.
  - Commit: `feat(ai): add optional AI chat provider env vars`

- [x] 2. `shared/*` + `server/routes/api/teams/schema.ts`: add `TeamPreference.AIChat` (4 coordinated edits) - preference persists and defaults to false
  Recommended task executor category: unspecified-high
  - Target edits (all four, or the build/API breaks):
    1. `shared/types.ts:506` area — add `AIChat = "aiChat"` to `enum TeamPreference`.
    2. `shared/types.ts:524` area — add `[TeamPreference.AIChat]?: boolean;` to `type TeamPreferences`.
    3. `shared/constants.ts:98` area — add `[TeamPreference.AIChat]: false,` to `TeamPreferenceDefaults` (explicit — omission is a SILENT false).
    4. `server/routes/api/teams/schema.ts:78` area — add `[TeamPreference.AIChat]: z.boolean(),` inside the `.strictObject({...})`.
  - Acceptance: `teams.update` with `preferences: { aiChat: true }` returns 200 and `presenter` echoes it; unknown keys still rejected.
  - QA (happy): `yarn tsc` passes; a `teams.update` round-trip test (colocated) sets and reads back `aiChat`.
  - QA (failure): omitting edit #4 → adding `aiChat` returns a validation error (proves `.strictObject`); omitting edit #3 → still compiles (proves the silent-default trap).
  - Commit: `feat(ai): add TeamPreference.AIChat workspace gate`

- [x] 3. `server/routes/api/ai/{ai.ts,schema.ts,index.ts}` + register in `server/routes/api/index.ts`: streaming `ai.chat` route - SSE flushes, no new deps
  Recommended task executor category: unspecified-high
  - New files: `server/routes/api/ai/ai.ts` (router), `server/routes/api/ai/schema.ts` (zod), `server/routes/api/ai/index.ts` (`export { default } from "./ai"`).
  - Register: in `server/routes/api/index.ts` add `import ai from "./ai";` (import block ~:17-56) and `router.use("/", ai.routes());` (~:92-126). Copy-from the `documents` import/registration lines.
  - Handler `router.post("ai.chat", ...)` middleware: `auth({ type: [AuthenticationType.APP] })` (session only — S6) → `rateLimiter(RateLimiterStrategy.TenPerMinute)` → `validate(T.AiChatSchema)`. **No `transaction()`.**
  - Handler body:
    - Gate: `if (!user.team.getPreference(TeamPreference.AIChat) || !env.AI_CHAT_BASE_URL) { throw NotFoundError(); }` (mirror `server/routes/mcp/index.ts:66-68`).
    - `ctx.compress = false;` (S3).
    - `ctx.req.setTimeout(0);` (B1).
    - Build `AbortController`; `ctx.req.on("close", () => { if (!ctx.res.writableEnded) ac.abort(); })` (S1).
    - Call the gateway `POST ${env.AI_CHAT_BASE_URL}/chat/completions` with `{ model: env.AI_CHAT_MODEL, stream: true, messages }` via global `fetch`, forwarding `ac.signal`.
    - `ctx.body = Readable.fromWeb(res.body as ReadableStream)`; set SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`). Copy the header-set style from `server/utils/koa.ts:46-50`.
    - If `Readable.fromWeb` buffers (see QA), fall back to MCP raw pattern (`ctx.respond=false` + pump `Readable.fromWeb(...).pipe(ctx.res)`), `server/routes/mcp/index.ts:100-129`.
  - Input caps (S4) in `schema.ts`: zod object with `messages: z.array(...).max(50)`, per-message `content` length cap, and reject/ignore client `role: "system"` (server prepends any fixed system prompt).
  - Error matrix (B3): (1) pre-stream (gate/auth/CSRF/validate) → normal JSON via `apiErrorHandler` (status set); (2) mid-stream gateway/model error → in-band SSE `event: error` frame then end; (3) transport throw after headers → swallow, `ctx.res.end()`, log with request id; guard every write with `if (!ctx.res.headersSent)`.
  - Acceptance: gate off OR env unset → 404; enabled + CSRF + valid body → `text/event-stream` with **no `Content-Encoding`**, frames arrive incrementally.
  - QA (happy): `curl -N -b "csrfToken=<t>" -H "x-csrf-token: <t>" -H "Content-Type: application/json" -X POST http://localhost:3050/api/ai.chat -d '{"messages":[{"role":"user","content":"hi"}]}'` → incremental `data:` frames; `-D-` shows no `Content-Encoding`.
  - QA (failure): (a) no `x-csrf-token` → 403 JSON; (b) gate off → 404; (c) stop `:20127` → in-band error frame, server stays up (check `/_health`).
  - Colocated test: `server/routes/api/ai/ai.test.ts` — mirror `server/routes/mcp/index.test.ts` patterns (auth, gate 404, CSRF 403). Start with `// @vitest-isolate true` if it uses `vi.mock`.
  - Commit: `feat(ai): add streaming ai.chat route (read-only, session-gated)`

- [x] 4. `app/utils/aiChat.ts`: SSE fetch reader (no deps) - stream a chat completion into React state
  Recommended task executor category: unspecified-high
  - New file: a small module exporting a function that opens
    `fetch("/api/ai.chat", { method:"POST", credentials:"same-origin", headers:{ "Content-Type":"application/json", "x-csrf-token": getCSRFToken(), "x-editor-version": EDITOR_VERSION }, body: JSON.stringify({ messages }), signal })`
    then reads `res.body.getReader()`, decodes with `TextDecoder`, splits SSE frames on `\n\n`, and yields parsed `data:` payloads.
  - Headers: reuse `getCSRFToken()` (`app/utils/csrf.ts:10-12`) and `EDITOR_VERSION` (`~/utils/ApiClient` import or `env`) to reduce the second-transport invariant loss (Oracle C4).
  - Acceptance: a hook built on it appends streamed text incrementally and stops on `[DONE]`; `AbortController.abort()` cancels the fetch.
  - QA (happy): unit test the SSE parser with a mock `ReadableStream` of `data: {...}\n\n` frames → correct accumulation (colocated `app/utils/aiChat.test.ts`, project `app`, jsdom).
  - QA (failure): a 403 response throws a typed error the UI can render; a mid-stream `event: error` frame surfaces an error state.
  - Commit: `feat(ai): add SSE fetch reader for ai.chat`

- [x] 5. `app/scenes/Chat/*` or `app/components/ChatPanel.tsx`: right-sidebar slide-over chat UI - user can ask and see streamed answers
  Recommended task executor category: visual-engineering
  - Reuse `RightSidebarContext` (`useSetRightSidebar`) + `Aside`
    (`app/components/Sidebar/Aside.tsx`); mirror the content-setting pattern from
    `app/scenes/Document/hooks/useDocumentSidebar.tsx` (set content when open,
    clear on close).
  - Component: message list + composer using existing primitives (`Input`,
    `Button`, `Text`); render assistant text with the existing Markdown path;
    show a streaming cursor while loading; a `Stop` button wired to the
    `AbortController` from todo 4.
  - Mount point: render the panel from a small provider hook wired into
    `app/components/AuthenticatedLayout.tsx` (mirror how Comments/History set
    right-sidebar content), gated on `team.getPreference(TeamPreference.AIChat)`.
  - Acceptance: opening the panel and sending a message shows incremental text;
    `Stop` halts it; closing the panel clears content and aborts any stream.
  - QA (happy): manual — run `.\scripts\dev-start.ps1`, open panel, send "hello",
    observe streamed output; screenshot the panel.
  - QA (failure): with the gateway stopped, the panel shows an error notice, not
    a hung spinner; the rest of the app remains usable.
  - Commit: `feat(ai): add right-sidebar AI chat panel`

- [x] 6. `app/actions/definitions/navigation.tsx` + sidebar: open the chat panel action - discoverable entry point
  Recommended task executor category: unspecified-high
  - Add a `createAction` (not a link action) that calls the same right-sidebar
    open path as todo 5; register it in `rootNavigationActions`
    (`app/actions/definitions/navigation.tsx:271-285`), which auto-surfaces it in
    the command bar (`app/actions/root.ts`, `app/components/CommandBar/CommandBar.tsx:25`).
    Copy-from the `toggleSidebar` / `openKeyboardShortcuts` action shapes.
  - Optional: a `<SidebarLink>`-style entry guarded by
    `team.getPreference(TeamPreference.AIChat)` (mirror `DraftsLink`).
  - Acceptance: the action appears in the command bar only when the gate is on,
    and opening it reveals the panel.
  - QA (happy): command bar shows "AI chat"; invoking it opens the panel.
  - QA (failure): gate off → action not present.
  - Commit: `feat(ai): add open-AI-chat action and sidebar entry`

- [x] 7. `app/scenes/Settings/Features.tsx`: `AI chat` toggle row - admin can enable the feature
  Recommended task executor category: unspecified-high
  - Add `handleAIChatChange` (copy `handleMCPChange`, `Features.tsx:25-32`) and a
    `SettingRow` + `Switch` row (copy the MCP row `Features.tsx:59-112`) placed
    next to the MCP card in the already-"AI"-titled scene.
  - Label/description via `t(...)` (ships as untranslated EN — do NOT hand-edit
    `shared/i18n/locales/`).
  - Acceptance: toggling persists (`teams.update` with `preferences.aiChat`) and
    survives reload; the chat entry appears/disappears accordingly.
  - QA (happy): toggle on → `git diff` shows no locale edits; reload → still on.
  - QA (failure): toggling when the API rejects (schema missing edit #4) surfaces
    a toast error, not a silent failure.
  - Commit: `feat(ai): add AI chat workspace toggle in settings`

- [x] 8. Tests: server + client coverage for the route, gate, CSRF, and parser - regression gate
  Recommended task executor category: unspecified-high
  - `server/routes/api/ai/ai.test.ts`: gate-off 404, missing-CSRF 403, success
    streams (mock the gateway `fetch`), mid-stream error frame.
  - `app/utils/aiChat.test.ts`: SSE frame parsing happy + error.
  - `app/scenes/Settings` or an existing teams test: preference round-trip.
  - Add `// @vitest-isolate true` as the FIRST line of any server test that uses
    `vi.mock`/`vi.resetModules`.
  - Acceptance: all new tests pass under the repo's vitest projects.
  - QA (happy): `yarn test server/routes/api/ai/ai.test.ts` green.
  - QA (failure): `yarn test app/utils/aiChat.test.ts` green; temporarily break a
    frame and confirm the test fails (proves it can fail).
  - Commit: `test(ai): cover ai.chat route, gate, CSRF, and SSE parser`

- [x] 9. `docs/` + `.env`/`.env.example`: document slice 1 and the slice-2 stub - handoff clarity
  Recommended task executor category: writing
  - Add a short doc (e.g. `docs/AI-CHAT.md`) describing: the gate, the env vars,
    how to run the spike, the verified constraints (compress/timeout/CSRF), and
    the explicit PROD-open items (TLS/domain/proxy buffering/provider).
  - Add the three env vars to `.env.example`/`.env.sample` (name only; note
    `AI_CHAT_API_KEY` is secret).
  - Slice 2 stub section: list the deferred TanStack AI facts (deps
    `@tanstack/ai @tanstack/ai-client @tanstack/ai-react @tanstack/ai-openai`;
    `tsconfig.json:17 resolvePackageJsonExports:false` → `paths` fix precedent
    `tsconfig.json:37-40`; `chatParamsFromRequestBody(ctx.request.body)` because
    koa-body drains the request; pin exact versions; avoid `/mcp-apps`).
  - Acceptance: a new contributor can enable and run the spike from the doc alone.
  - QA (happy): follow the doc top-to-bottom on a clean checkout → panel works.
  - QA (failure): doc lists the fail-soft behavior when env is unset.
  - Commit: `docs(ai): document AI chat spike and TanStack AI slice 2`

---

## Final verification wave

- [x] F1. `yarn lint` passes on every touched file (run manually — Husky is not installed); confirm no new warnings introduced vs baseline
  Recommended task executor category: unspecified-high

- [x] F2. `yarn tsc` passes with the plan's new files (no type errors); this is the gate that catches the tsconfig/exports and zod-schema issues early
  Recommended task executor category: unspecified-high

- [x] F3. `yarn test` on all new/changed test files passes; then re-run one with a deliberately broken assertion to confirm the suite can fail
  Recommended task executor category: unspecified-high

- [x] F4. End-to-end QA on the live stack (`.\scripts\dev-start.ps1`): gate off → 404; enable → panel streams; `Stop` aborts; gateway down → in-band error; `/_health` stays 200 — capture a screenshot and a `curl -N` transcript as evidence
  Recommended task executor category: unspecified-high

- [x] F5. Guardrail audit: `git status`/`git diff` shows no writes to other agents' files, no new deps in `package.json`, no locale edits, no global timeout/compress changes; commit list is conventional-commit scoped
  Recommended task executor category: unspecified-high

- [x] F6. Branch/worktree audit: confirm work happened in an isolated worktree on `feat/ai-chat`; confirm the branch was cut from `development` (not `main`) via `git merge-base --is-ancestor origin/development HEAD`; confirm the PR targets `development`; confirm the shared `development` checkout is untouched
  Recommended task executor category: unspecified-high

---

## Slice 2 (deferred — do not implement in this plan)

Layer TanStack AI on the proven transport, pinned exact: add deps, apply the
`tsconfig` `paths` fix, use `chatParamsFromRequestBody(ctx.request.body)`, keep
the read-only tool allowlist (server tools only; ignore client `params.tools`;
never spread `forwardedProps`), and reuse the abort/error/compress/timeout
mechanics already built in slice 1.

## Open items (prod, out of scope)

Production provider/host, TLS/domain, secret management/rotation, and reverse
proxy SSE settings (`proxy_buffering off`, raised `proxy_read_timeout`).
