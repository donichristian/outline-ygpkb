# AI chat

A workspace-gated streaming AI chat for the Outline fork: a hand-rolled Koa
Server-Sent Events (SSE) route that proxies an OpenAI-compatible gateway to a
React panel in the right sidebar, and — when a `sessionId` is supplied — persists
the conversation server-side behind four RPC endpoints. The transport adds **no
new npm dependencies**. TanStack AI is layered on this proven transport in slice 2
(see [Slice 2 (deferred)](#slice-2-deferred)).

> This is the **operational/usage** document: env vars, the settings toggle, and
> curl recipes. The architecture — request path, the KB-scope grounding gate, the
> streaming transport, and failure modes — lives in
> [**AI Chat — System Design**](./AI-CHAT-DESIGN.md). Read that first if you want
> to understand *why* the code is shaped this way.
>
> This document describes what the code actually does. It is grounded in
> `server/routes/api/ai/ai.ts`, `server/routes/api/ai/aiSessions.ts`,
> `server/routes/api/ai/scope.ts`, `server/routes/api/ai/schema.ts`,
> `app/utils/aiChat.ts`, `app/components/AIChat/`, `app/stores/AIChat*Store.ts`,
> `server/env.ts`, `server/queues/tasks/CleanupDeletedUsersTask.ts`, and
> `app/scenes/Settings/Features.tsx`.

## What it is

- **Server**: `POST /api/ai.chat` (`server/routes/api/ai/ai.ts`) first checks
  whether the requesting user's own documents can *ground* the prompt (the
  **scope gate**, `server/routes/api/ai/scope.ts`, see below), then proxies an
  OpenAI-compatible gateway at `${AI_CHAT_BASE_URL}/chat/completions` with
  `stream: true`, flushing the upstream response to the browser as SSE
  (`Content-Type: text/event-stream`).
- **Client**: `app/utils/aiChat.ts` opens the streaming request with `fetch`
  (bypassing `ApiClient`) and yields incremental text deltas; a right-sidebar
  panel (`app/components/AIChat/`) renders them, opened from a floating trigger
  or the command bar.
- **Persisted, server-authoritative sessions**: when a request carries a
  `sessionId`, the conversation is stored in `ai_chat_sessions` and
  `ai_chat_messages` and the provider's prompt window is rebuilt from those rows.
  The panel creates a session on the first send of a new chat and sends the new
  turn alongside it, so a conversation always persists and survives closing the
  panel. At the API level a request with neither `sessionId` nor `messages`
  stores nothing. Four RPC endpoints expose the model — see
  [The session API](#the-session-api).

**Read-only with respect to your documents.** The route never writes a
document, never modifies a collection, and never injects document content into
the prompt. Its only writes are to the two AI chat tables above.

## The gate

There are **two** gates on the request path, in order.

### 1. Feature gate

The feature is gated by the per-workspace preference `TeamPreference.AIChat`
(“AI chat”), toggled in **Settings > AI** (`app/scenes/Settings/Features.tsx`,
the scene is titled “AI”). Toggling persists via `teams.update` and defaults to
`false` (`shared/constants.ts`).

The route returns **404** when either condition fails, so an unavailable
endpoint is indistinguishable from an unknown route:

```ts
// server/routes/api/ai/ai.ts
if (!user.team.getPreference(TeamPreference.AIChat) || !env.AI_CHAT_BASE_URL) {
  throw NotFoundError();
}
```

The panel and its entry points are likewise gated on the same preference: the
floating trigger (`app/components/AIChat/AIChatTrigger.tsx`) renders only when
the preference is on, and the command-bar action `openAIChat`
(`app/actions/definitions/navigation.tsx`) carries the same `visible` predicate.

### 2. Scope gate (grounding)

Past the feature gate, the route calls
`findUngroundedReason(user, resolvedMessages)`
(`server/routes/api/ai/scope.ts`) **before** contacting the provider. The prompt
is reduced to distinctive terms (newest user turn first, OR-joined, capped at 8)
and searched against the requesting user's **own accessible documents**. If
nothing retrieves, the prompt is **refused** — no upstream call, no latency, no
tokens.

This is not prompt-level guidance: the boundary is enforced by retrieval, so an
off-topic question cannot be answered from the model's parametric memory. It
**fails closed** (a search failure refuses rather than passes through), and
because authorization is the search provider's own, a prompt cannot be used to
probe for documents the user cannot read. The refusal arrives as a normal SSE
stream containing one `event: error` frame, so the panel renders it as ordinary
text.

> **The probe can be turned off with `AI_CHAT_GROUNDING=false`.** The local probe
> is a lexical search over the caller's *Outline* documents. When the provider is
> itself a retrieval agent over a different corpus (the Hermes KB agent, say),
> the probe refuses prompts that corpus cannot lexically match, and the provider's
> own scope rules are the boundary instead. The default remains `true`; only flip
> it when the provider enforces the boundary itself.

> **The gate is deliberately blunt.** A lexical hit is a claim, not a
> measurement — no false-reject rate has been measured against the live corpus,
> and a full-text OR over-matches shared words while under-matching paraphrase.
> It is biased toward refusing because a refusal is visible and a hallucination
> is not. See
> [**§4 of the design doc**](./AI-CHAT-DESIGN.md#4-the-kb-boundary-rebuilt-three-times)
> for the three-stage history of this boundary and its stated ceiling.
>
> **The term extractor assumes space-delimited scripts.** A prompt written in a
> whitespace-free script — Han, Thai, Khmer, Lao, Myanmar, Japanese kana,
> Hangul — arrives as one long unmatchable "word", so it degrades to near-total
> refusal no matter what the workspace holds. Those refusals are now
> distinguishable in the logs as `unsupported script`; a prompt that reduces to
> a single token instead reports `no distinctive terms`. The refusal is still
> fail-closed — the reason string changed, the decision did not.

## Environment variables

All three are **optional**: the process boots without any of them and the
feature is a safe no-op. `AI_CHAT_MODEL` is, however, required to *enable* chat
once a provider is configured.

| Variable | Required | Purpose |
|----------|----------|---------|
| `AI_CHAT_BASE_URL` | no | Base URL of an OpenAI-compatible provider, e.g. a URL ending in `/v1`. The route appends `/chat/completions`. When unset, the feature is disabled. |
| `AI_CHAT_API_KEY` | no | **SECRET.** Sent as `Authorization: Bearer <key>` to the provider. **Server-side only — never sent to the browser.** |
| `AI_CHAT_MODEL` | **when `AI_CHAT_BASE_URL` is set** | Model id forwarded as `model` in the upstream request body. With a base URL configured but no model, the route returns **404** and no upstream request is made. |
| `AI_CHAT_GROUNDING` | no | Whether the route runs the local grounding probe (§2). Defaults to `true`. Set to `false` when the provider is itself a retrieval agent that enforces the knowledge-base boundary — the local lexical probe would otherwise refuse prompts the provider can answer. |

Defined in `server/env.ts` (the `AI_CHAT_*` block). Notes:

- `AI_CHAT_API_KEY` and `AI_CHAT_MODEL` are annotated `@CannotUseWithout("AI_CHAT_BASE_URL")`.
  The `CannotUseWithout` validator (`server/utils/validators.ts`) returns false
  when the named property is `undefined`, so setting either key **without**
  `AI_CHAT_BASE_URL` is **rejected at boot**: `Environment` validation collects
  the error and calls `process.exit(1)` with a message like
  `AI_CHAT_API_KEY cannot be used without AI_CHAT_BASE_URL.` It is **not**
  silently ignored.
- The reverse — a base URL **without** a model — is deliberately **not** a boot
  failure. A missing model disables one route, not the configuration of the
  whole cluster, and a hard failure here would take down web, worker, cron,
  collaboration and websockets alike during a two-step env rollout. Instead the
  server boots, logs `AI_CHAT_BASE_URL is set without AI_CHAT_MODEL; the AI chat
  route will return 404 until AI_CHAT_MODEL is set.` via `console.warn`, and the
  route gates on the model itself (`server/routes/api/ai/ai.ts`), returning 404
  exactly as if no provider were configured.
- `AI_CHAT_API_KEY` is deliberately **not** `@Public`, so it is never included
  in the serialized environment exposed to the client.
- Setting **none** of the three is a safe no-op (see
  [Fail-soft behavior](#fail-soft-behavior-when-env-is-unset)).

## How to run the spike

1. Set the provider env vars (e.g. in `.env.development` locally, using the
   names from `.env.sample`). Locally this is the Hermes gateway, which is
   OpenAI-compatible at a profile-scoped path:

   ```dotenv
   AI_CHAT_BASE_URL=http://127.0.0.1:8642/p/matius/v1
   AI_CHAT_API_KEY=<Hermes API_SERVER_KEY for the matius profile>
   AI_CHAT_MODEL=matius
   ```

   The app runs at **http://localhost:3050**.

   > **Routing fact worth knowing:** within the profile-scoped URL, the `model`
   > field selects the behaviour, not the path. `model=matius` runs the KB agent
   > (persona, KB tools, MCP guidance); `model=ski-bot` is a bare model
   > passthrough with no persona and no KB. Same URL, same key, different
   > behaviour. See [design doc §7](./AI-CHAT-DESIGN.md#7-the-routing-fact-that-cost-the-most-time).

2. Start the stack:

   ```powershell
   .\scripts\dev-start.ps1
   ```

3. Open **Settings > AI** and enable **“AI chat”** (persists via `teams.update`).

4. Open the chat panel — via the **floating sparkle button** (bottom-right) or
   the **command bar** action “AI chat” — and send a message; the answer streams
   in incrementally. The composer is a **single-line input**; **Enter** sends.

### Direct checks

**Gate-off returns 404.** With the toggle off (or `AI_CHAT_BASE_URL` / `AI_CHAT_MODEL`
unset) the endpoint is not reachable. `auth()` runs *before* the handler body, so
the request still needs credentials — without them you get **401**, not 404:

```sh
curl -i -X POST http://localhost:3050/api/ai.chat \
  -b "accessToken=<session token>; csrfToken=<token>" \
  -H "x-csrf-token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
# => HTTP/1.1 404 Not Found
```

**Streaming check.** `POST /api/ai.chat` is CSRF-protected (it resolves to
`Scope.Write`; `chat` is not in `AuthenticationHelper.methodToScope`), so the
request must carry the `x-csrf-token` header whose value matches the CSRF
cookie — `__Host-csrfToken` on secure origins, `csrfToken` over plain HTTP.
Read the cookie from a browser session and pass it both ways:

```sh
curl -N -i -X POST http://localhost:3050/api/ai.chat \
  -b "accessToken=<session token>; csrfToken=<token>" \
  -H "x-csrf-token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"<a question answerable from the workspace KB>"}]}'
# => text/event-stream, incremental "data:" frames, no Content-Encoding
```

Pass `"sessionId":"<uuid>"` instead of `messages` to run a session-backed turn;
the response is the same shape but ends with an `event: complete` (or
`event: truncated`) terminal frame, and the turn is written to storage.

A missing or mismatched token yields **403** (JSON), thrown by
`server/middlewares/csrf.ts`.

> **The prompt must be grounded.** Sending `"hi"` is refused by the scope gate
> (no matching document) and returns a `text/event-stream` containing a single
> `event: error` frame — not an answer. To exercise the streaming path on the
> command line, send a question whose terms appear in a document the calling
> user can read.

**Refusal check.** A prompt the knowledge base cannot ground is refused **before**
the provider is contacted:

```sh
curl -N -i -X POST http://localhost:3050/api/ai.chat \
  -b "accessToken=<session token>; csrfToken=<token>" \
  -H "x-csrf-token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the capital of France?"}]}'
# => HTTP/1.1 200 text/event-stream
# => event: error
# => data: {"error":"This assistant only answers from this workspace’s knowledge base","kind":"refusal"}
```

**Request body.** `messages` is an array (1–50 items) of
`{ role: "user" | "assistant", content: string }`. Per-message `content` is
capped at 8000 characters (`AiChatMaxMessageLength`). The `system` role is
**rejected** so a caller cannot override server-side instructions.

`messages` is now **optional when `sessionId` is present**, and required
otherwise. A `.refine()` in `server/routes/api/ai/schema.ts` enforces exactly
that: a body with neither `messages` nor `sessionId` is rejected with
`messages is required when sessionId is not provided`. Send either

```sh
# stateless turn — the client array is the whole conversation, nothing is stored
-d '{"messages":[{"role":"user","content":"…"}]}'

# session-backed turn — the window is rebuilt from storage
-d '{"sessionId":"<uuid>"}'
```

Both may be sent together; `messages` then supplies only the **new** turn, while
the rest of the window comes from the stored rows.

## The session API

The API is **RPC-style**, not REST: every call is `POST /api/<resource>.<action>`
with a JSON body, including the reads. `README.md` describes "RESTful endpoints
under `/api/`"; that is wrong for this codebase, and `server/routes/api/` is the
authority.

All four endpoints live in `server/routes/api/ai/aiSessions.ts`. Each one calls
`assertAiChatEnabled` **first**, so with the toggle off or the provider
unconfigured they all return **404**, exactly like `ai.chat`.

`auth()` runs before the handler body, so every recipe below needs credentials:
pass the `accessToken` cookie (session token) plus the CSRF pair. A recipe
missing `accessToken` returns **401** and never reaches the handler.

**Auth.** `auth()` with no type restriction, so a session cookie, a Bearer
session token **or an API key** may call them. Unlike `ai.chat`, which is
`auth({ type: [APP] })`. A request not owned by the caller is **404**, not 403 —
the gate runs before ownership so the endpoint cannot be used to probe which
session ids exist.

**CSRF.** All four resolve to `Scope.Write` or `Scope.Create`, so a
cookie-authenticated request needs the matching `x-csrf-token` header and CSRF
cookie, same as `ai.chat`. Bearer-token and API-key requests skip CSRF.

### `ai.sessions.create`

Creates an empty session owned by the caller. Rate limit **25/min**.

```sh
curl -i -X POST http://localhost:3050/api/ai.sessions.create \
  -b "accessToken=<session token>; csrfToken=<token>" \
  -H "x-csrf-token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Quarterly planning"}'
```

`title` is optional and capped at 200 characters
(`AiChatMaxSessionTitleLength`); omit it for `null`. Response:

```json
{
  "data": {
    "id": "3f6d…",
    "title": "Quarterly planning",
    "createdAt": "2026-10-15T09:12:00.000Z",
    "updatedAt": "2026-10-15T09:12:00.000Z"
  }
}
```

`teamId` and `userId` are deliberately absent from the serialized session: they
are ownership internals, and exposing them would invite clients to reason about
ownership instead of being authorized.

### `ai.sessions.list`

Every session belonging to the caller, newest activity first. Rate limit
**100/min**.

```sh
curl -X POST http://localhost:3050/api/ai.sessions.list \
  -b "accessToken=<session token>; csrfToken=<token>" \
  -H "x-csrf-token: <token>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Response — note the extra `sessions` wrapper:

```json
{
  "data": {
    "sessions": [
      { "id": "3f6d…", "title": "Quarterly planning",
        "createdAt": "2026-10-15T09:12:00.000Z",
        "updatedAt": "2026-10-15T09:41:00.000Z" }
    ]
  }
}
```

The `where` clause on `(teamId, userId)` *is* the authorization: it matches the
`[teamId, userId, updatedAt]` index prefix, so other users' rows are excluded in
one read rather than filtered per row.

### `ai.sessions.delete`

Permanently deletes a session and, by way of the `ai_chat_messages.sessionId`
foreign key, every message in it. Sessions are **not** soft deleted. Rate limit
**25/min**.

```sh
curl -X POST http://localhost:3050/api/ai.sessions.delete \
  -b "accessToken=<session token>; csrfToken=<token>" \
  -H "x-csrf-token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"id":"3f6d…"}'
# => {"success": true}
```

`id` is a required UUID. It must be owned by the caller; anything else is 404.

### `ai.messages.list`

One page of a session's turns, newest `seq` first. Rate limit **100/min**.

```sh
curl -X POST http://localhost:3050/api/ai.messages.list \
  -b "accessToken=<session token>; csrfToken=<token>" \
  -H "x-csrf-token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"3f6d…"}'
```

`sessionId` is required (UUID). `beforeSeq` is optional: an **exclusive** upper
bound cursor — messages are returned from there downwards.

```json
{
  "data": {
    "messages": [
      {
        "id": "9b21…",
        "seq": 4,
        "role": "assistant",
        "content": "…",
        "status": "completed",
        "runId": "c1d0…",
        "createdAt": "2026-10-15T09:41:00.000Z"
      }
    ],
    "truncated": false
  }
}
```

- `status` is one of **`completed`**, **`aborted`**, **`error`**, **`truncated`**
  — see [Turn status](#turn-status).
- `truncated: true` means older messages exist that this page does not include.
- `cursor` is present **only** when `truncated` is true, and equals the oldest
  `seq` on this page. Pass it as `beforeSeq` to fetch the next older page. Paging
  by cursor rather than offset keeps the window stable while a turn is appended
  concurrently, which an offset would shift underneath.

The page size is `AiChatMaxMessages` (50), so one page is one upstream prompt
window: paging through history never needs to look at more than the model is
ever sent. The handler reads one row beyond the page so "are there older
messages?" is answered by the page already fetched rather than a second query.

Permission for a message is resolved **through its session** — messages carry no
owner column and have no policy of their own.

## Turn status

Each stored assistant turn carries a `status`:

| Status | Meaning |
|---|---|
| `completed` | the provider sent a `finish_reason`; the answer is whole |
| `truncated` | the stream ended with no `finish_reason`; the answer may be incomplete |
| `aborted` | the user stopped the turn, or the socket went away |
| `error` | the turn failed mid-stream |

`aborted` and `error` are terminal states rather than answers: they describe a
turn that stopped without producing a whole reply.

**A grounding refusal is stored as `completed`,** carrying the exact string that
was sent, locale-frozen at send time. It is an answer the boundary gave, not a
failure, and reopening the session replays the text the sender received rather
than a later translation of a key.

### How the client learns the outcome

For a **session-backed** turn the server authors its own last frame:

```
event: complete
data: {"runId":"<uuid>","finishReason":"stop"}
```

or `event: truncated` with `finishReason: null`. The payload is `{ runId,
finishReason }`, derived from the upstream `finish_reason` — **never** from
`data: [DONE]`, which the OpenAI SDK consumes and never forwards. A session-backed
stream that ends without an `event: complete` frame raises
`AiChatError kind="truncated"`, however much text it produced. A **stateless**
turn gets no terminal frame and completes whenever the stream ends.

### Retention

AI chat data belonging to a **deleted** user is permanently destroyed after a
**30-day** window by `CleanupDeletedUsersTask`
(`server/queues/tasks/CleanupDeletedUsersTask.ts`, `RetentionDays = 30`, hourly
with a 15-minute partition window). The reason a dedicated task exists at all:
`User.destroy()` is a *soft* delete, so the `ai_chat_sessions.userId` foreign key
never cascades.

## Verified constraints

These are the properties the feature proves; they are load-bearing, not
incidental.

- **Same-origin, no Vite proxy.** The SPA is served by Koa and `/api` is mounted
  there; Vite serves only `/static/`. The client calls `/api/ai.chat` directly.
- **Grounding runs before the provider.** `findUngroundedReason` performs one
  full-text search scoped to the user's accessible documents and refuses the
  prompt when nothing matches. This was the route's *first* database read; a
  refusal costs no upstream call or latency.
- **CSRF applies** to `POST /api/ai.chat`. Because `chat` is not in
  `AuthenticationHelper.methodToScope`, it resolves to `Scope.Write`, so the
  request needs header `x-csrf-token` matching the `__Host-csrfToken` (secure) or
  `csrfToken` (http) cookie.
- **`fetch`/SSE bypasses `ApiClient`.** The CSRF and editor-version headers are
  attached manually in `app/utils/aiChat.ts`.
- **`koa-compress` is bypassed** via `ctx.compress = false`. SSE must not be
  compressed — buffering defeats incremental delivery. Default `compressible`
  filtering would otherwise match `text/event-stream`.
- **Socket timeout.** The server-wide timeout is connection-level
  (`server.setTimeout(env.REQUEST_TIMEOUT)`, ~10s), which would cut a slow
  first token. The route calls `ctx.req.setTimeout(0)` to disable it per request.
- **Node stream bridge.** `Readable.fromWeb(res.body)` is assigned to `ctx.body`
  because the `apiResponse` middleware skips `Readable` (and `Buffer`), so the
  stream is piped through untouched.
- **Abort on disconnect.** An `AbortController` aborts the upstream request when
  the client disconnects (`ctx.res.on("close", …)`, not `ctx.req` — see the
  design doc), so the provider connection is not left open. A mid-stream upstream
  error is interposed as an in-band `event: error` SSE frame rather than a broken
  pipe.
- **Ownership is resolved before the stream exists.** With a `sessionId`, a
  non-owned session is a JSON **404**, never a 200 carrying SSE, and the rows are
  never loaded.
- **The window comes from storage, not the client.** `resolveUpstreamMessages`
  rebuilds the provider prompt from committed rows, re-asserting the role
  allow-list per row, so a replayed `messages` array cannot rewrite a stored
  conversation.
- **The response ends only after the turn is durable.** The terminal frame is
  written before the stream ends and the assistant row is committed before
  `end()`, so a client that reloads history the moment it sees the frame cannot
  race the insert.

## Panel behaviour

The panel (`app/components/AIChat/AIChatPanel.tsx`) is mounted into the
**ephemeral** `RightSidebarContext` by `AIChatProvider`
(`app/components/AIChat/AIChatContext.tsx`) — its open state is React state, not
a field on `UiStore`, because the persisted `ui.rightSidebar` enum drives the
Document comments/history panels. It writes the context's **override** slot
rather than its scene slot, so a scene clearing its own sidebar content on route
change (following a source citation) does not evict the panel: it stays open
until the user closes it. A few UI facts worth knowing:

- **Source citations stay in the panel.** An assistant answer's bare URLs render
  as links; a same-origin document URL navigates client-side, so the panel stays
  mounted and open beside the document.
- **Reasoning is a collapsed disclosure.** A `choices[0].delta.reasoning_content`
  chunk is shown behind a collapsed `<details>` whose summary reads "Loading…",
  never as the reply; it is live-only and never persisted. Mid-turn narration
  still arrives as `content` until Hermes is set
  `display.platforms.api_server.interim_assistant_messages: false` — see
  [design §3.2](./AI-CHAT-DESIGN.md#32-why-the-client-needed-no-rewrite).
- **Single-line composer.** The input is `type="text"`, not a textarea.
- **Enter sends.** `Input` only fires `onRequestSubmit` on **Cmd+Enter**; the
  panel handles plain `Enter` locally and calls `preventDefault()` so the browser
  does not submit the form a second time.
- **Floating trigger.** `AIChatTrigger` renders a fixed sparkle button
  (bottom-right, `z-index: depths.sidebar - 1` = 899, just below the sliding
  `Aside` at 900) and hides itself while the panel is open.
- **Session history.** `AIChatHistory`
  (`app/components/AIChat/AIChatHistory.tsx`) lists the caller's sessions from
  `AIChatSessionsStore` and deletes one behind a confirmation prompt. Opening a
  session loads its turns through `AIChatMessagesStore.list({ sessionId })`;
  closing and reopening replays the stored transcript rather than a
  client-only one, because the transcript the panel renders is the store's rows.
- **Fullscreen.** A grow/shrink button in the header passes `fullscreen` to
  `SidebarLayout`, which then covers the viewport instead of docking to the
  sidebar edge (a fixed overlay above the sidebars, below menus/popovers). The
  panel — header, transcript and composer — fills the screen; the toggle is
  header-only, so on mobile, where the panel is already a drawer, it is not shown.
- **One turn in flight per session.** A second send while a turn is streaming is
  refused in-band with `kind: "busy"`; the panel surfaces it as a
  retry-later message rather than as an error banner.

The panel is rendered with `SidebarLayout scrollable={false}` so the transcript
scrolls internally and the composer stays pinned. This and the clickability
traps behind the composer's flex rules are documented in
[design doc §6](./AI-CHAT-DESIGN.md#6-design-constraints-the-bugs-paid-for).

> **Not browser-verified.** Browser automation is unavailable on this host, so
> the panel has never been rendered in a browser. Streaming was proven by an
> authenticated round trip against `POST /api/ai.chat`; the panel's
> cookie+CSRF path was verified by code reading only.

## Fail-soft behavior when env is unset

When `AI_CHAT_BASE_URL` is not set (or the workspace toggle is off):

- The server **boots normally** — there is no crash.
- `POST /api/ai.chat` returns **404**; no upstream request is made.
- The chat **panel is gated** and does not render an entry point.

When `AI_CHAT_BASE_URL` **is** set but `AI_CHAT_MODEL` is unset:

- The server **boots normally** — this is a warning, not a failure.
- A one-line `console.warn` is logged:
  `AI_CHAT_BASE_URL is set without AI_CHAT_MODEL; the AI chat route will return
  404 until AI_CHAT_MODEL is set.`
- `POST /api/ai.chat` returns **404**; no upstream request is made. A request
  with no model could only ever reach the provider as a broken call, so the
  route short-circuits before contacting it.

Setting only `AI_CHAT_API_KEY`/`AI_CHAT_MODEL` (without `AI_CHAT_BASE_URL`) is
the one exception: it is **rejected at boot** by the `@CannotUseWithout`
validator (`process.exit(1)`) — it is not a runtime crash. Leave all three unset
for a clean disabled state.

## Production open items (out of scope)

The current feature targets local development. Before production, address:

- Provider/host selection and TLS/domain termination.
- Secret management and rotation for `AI_CHAT_API_KEY`.
- Reverse-proxy SSE settings: `proxy_buffering off` and a raised
  `proxy_read_timeout`, so the proxy does not buffer or time out the stream.

## Slice 2 (deferred)

Slice 2 layers TanStack AI on the transport proven above. Not implemented in
slice 1. Facts to carry forward:

- **Dependencies** (pin exact versions): `@tanstack/ai`, `@tanstack/ai-client`,
  `@tanstack/ai-react`, `@tanstack/ai-openai`.
- **`tsconfig.json` `paths` fix.** `tsconfig.json:17` sets
  `resolvePackageJsonExports: false`, which requires a `paths` entry for the
  TanStack AI packages; follow the existing precedent in `tsconfig.json:37-40`.
- **Read the request body defensively.** Use
  `chatParamsFromRequestBody(ctx.request.body)` because `koa-body` has already
  drained the request stream into `ctx.request.body` before the route runs.
- **Keep the read-only tool allowlist.** Expose server-side tools only; ignore
  client-supplied `params.tools`; **never** spread `forwardedProps`.
- **Reuse slice 1's mechanics**: abort-on-disconnect, error taxonomy,
  `ctx.compress = false`, and `ctx.req.setTimeout(0)`.
- **Avoid `/mcp-apps`.**
