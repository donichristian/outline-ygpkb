# AI chat

A workspace-gated, **read-only**, streaming AI chat for the Outline fork. It is
delivered as a **transport spike** (slice 1): a hand-rolled Koa Server-Sent
Events (SSE) route that proxies an OpenAI-compatible gateway to a React panel in
the right sidebar. Slice 1 adds **no new npm dependencies**. TanStack AI is
layered on this proven transport in slice 2 (see
[Slice 2 (deferred)](#slice-2-deferred)).

> This is the **operational/usage** document: env vars, the settings toggle, and
> curl recipes. The architecture — request path, the KB-scope grounding gate, the
> streaming transport, and failure modes — lives in
> [**AI Chat — System Design**](./AI-CHAT-DESIGN.md). Read that first if you want
> to understand *why* the code is shaped this way.
>
> This document describes what the code actually does. It is grounded in
> `server/routes/api/ai/ai.ts`, `server/routes/api/ai/scope.ts`,
> `server/routes/api/ai/schema.ts`, `app/utils/aiChat.ts`,
> `app/components/AIChat/`, `server/env.ts`, and `app/scenes/Settings/Features.tsx`.

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
- **Read-only by construction**: the route performs a retrieval probe and a
  single upstream `fetch`. It calls **no** `server/commands/` write path and
  persists nothing. There is **no write endpoint**.

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

Past the feature gate, the route calls `findUngroundedReason(user, messages)`
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

> **The gate is deliberately blunt.** A lexical hit is a claim, not a
> measurement — no false-reject rate has been measured against the live corpus,
> and a full-text OR over-matches shared words while under-matching paraphrase.
> It is biased toward refusing because a refusal is visible and a hallucination
> is not. See
> [**§4 of the design doc**](./AI-CHAT-DESIGN.md#4-the-kb-boundary-rebuilt-three-times)
> for the three-stage history of this boundary and its stated ceiling.

## Environment variables

All three are **optional**. With none set the feature is a safe no-op.

| Variable | Required | Purpose |
|----------|----------|---------|
| `AI_CHAT_BASE_URL` | no | Base URL of an OpenAI-compatible provider, e.g. a URL ending in `/v1`. The route appends `/chat/completions`. When unset, the feature is disabled. |
| `AI_CHAT_API_KEY` | no | **SECRET.** Sent as `Authorization: Bearer <key>` to the provider. **Server-side only — never sent to the browser.** |
| `AI_CHAT_MODEL` | no | Model id forwarded as `model` in the upstream request body. |

Defined in `server/env.ts` (the `AI_CHAT_*` block). Notes:

- `AI_CHAT_API_KEY` and `AI_CHAT_MODEL` are annotated `@CannotUseWithout("AI_CHAT_BASE_URL")`.
  The `CannotUseWithout` validator (`server/utils/validators.ts`) returns false
  when the named property is `undefined`, so setting either key **without**
  `AI_CHAT_BASE_URL` is **rejected at boot**: `Environment` validation collects
  the error and calls `process.exit(1)` with a message like
  `AI_CHAT_API_KEY cannot be used without AI_CHAT_BASE_URL.` It is **not**
  silently ignored.
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

**Gate-off returns 404.** With the toggle off (or `AI_CHAT_BASE_URL` unset) the
endpoint is not reachable:

```sh
curl -i -X POST http://localhost:3050/api/ai.chat \
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
  -b "csrfToken=<token>" \
  -H "x-csrf-token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"<a question answerable from the workspace KB>"}]}'
# => text/event-stream, incremental "data:" frames, no Content-Encoding
```

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
  -b "csrfToken=<token>" -H "x-csrf-token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the capital of France?"}]}'
# => HTTP/1.1 200 text/event-stream
# => event: error
# => data: {"error":"This assistant only answers from this workspace’s knowledge base"}
```

**Request body.** `messages` is an array (1–50 items) of
`{ role: "user" | "assistant", content: string }`. Per-message `content` is
capped at 8000 characters (`AiChatMaxMessageLength`). The `system` role is
**rejected** so a caller cannot override server-side instructions.

## Verified constraints

These are the properties the spike proves; they are load-bearing, not incidental.

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
  the client disconnects (`ctx.req.on("close", …)`), so the provider connection
  is not left open. A mid-stream upstream error is interposed as an in-band
  `event: error` SSE frame rather than a broken pipe.

## Panel behaviour

The panel (`app/components/AIChat/AIChatPanel.tsx`) is mounted into the
**ephemeral** `RightSidebarContext` by `AIChatProvider`
(`app/components/AIChat/AIChatContext.tsx`) — its open state is React state, not
a field on `UiStore`, because the persisted `ui.rightSidebar` enum drives the
Document comments/history panels. Three UI facts worth knowing:

- **Single-line composer.** The input is `type="text"`, not a textarea.
- **Enter sends.** `Input` only fires `onRequestSubmit` on **Cmd+Enter**; the
  panel handles plain `Enter` locally and calls `preventDefault()` so the browser
  does not submit the form a second time.
- **Floating trigger.** `AIChatTrigger` renders a fixed sparkle button
  (bottom-right, `z-index: depths.sidebar - 1` = 899, just below the sliding
  `Aside` at 900) and hides itself while the panel is open.

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

Setting only `AI_CHAT_API_KEY`/`AI_CHAT_MODEL` (without `AI_CHAT_BASE_URL`) is
the one exception: it is **rejected at boot** by the `@CannotUseWithout`
validator (`process.exit(1)`) — it is not a runtime crash. Leave all three unset
for a clean disabled state.

## Production open items (out of scope)

Slice 1 targets local development. Before production, address:

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
