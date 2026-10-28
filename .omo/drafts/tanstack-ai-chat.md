# Draft: tanstack-ai-chat

status: awaiting-approval
intent: clear
review_required: false
slug: tanstack-ai-chat
created: planning session (Prometheus / ulw-plan)

## Request (verbatim intent)

Integrate TanStack AI into the Outline fork to add an in-app AI chat UI.
First deliverable is a READ-ONLY SPIKE: a streaming `/api/ai.chat` route + a
React `useChat` panel, READ-ONLY tools only, gated by a new
`TeamPreference.AIChat`. Must bridge TanStack's Web `Response` stream into Koa,
disable `koa-compress` for the route, fix the 10s request timeout, and reuse
MCP tool logic + `server/policies` for per-user authorization.
Do NOT touch existing work owned by other agents on this branch.

## Affected user & ideal state (north star)

- **Outline member (KB user)** — wants to ask natural-language questions about
  the workspace and get streamed, cited answers without leaving Outline.
  Today: must use an external Hermes CLI/Telegram bot. After: an in-app panel.
- **Workspace admin** — controls whether the feature exists at all.
  Today: no such control. After: an `AI chat` toggle in Settings > AI, and
  `/api/ai.chat` returns 404 when off (mirrors `TeamPreference.MCP`).
- **Security owner** — must be able to assert the chat cannot write to the KB.
  Today: guaranteed by absence of write tools. After: same guarantee via
  read-only tool allowlist.

Ideal-state properties (one row = one property, each with why):
1. Every answer streams token-by-token; no spinner-then-dump. Why: perceived latency.
2. Every factual claim is citable to a doc the user can open. Why: trust.
3. Chat can only READ — no create/update/delete path exists. Why: preserves the
   read-only posture the architecture enforces on purpose.
4. Off by default at the workspace level; nothing renders or is reachable when off.
5. Answers respect per-user membership/visibility exactly like the KB UI does.
6. Asking a question costs nothing if the feature is disabled or unconfigured.
7. Long answers are not killed by a 10s server timeout.

## Gap list (today -> ideal), each with reason

| # | Gap | Reason |
|---|-----|--------|
| G1 | No in-app chat UI/route | feature does not exist |
| G2 | No `TeamPreference.AIChat` | cannot gate the feature |
| G3 | No `/api/ai.chat` route | no server entry point |
| G4 | No streaming transport in `ApiClient.ts` | JSON-only client |
| G5 | No Web->Node stream bridge in an API route | Koa expects Node Readable |
| G6 | `koa-compress` sits above `/api` | would buffer/compress SSE |
| G7 | `REQUEST_TIMEOUT` = 10s | kills long LLM streams |
| G8 | No LLM client/SDK in repo | no provider integration |
| G9 | No read-only chat tool layer | must reuse MCP tool logic |
| G10 | No entitlement/plan surfacing for AI (AIAnswers inert) | optional gate |

## Intent routing

CLEAR (outcome specified: read-only spike, streaming route + useChat panel,
read-only tools, TeamPreference gate). review_required: false (no high-accuracy
wording; Trivial-CLEAR path).

## Verified facts (evidence ledger)

- Frontend route/scene/store/panel patterns: `app/routes/scenes.ts`,
  `app/routes/authenticated.tsx`, `app/components/Sidebar/App.tsx`,
  `app/stores/RootStore.ts`, `app/components/RightSidebarContext.tsx`,
  `app/stores/UiStore.ts:35`, `app/actions/definitions/navigation.tsx`.
- `ApiClient.ts` is JSON-only (Accept hardcoded, `.json()` on success, no SSE).
- Koa streaming: MCP route uses `ctx.respond=false` + raw `ctx.res`
  (`server/routes/mcp/index.ts:100-129`); zip export proves
  `ctx.body = <Node Readable>` survives `apiResponse` (`server/utils/koa.ts:58`,
  `server/routes/api/middlewares/apiResponse.ts:5-23`).
- `koa-compress` global at `server/services/web.ts:72`; no per-route
  `ctx.compress` precedent -> we introduce the first.
- `REQUEST_TIMEOUT` default 10s (`server/main.ts:152`, `server/env.ts:328`).
- API conv: same-origin (no vite proxy); CSRF enforced for POST+cookie+
  `ai.chat` (not in read-only map) -> client must send `x-csrf-token`.
  `server/middlewares/csrf.ts`, `app/utils/csrf.ts`, `shared/constants.ts:44-53`.
- TeamPreference wiring (verified): `shared/types.ts:506,524`,
  `shared/constants.ts:98` (`TeamPreferenceDefaults`), and CRITICALLY
  `server/routes/api/teams/schema.ts:46-83` is a `z.strictObject` -> new key
  MUST be added or the API rejects it. Generic loops need no change:
  `server/commands/teamUpdater.ts:74`, `server/presenters/team.ts:26`.
- Settings UI insertion point: `app/scenes/Settings/Features.tsx` (scene TITLE
  is already "AI", SparklesIcon; MCP toggle pattern at :25-32, :59-112).
- Policies: `authorize(user, action, model)` / `can(...)` from
  `server/policies` (`server/policies/cancan.ts:213`). MCP tool template:
  `server/mcp/tools/documents.ts` (canAccess gate + getActorFromContext +
  authorize). User from `extra.authInfo.extra.user`
  (`server/mcp/util.ts:23`). Actions: Document `read`; Collection `read` /
  `readDocument`.
- MCP read tools (7): list_collections, list_collection_documents,
  list_documents, list_comments, list_templates, list_users, fetch.
  Watch-outs: list_collections / workspace list_templates / fetch attachment
  are NOT authorize-gated (scope/team-id only).
- `fetch` document shaping: `presentDocument` -> `DocumentHelper.toMarkdown`
  (`server/mcp/tools/fetch.ts:238-307`, `server/presenters/document.ts:41-56`).
- TanStack AI docs (verified via Context7/registry):
  - core `chat()`, `chatParamsFromRequest(req)`, `toServerSentEventsResponse`
    (returns Web Response, body = Web ReadableStream).
  - `@tanstack/ai-openai/compatible` -> `openaiCompatible({baseURL,apiKey,models})`
    or `openaiCompatibleText(model,{baseURL,apiKey})` for the local gateway
    `http://localhost:20127/v1`.
  - React: `useChat({ connection: fetchServerSentEvents("/api/ai.chat") })`
    returns `{ messages, sendMessage, isLoading, stop, error }`; render
    `message.parts` (`part.type === "text"` -> `part.content`).
  - Tools: `toolDefinition({...}).server(async (input, ctx) => ...)`;
    server tools receive a request-scoped `context` -> thread user/policies.
  - Peer dep zod ^3||^4 (repo has 4.5.4). engines node >=18, BUT GitHub README
    says Node v24+ needed to avoid isolated-vm issues (devtools only).
    Repo is Node v22.23.3 -> MUST smoke-test.
  - Packages: `@tanstack/ai @tanstack/ai-client @tanstack/ai-react
    @tanstack/ai-openai`.
- Live stack verified: Outline :3050 `_health` 200, `/mcp` 401 challenge; the
  OpenAI-compatible gateway at :20127 returns `/v1/models` 200 (25 models,
  tool-calling, streaming-capable). Postgres 5432, Redis 6379 up.
- TanStack already in repo: `@tanstack/react-table`, `@tanstack/react-virtual`.

## Owner decisions (asked -> ANSWERED)

- Q1 Spike scope: **Minimal stream-prove** (no tools in the first slice; prove
  frontend -> Koa stream -> TanStack AI -> :20127 end to end).
- Q2 Surface: **Right-sidebar slide-over** (reuse RightSidebarContext /
  UiStore / Aside; add `"chat"` to RightSidebarPanel).
- Q3 Provider: **Proxy local :20127 gateway** via `openaiCompatible`; PROD
  provider/host remains an explicit OPEN item flagged in the plan.

## Decisions defaulted (reversible internals)

- D1: Reuse MCP READ tools by extracting handler bodies into a shared module,
  not by calling HTTP /mcp. (avoids new auth surface; reuses policies.)
- D2: `ai.chat` is CSRF-protected (matches all other POST routes). Client sends
  `x-csrf-token`; `fetchServerSentEvents` headers option carries it.
- D3: Bridge via `Readable.fromWeb(res.body)` as `ctx.body` (Koa pumps it),
  with `ctx.compress = false`. Fallback: MCP-style `ctx.respond=false`.
- D4: New server env vars `AI_CHAT_BASE_URL` / `AI_CHAT_API_KEY` / `AI_CHAT_MODEL`
  (zod in `server/env.ts`) so prod is provider-agnostic; dev points at :20127.
- D5: Raise `REQUEST_TIMEOUT` per-route, not globally (avoid regressions).
- D6: Read-only tools only; write tools structurally absent (mirror §8b).
- D7: No BYOK in the browser (PII/scope). Key stays server-side.

## Must-NOT-have (guardrails)

- No write tools (create/update/delete/move/restore/attach) exposed to chat.
- No browser-supplied API keys.
- No changes to Hermes/Matius config or to other agents' files.
- No new test directories (colocated `*.test.ts` only).
- No hand-editing `shared/i18n/locales/`.
- No global timeout/compress changes that affect other routes.
- No touching `graphify-out/`, `.omo/` is planning-only.

## Metis critique — verified findings (folded into plan)

Verified INDEPENDENTLY (not just claimed):
- **TS-EXPORTS BLOCKER (confirmed):** `tsconfig.json:17` `resolvePackageJsonExports:
  false`. `@tanstack/ai-openai/compatible` is export-only -> `yarn tsc` cannot
  resolve its types. Precedent workaround already in `tsconfig.json:37-40`
  (`vite`, `@vitejs/plugin-react`). Fix: add a `paths` entry for the subpath, or
  import `openaiCompatible` from the package root if re-exported.
- **COMPRESS (confirmed, corrects earlier note):** koa-compress default
  `filter = compressible` (`node_modules/koa-compress/lib/index.js:60`), NOT
  `/text/i`; `compressible('text/event-stream') === true`, so SSE WOULD be
  compressed/buffered. Fix = `ctx.compress = false` (line 102). `threshold`
  default 1024 (line 121). Also line 99 `!body` -> `ctx.respond=false` fallback
  is auto-skipped.
- **TEAM PREF SILENT TRAP (confirmed):** `TeamPreferences` fields are all
  optional (`?:`); omitting a key from `TeamPreferenceDefaults` is NOT a type
  error and silently falls back to `false` via `getPreference`
  (`server/models/Team.ts:367`). Must add the default explicitly.
- **DEPS (confirmed):** repo has `@modelcontextprotocol/sdk` but NO `openai`
  and NO `@mcp-ui/client`. `@tanstack/ai-openai` pulls `openai@^7`;
  `@mcp-ui/client@^7` is an **optional peer, only for the `/mcp-apps` subpath**
  -> avoidable by using core `useChat` (do not import `/mcp-apps`).
- **NODE (confirmed non-issue):** repo has no `isolated-vm`; engines explicitly
  allows 22; installed 22.23.3. The "Node 24+" README line is devtools-only ->
  do NOT force a Node upgrade.
- **CTX/UIStore (confirmed distinct):** `RightSidebarContext` = ephemeral React
  node (Layout.tsx:41,73); `UiStore.rightSidebar` = persisted enum
  `"comments"|"history"` (UiStore.ts:35). Spike uses the ephemeral context node.

Metis blind spots / notes adopted:
- "Read-only" definitional carve-out: chat has NO persistence/tools; the
  `TeamPreference` toggle is the only write and reuses existing `teams.update`.
- Env vars must be optional + fail-soft (no crash when `:20127` absent);
  `AI_CHAT_API_KEY` must NOT be `@Public`; use `@CannotUseWithout` for
  base-url-gated vars (precedent env.ts`.
- Lock the action name `ai.chat` (CSRF stays ON); read-named actions silently
  skip CSRF (AuthenticationHelper method map).
- SSE headers: Content-Type text/event-stream, Cache-Control no-cache,
  Connection keep-alive, X-Accel-Buffering no.
- In-band error frame once headers sent; guard `ctx.res.headersSent`.
- Abort upstream on client disconnect (`ctx.req/res.on("close")`) or list as an
  explicit spike limitation.
- Windows: Husky not installed, `yarn build:i18n` fails -> run `yarn lint`,
  `yarn tsc` manually; git via `vcs.mjs` shim.

## Momus + Oracle review — verified findings (v2, MUST fold into plan)

Momus verdict: the draft is a strong SPEC, not yet a plan (no todos/AC/QA/DAG).
Artifact must be translated into `.omo/plans/` with atomic todos. Required:
- Todos: atomic, exact target file:line + copy-from file:line.
- Objective acceptance criteria (HTTP status, headers, byte-stream assertions).
- Agent QA with exact commands: happy + failure (CSRF 403, gate 404, gateway
  down in-band error).
- Explicit acyclic DAG: deps+tsconfig -> env -> TeamPreference -> route ->
  client -> UI -> settings -> verify.
- Verification gate: `yarn lint` -> `yarn tsc` -> `yarn test` (+ install smoke).

Oracle BLOCKERS (verified independently):
- **B1 TIMEOUT (confirmed):** `server.setTimeout` (`main.ts:152`) is a
  CONNECTION-level inactivity timeout, NOT per-route. D5 "raise per-route" is
  impossible. Fix: inside the handler call `ctx.req.setTimeout(0)` and/or emit
  SSE heartbeat comments (~15s); do NOT touch global REQUEST_TIMEOUT.
- **B2 AG-UI BODY (confirmed + fix found):** koa-body drains the request into
  `ctx.request.body` (`index.ts:63-77`), so `chatParamsFromRequest(req)` cannot
  work. USE `chatParamsFromRequestBody(ctx.request.body)` (verified exported
  from `@tanstack/ai`). Wrap in try/catch; map malformed -> pre-stream 400.
- **B3 ERROR MATRIX (confirmed, MCP precedent):** define 3 rows: (1) pre-stream
  (auth/CSRF/gate/params) -> JSON via apiErrorHandler; (2) mid-stream model
  error -> in-band AG-UI `RUN_ERROR` (let TanStack emit); (3) mid-stream
  transport throw -> swallow, `ctx.res.end()`, log; guard `ctx.res.headersSent`
  (mirror `server/routes/mcp/index.ts:114-128`). Avoid ERR_HTTP_HEADERS_SENT.

Oracle SHOULD-FIX (verified plausible):
- **S1 AbortController:** wire `ctx.req` close -> AbortController, pass to BOTH
  `chat()` and `toServerSentEventsResponse(stream,{abortController})`; guard
  with `ctx.res.writableEnded`. Else `stop()` leaks upstream gateway calls.
- **S2 Flush:** keep `Readable.fromWeb`; add curl `-N` incremental-flush AC;
  name `ctx.respond=false` raw pump as the PRIMARY fallback if it buffers.
- **S3 compress:** set `ctx.compress=false` AND assert no `Content-Encoding`
  (protection currently relies on headers-sent; make it explicit + regression
  test).
- **S4 Input caps:** cap messages length, ignore client `role:"system"`, cap
  content size; NEVER spread `forwardedProps`; for slice 2 ignore client
  `params.tools` (server tools only).
- **S5 CSRF client form:** use the FUNCTION form of headers so the token is
  read fresh: `fetchServerSentEvents(url, () => ({ headers: { "x-csrf-token":
  getCSRFToken() }, credentials: "same-origin" }))`; token cookie exists only
  after a prior safe-method SPA GET.
- **S6 auth scopes:** restrict to session (browser) for slice 1; do NOT grant
  API-key access (durable LLM access). Add route `rateLimiter` (LLM cost).

Oracle CONSIDER:
- C1 gate: TeamPreference now; leave entitlement (PlanFeature.AIAnswers) TODO;
  env-unset returns same 404 (fail-closed, indistinguishable).
- C4 second transport drops invariants (x-editor-version, version, retry,
  batch, typed errors) -> add min headers or accept explicitly.
- C5 prod proxy buffering (`proxy_buffering off`, `proxy_read_timeout`) -> OPEN.
- Strategy: Oracle recommends a LIGHTER prove first (hand-rolled Koa SSE to
  `:20127` /chat/completions stream:true, ~40 lines, zero new deps), THEN layer
  TanStack AI pinned exact. This is a genuine fork in approach -> decision.

## DECISION REQUIRED (approach fork from Oracle) -> ANSWERED

**Chosen: P2 — lighter transport prove first.** Slice 1 = hand-rolled Koa SSE
route proxying `:20127` `/chat/completions` with `stream:true` (ZERO new deps)
+ a small fetch/SSE-reader React hook in the right-sidebar slide-over, gated by
`TeamPreference.AIChat`. This proves flush/timeout/compress/abort/CSRF/error
taxonomy with no dependency surface. Slice 2 (follow-on, planned as a stub
section) = layer TanStack AI pinned-exact as an internal AG-UI adapter once the
transport is proven.

Consequences for the plan:
- Slice 1 needs NO `@tanstack/*` deps, NO tsconfig `paths` fix, NO AG-UI body
  contract. The `/chat/completions` body is a plain OpenAI payload -> validated
  with the repo's normal `validate(zodSchema)` + read via `ctx.request.body`.
- Store the OpenAI-compatible request/response knowledge now (deferred): the
  `openai@^7` / `@tanstack/ai*` / tsconfig findings remain recorded for slice 2.
- Keep B1-B3, S1-S6 fixes: they all apply to the hand-rolled route too
  (timeout via ctx.req.setTimeout, error matrix, abort-on-close, compress off,
  input caps, CSRF, session-only auth).

## Next workflow action

Present the approval brief; on explicit okay, scaffold `.omo/plans/tanstack-ai-chat.md`
and append the Todo batches, then stop (execution is separate, e.g. `$ulw-execute`).
