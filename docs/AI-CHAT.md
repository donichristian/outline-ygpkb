# AI chat

A workspace-gated, **read-only**, streaming AI chat for the Outline fork. It is
delivered as a **transport spike** (slice 1): a hand-rolled Koa Server-Sent
Events (SSE) route that proxies an OpenAI-compatible gateway to a React panel in
the right sidebar. Slice 1 adds **no new npm dependencies**. TanStack AI is
layered on this proven transport in slice 2 (see
[Slice 2 (deferred)](#slice-2-deferred)).

> This document describes what the code actually does. It is grounded in
> `server/routes/api/ai/ai.ts`, `server/routes/api/ai/schema.ts`,
> `app/utils/aiChat.ts`, `server/env.ts`, and `app/scenes/Settings/Features.tsx`.

## What it is

- **Server**: `POST /api/ai.chat` (`server/routes/api/ai/ai.ts`) proxies an
  OpenAI-compatible gateway at `${AI_CHAT_BASE_URL}/chat/completions` with
  `stream: true`, then flushes the upstream response to the browser as SSE
  (`Content-Type: text/event-stream`).
- **Client**: `app/utils/aiChat.ts` opens the streaming request with `fetch`
  (bypassing `ApiClient`) and yields incremental text deltas; a right-sidebar
  panel renders them.
- **Read-only by construction**: the route performs a single upstream `fetch`
  and streams the response. It calls **no** `server/commands/` write path and
  persists nothing. There is **no write endpoint**.

## The gate

The feature is gated by the per-workspace preference `TeamPreference.AIChat`
(“AI chat”), toggled in **Settings > AI** (`app/scenes/Settings/Features.tsx`,
the scene is titled “AI”). Toggling persists via `teams.update` and defaults to
`false`.

The route returns **404** when either condition fails, so an unavailable
endpoint is indistinguishable from an unknown route:

```ts
// server/routes/api/ai/ai.ts
if (!user.team.getPreference(TeamPreference.AIChat) || !env.AI_CHAT_BASE_URL) {
  throw NotFoundError();
}
```

The panel and any entry point are likewise gated on the same preference.

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
   names from `.env.sample`):

   ```dotenv
   AI_CHAT_BASE_URL=http://localhost:20127/v1
   AI_CHAT_API_KEY=
   AI_CHAT_MODEL=your-model-id
   ```

   The app runs at **http://localhost:3050**; the local OpenAI-compatible
   gateway listens at **http://localhost:20127/v1**.

2. Start the stack:

   ```powershell
   .\scripts\dev-start.ps1
   ```

3. Open **Settings > AI** and enable **“AI chat”** (persists via `teams.update`).

4. Open the chat panel (right sidebar) and send a message; the answer streams
   in incrementally.

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
`Scope.Write`), so the request must carry the `x-csrf-token` header whose value
matches the CSRF cookie — `__Host-csrfToken` on secure origins, `csrfToken`
over plain HTTP. Read the cookie from a browser session and pass it both ways:

```sh
curl -N -i -X POST http://localhost:3050/api/ai.chat \
  -b "csrfToken=<token>" \
  -H "x-csrf-token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
# => text/event-stream, incremental "data:" frames, no Content-Encoding
```

A missing or mismatched token yields **403** (JSON), thrown by
`server/middlewares/csrf.ts`.

**Request body.** `messages` is an array (1–50 items) of
`{ role: "user" | "assistant", content: string }`. Per-message `content` is
capped at 8000 characters (`AiChatMaxMessageLength`). The `system` role is
**rejected** so a caller cannot override server-side instructions.

## Verified constraints

These are the properties the spike proves; they are load-bearing, not incidental.

- **Same-origin, no Vite proxy.** The SPA is served by Koa and `/api` is mounted
  there; Vite serves only `/static/`. The client calls `/api/ai.chat` directly.
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
