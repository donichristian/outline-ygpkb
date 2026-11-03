# AI chat

A workspace-gated streaming AI chat for the Outline fork: a TanStack AI
transport (`chat()` + `toServerSentEventsResponse`) over a Koa Server-Sent Events
(SSE) route, rendered in a React panel in the right sidebar. The provider is an
OpenAI-compatible gateway; when a session is supplied (`sessionId`, or the AG-UI
`threadId` an `@tanstack/ai-client` caller sends), the conversation is persisted
server-side behind four RPC endpoints. The response is an **AG-UI event stream**,
not a provider passthrough: every frame is `data: {json}` with no `event:` field
and no provider sentinel, and the run terminates with `RUN_FINISHED` or
`RUN_ERROR`. See [Slice 2 (implemented)](#slice-2-implemented).

> This is the **operational/usage** document: env vars, the settings toggle, and
> curl recipes. The architecture — request path, the KB-scope grounding gate, the
> streaming transport, and failure modes — lives in
> [**AI Chat — System Design**](./AI-CHAT-DESIGN.md). Read that first if you want
> to understand *why* the code is shaped this way.
>
> This document describes what the code actually does. It is grounded in
> `server/routes/api/ai/ai.ts`, `server/routes/api/ai/aiSessions.ts`,
> `server/routes/api/ai/scope.ts`, `server/routes/api/ai/schema.ts`,
> `server/routes/api/ai/adapter.ts`, `server/routes/api/ai/middleware.ts`,
> `server/routes/api/ai/messages.ts`, `server/routes/api/ai/tanstack.ts`,
> `server/routes/api/ai/tools.ts`, `app/utils/aiChat.ts`,
> `app/components/AIChat/`, `app/stores/AIChat*Store.ts`, `server/env.ts`,
> `server/queues/tasks/CleanupDeletedUsersTask.ts`, and
> `app/scenes/Settings/AI.tsx`.

## What it is

- **Server**: `POST /api/ai.chat` (`server/routes/api/ai/ai.ts`) first checks
  whether the requesting user's own documents can *ground* the prompt (the
  **scope gate**, `server/routes/api/ai/scope.ts`, see below), then runs a
  TanStack AI `chat()` against an OpenAI-compatible Chat Completions adapter
  (`server/routes/api/ai/adapter.ts`). The run is framed as AG-UI over SSE by
  `toServerSentEventsResponse` and bridged to Koa as a Node `Readable`.
- **Client**: `app/utils/aiChat.ts` builds the TanStack SSE connection with
  `fetchServerSentEvents` (bypassing `ApiClient`) and attaches the CSRF and
  editor-version headers per request. `AIChatPanel` constructs a per-turn
  headless `ChatClient`, maps AG-UI frames into `UIMessage.parts` (`text`,
  `thinking`, `tool-call`) and renders them in the right sidebar.
- **Persisted, server-authoritative sessions**: when a request carries a
  `sessionId` or `threadId`, the conversation is stored in `ai_chat_sessions` and
  `ai_chat_messages` and the provider's prompt window is rebuilt from those rows.
  The server mints the `runId`; the client cannot supply one. The panel creates a
  session on the first send of a new chat and sends the new turn alongside it, so
  a conversation always persists and survives closing the panel. At the API level
  a request with neither `sessionId` nor `threadId` stores nothing. Four RPC
  endpoints expose the model — see [The session API](#the-session-api).

**Read-only with respect to your documents.** The route never writes a
document, never modifies a collection, and never lets the *client* inject
document content into the prompt. Its only writes are to the two AI chat tables
above.

Tool results are a deliberate exception to "no document content in the prompt":
when the model calls `fetch_document` or `search_workspace`, the returned
Markdown excerpt re-enters the model context as a tool message. That text is
treated as untrusted input — each `fetch_document` read returns at most
`MAX_CHUNK_LIMIT` (60,000) characters and reports `truncated` plus the
`characters` returned so a long body can be paged with `offset`, the tool
surface is server-owned and read-only, and archived documents are excluded —
but it does mean the model reads real document bodies in order to answer.

## The gate

There are **two** gates on the request path, in order.

### 1. Feature gate

The feature is gated by the per-workspace preference `TeamPreference.AIChat`
(“AI chat”), toggled in **Settings > AI** (`app/scenes/Settings/AI.tsx`, the
scene is titled “AI”). Toggling persists via `teams.update` and defaults to
`false` (`shared/constants.ts`).

The route returns **404** when any condition fails, so an unavailable endpoint
is indistinguishable from an unknown route. Both a base URL **and** a model are
required, because a base URL without a model can only produce a broken upstream
request:

```ts
// server/routes/api/ai/enabled.ts — the single definition of the gate
export function assertAiChatEnabled(user: User) {
  if (
    !user.team.getPreference(TeamPreference.AIChat) ||
    !env.AI_CHAT_BASE_URL ||
    !env.AI_CHAT_MODEL
  ) {
    throw NotFoundError();
  }
}
```

All five AI endpoints (`ai.chat`, and the four `ai.sessions` / `ai.messages`
ones in `server/routes/api/ai/aiSessions.ts`) call this before any ownership
check, so a non-owner's session returns 404 rather than 403 and the endpoint is
not an oracle for session ids.

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
probe for documents the user cannot read. The refusal arrives as a **synthetic
AG-UI run** carrying the refusal text as ordinary assistant content, marked by
the `X-AI-Chat-Kind: refusal` response header, so the panel renders it as
ordinary transcript text rather than an error.

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

All of these are **optional**: the process boots without any of them and the
feature is a safe no-op. `AI_CHAT_MODEL` is, however, required to *enable* chat
once a provider is configured.

| Variable | Required | Purpose |
|----------|----------|---------|
| `AI_CHAT_BASE_URL` | no | Base URL of an OpenAI-compatible provider, e.g. a URL ending in `/v1`. The route appends `/chat/completions`. When unset, the feature is disabled. |
| `AI_CHAT_API_KEY` | no | **SECRET.** Sent as `Authorization: Bearer <key>` to the provider. **Server-side only — never sent to the browser.** |
| `AI_CHAT_MODEL` | **when `AI_CHAT_BASE_URL` is set** | Model id handed to the TanStack adapter (`openaiCompatibleText`) and forwarded as `model` in the upstream request body. With a base URL configured but no model, the route returns **404** and no upstream request is made. |
| `AI_CHAT_REASONING` | no | Reasoning effort requested from the provider: `minimal`, `low`, `medium` or `high`. Unset means the upstream body carries no reasoning field. Sent as the Chat Completions `reasoning_effort` through `modelOptions` (see [Panel behaviour](#panel-behaviour)); never read from the request body. |
| `AI_CHAT_GROUNDING` | no | Whether the route runs the local grounding probe (§2). Defaults to `true`. Set to `false` when the provider is itself a retrieval agent that enforces the knowledge-base boundary — the local lexical probe would otherwise refuse prompts the provider can answer. |
| `AI_CHAT_SYSTEM_PROMPT` | no | Whether the route prepends the repository's own assistant instruction layer as a leading system message: answer only from the workspace knowledge base, cite the document link for every claim, say so plainly when the workspace lacks the answer, read a document with `fetch_document` before summarising it, treat document text as data, and reply in the user's language. Defaults to `false`, so the upstream body is unchanged unless an operator opts in. Set to `true` when the provider is a plain model that needs this repository to state the knowledge-base boundary. |

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
- Setting **none** of them is a safe no-op (see
  [Fail-soft behavior](#fail-soft-behavior-when-env-is-unset)).

## How to run the spike

The TanStack packages are ESM-only and are loaded dynamically
(`server/routes/api/ai/tanstack.ts`), so the CommonJS server build still works:
run `yarn build:server` before booting.

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
# => HTTP/1.1 200
# => Content-Type: text/event-stream
# => data: {"type":"RUN_STARTED",...}
# => data: {"type":"TEXT_MESSAGE_START",...}
# => data: {"type":"TEXT_MESSAGE_CONTENT","delta":"…",...}
# => data: {"type":"TEXT_MESSAGE_END",...}
# => data: {"type":"RUN_FINISHED",...}
```

Each frame is one `data: {json}` line followed by a blank line. There is no
`event:` field and no provider sentinel. A reasoning model may emit
`REASONING_MESSAGE_*` frames before the answer, and a tool-enabled run emits
`TOOL_CALL_*` frames between text frames. The terminal event is `RUN_FINISHED`
when the provider returned a `finish_reason`, and `RUN_ERROR` when it did not.

Pass `"sessionId":"<uuid>"` (or the AG-UI `"threadId":"<uuid>"`) instead of
`messages` to run a session-backed turn; the response is the same AG-UI shape and
the turn is written to storage.

A missing or mismatched token yields **403** (JSON), thrown by
`server/middlewares/csrf.ts`.

> **The prompt must be grounded.** Sending `"hi"` is refused by the scope gate
> (no matching document) and returns a `text/event-stream` carrying a synthetic
> AG-UI run with `X-AI-Chat-Kind: refusal` — not an answer. To exercise the
> provider path on the command line, send a question whose terms appear in a
> document the calling user can read.

**Refusal check.** A prompt the knowledge base cannot ground is refused **before**
the provider is contacted. This recipe was verified against the request boundary
the test suite drives (local PostgreSQL and Redis, real Koa route, provider never
called); the verbatim output is in `.omo/evidence/21-docs.txt`:

```sh
curl -N -i -X POST http://localhost:3050/api/ai.chat \
  -b "accessToken=<session token>; csrfToken=<token>" \
  -H "x-csrf-token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the capital of France?"}]}'
# => HTTP/1.1 200
# => Content-Type: text/event-stream
# => X-AI-Chat-Kind: refusal
# => data: {"type":"RUN_STARTED","runId":"<uuid>","timestamp":…}
# => data: {"type":"TEXT_MESSAGE_START","messageId":"<uuid>","role":"assistant","timestamp":…}
# => data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"<uuid>","delta":"This assistant only answers from this workspace’s knowledge base","timestamp":…}
# => data: {"type":"TEXT_MESSAGE_END","messageId":"<uuid>","timestamp":…}
# => data: {"type":"RUN_FINISHED","runId":"<uuid>","timestamp":…}
```

The header is the only discriminator. The body is an ordinary, complete run, so
the client's stream reader needs no special case; a consumer that ignores the
header will read the refusal as assistant text, which is the intended fallback.

**Request body.** `messages` is an array (1–50 items) in either accepted shape:
the legacy `{ role: "user" | "assistant", content: string }` or the AG-UI
`{ id, role, parts }`, where a `text` part carries `content`. Per-message text is
capped at 8000 characters (`AiChatMaxMessageLength`). The `system` role is
**rejected** in both shapes so a caller cannot override server-side instructions.

`messages` is optional when `sessionId` or `threadId` is present, and required
otherwise. A `.refine()` in `server/routes/api/ai/schema.ts` enforces exactly
that: a body with neither is rejected with
`messages is required when sessionId is not provided`. Send either

```sh
# stateless turn — the client array is the whole conversation, nothing is stored
-d '{"messages":[{"role":"user","content":"…"}]}'

# session-backed turn — the window is rebuilt from storage
-d '{"sessionId":"<uuid>"}'

# AG-UI caller — threadId is the persisted session id
-d '{"threadId":"<uuid>","messages":[{"id":"…","role":"user","parts":[{"type":"text","content":"…"}]}]}'
```

Both may be sent together; `messages` then supplies only the **new** turn, while
the rest of the window comes from the stored rows. A `threadId` is never used to
create a session: it must name one the caller already owns, or the request is
**404**.

> **Parsed body, not a request stream.** `koa-body` has already drained the
> request into `ctx.request.body` before this route runs, so the route cannot
> hand a stream to the TanStack library. It calls
> `chatParamsFromRequestBody(ctx.request.body)` as the AG-UI shape check, and
> proceeds when that throws for a legacy `{ role, content }` body because the zod
> schema has already validated it.

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

Every chat turn is an AG-UI run, so the terminal event is the run's own
`RUN_FINISHED` (a whole answer) or `RUN_ERROR` (an interrupted one), not a
server-authored sentinel. A stream that ends without a `finish_reason` raises a
`RUN_ERROR` whose adapter code is `incomplete-stream`; the persistence
middleware maps that code to `status: "truncated"`, an abort to `"aborted"` and
any other error to `"error"`. A **stateless** turn (`messages` with neither
`sessionId` nor `threadId`) returns this same AG-UI stream and stores nothing.
The old guarantee that a stateless response matched the provider's bytes is
retired: TanStack re-frames every chunk and appends its own terminal event, so
no consumer may depend on the provider's wire format.

Refusal and busy are **not** `RUN_ERROR`: each is a complete synthetic run
(`RUN_STARTED … RUN_FINISHED`) carrying ordinary assistant text, and the only
thing that tells them apart from a real answer is the `X-AI-Chat-Kind:
refusal|busy` response header. The client branches on that header alone, never
on the message text or the run id.

### Retention

AI chat data belonging to a **deleted** user is permanently destroyed after a
**30-day** window by `CleanupDeletedUsersTask`
(`server/queues/tasks/CleanupDeletedUsersTask.ts`, `RetentionDays = 30`, hourly
with a 15-minute partition window). The reason a dedicated task exists at all:
`User.destroy()` is a *soft* delete, so the `ai_chat_sessions.userId` foreign key
never cascades.

### What a stored turn keeps

A stored assistant row carries two columns beyond its text, so reopening a
conversation shows what the answer was built from without re-running any tool:

- `toolCallDigest` (JSONB) — a **body-free** digest of the tool calls made
  while generating the turn. It records which tool was called and with what
  identifier or query, never the document body a tool returned, so the column
  cannot become a second copy of the knowledge base. The transcript renders it
  as a tool-call card under the turn.
- `citationMiss` (boolean, default `false`) — set when the answer cited no
  document link or id that a tool returned in the same run. The panel renders a
  subdued “No sources found” note inside that turn, so an unsourced answer is
  visible when the conversation is reopened, not only while streaming.

Because the digest is body-free, reading a stored conversation is not a way to
read a document the reader could not open at the time.

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
- **The TanStack connection bypasses `ApiClient`.** The CSRF and editor-version
  headers are attached manually per request in `app/utils/aiChat.ts`, because
  the token is read at call time and may rotate.
- **`koa-compress` is bypassed** via `ctx.compress = false`. SSE must not be
  compressed — buffering defeats incremental delivery. Default `compressible`
  filtering would otherwise match `text/event-stream`.
- **Socket timeout.** The server-wide timeout is connection-level
  (`server.setTimeout(env.REQUEST_TIMEOUT)`, ~10s), which would cut a slow
  first token. The route calls `ctx.req.setTimeout(0)` to disable it per request.
- **Node stream bridge.** `toServerSentEventsResponse` returns a web
  `ReadableStream`, so `Readable.fromWeb(response.body)` is assigned to
  `ctx.body`: the `apiResponse` middleware skips `Readable` (and `Buffer`), so
  the stream is piped through untouched. The synthetic refusal and busy runs
  assign a Node `Readable` directly. A bare web `ReadableStream` is never
  assigned to `ctx.body`.
- **Abort on disconnect.** An `AbortController` aborts the upstream request when
  the client disconnects (`ctx.res.on("close", …)`, not `ctx.req` — see the
  design doc), so the provider connection is not left open. A mid-stream upstream
  error is interposed as an in-band `RUN_ERROR` frame rather than a broken
  pipe, and its provider text is replaced with a generic message so upstream
  detail never reaches the browser.
- **Ownership is resolved before the stream exists.** With a `sessionId` or
  `threadId`, a non-owned session is a JSON **404**, never a 200 carrying SSE,
  and the rows are never loaded.
- **The window comes from storage, not the client.** `resolveUpstreamMessages`
  rebuilds the provider prompt from committed rows, re-asserting the role
  allow-list per row, so a replayed `messages` array cannot rewrite a stored
  conversation.
- **The response ends only after the turn is durable.** TanStack awaits the
  terminal hook (`onFinish` / `onAbort` / `onError`) before the SSE stream
  closes, and the persistence middleware awaits the row write inside that hook,
  so a client that reloads history the moment the run finishes cannot race the
  insert.
- **Tools are the server's own, read-only.** `server/routes/api/ai/tools.ts`
  exports a frozen allowlist — `search_workspace`, `recommend_documents` and
  `fetch_document` — passed to `chat({ tools })` as-is. The request body is
  never read for tools, and `forwardedProps` is never spread into the run, so a
  client cannot add a tool. `fetch_document` converts one document to Markdown
  through `DocumentHelper.toMarkdown`, returns at most `MAX_CHUNK_LIMIT`
  (60,000) characters per call, and reports `characters` and `truncated` so a
  long document can be paged with `offset` or narrowed with `section`. It
  authorizes with the requesting user's own read ability, so a guessed id
  cannot read a document the caller cannot open. A document bound into the run
  (`boundDocumentId`) wins over any id the model passes.

### The tool surface

Three tools, all read-only, all server-owned. There is no write tool and no way
for a caller to add one.

| Tool | Input | Returns | Bound |
| --- | --- | --- | --- |
| `search_workspace` | `query` (free text), optional `collectionId`, optional `limit` | Document titles, links and matching snippets | Results limited to documents the requesting user can already read; 5 by default, at most 10 |
| `recommend_documents` | `query`, optional `limit` | The same shape, filtered to results with a non-empty reason | 5 by default, at most 10 |
| `fetch_document` | `documentId` or url slug, optional `section`, optional `offset`, optional `limit` | `{ documentId, title, url, markdown, characters, truncated }` | At most `MAX_CHUNK_LIMIT` (60,000) characters per call; authorized with the caller's own read ability |

The caps matter for containment: `search_workspace` and `recommend_documents`
bound the number of documents pulled into context (`MaxToolResults = 5`
by default, `MaxToolResultsBound = 10` as a ceiling regardless of what the model
asks for), and `fetch_document` bounds the size of a single body read while
reporting `truncated` so the model can page with `offset` instead of assuming it
saw the whole document.
- **The in-flight lock is bounded and released on every exit.** The Redis key
  `aiChat:inflight:{userId}:{sessionId}` is taken with `SET … EX 900 NX` and
  released by compare-and-delete on finish, error, abort and refusal. The TTL is
  900s because the unit that matters is a **tool loop**, not one model call
  (roughly 5 rounds × (120s model + 5s tool) ≈ 625s worst case); a lock that
  expired mid-stream would silently defeat the cap, so the cost is pushed into
  the crash case.
- **The tool loop is bounded by the engine, not by this route.** No
  `agentLoopStrategy` is passed, so `@tanstack/ai` applies its default
  `combineStrategies([maxIterations(5), untilFinishReason(["length"])])` — five
  model turns, then a final answer. That default is what the lock TTL above is
  sized against; changing it means re-deriving the TTL.
- **Token usage is logged, not stored or enforced.** `RUN_FINISHED.usage` is
  captured by the persistence middleware's `onChunk` and logged with
  `requestId`/`sessionId`/`runId`/`status`. The value is provider-shaped, so it
  is passed through opaque; there is no spend cap and no per-message column.
- **Reasoning is an operator decision.** `AI_CHAT_REASONING` sets the Chat
  Completions `reasoning_effort` through `modelOptions`; the request body never
  carries a reasoning level, and an unconfigured value omits the field entirely.

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
- **Reasoning is a collapsed, live-only disclosure.** A `thinking` part is shown
  behind a collapsed `<details>` whose summary reads "Loading…", never as the
  reply. It exists only for the in-flight turn — the panel filters it out once
  the turn finalizes — and it is never persisted, so a reopened conversation
  shows the answer without the thinking behind it. The provider's
  `reasoning_content` reaches the client as AG-UI `REASONING_MESSAGE_*` frames.
- **Tool calls are read-only cards.** A `tool-call` part renders the tool name,
  its input and its output, with a pending state while the call is still
  running. There is no approval affordance; that belongs to the deferred
  interrupts slice.
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
  refused by the server with a synthetic run marked `X-AI-Chat-Kind: busy`; the
  panel surfaces it as a retry-later message rather than as an error banner,
  and **puts the typed text back in the composer** so the retry is actionable.
- **A send while streaming is queued by default.** The `whenBusy` prop selects
  `queue` (default), `drop` or `interrupt`. Queued messages live in panel state,
  never in the transcript and never in a stored row, and each one can be
  cancelled on its own. The queue drains only after a settled turn; a failed or
  interrupted turn discards it.
- **The composer can be prefilled, and the prefill is one-shot.**
  `openAIChatPanel(prompt?)` (`AIChatContext.tsx`) is a module-level bridge: the
  command bar is a plain object with no React context, so the provider registers
  its `open` callback there on mount and clears it on unmount. The argument is
  either a string or an `AiChatPrefill` (`{ prompt, documentId? }`). The panel
  **consumes** the pending prefill (`consumePendingPrompt`) and seeds the
  composer, so it is used exactly once — reopening the panel later does not
  replay it. A prefill that was seeded but never sent is put back with
  `restorePendingPrompt`, and only if a newer prefill has not arrived in the
  meantime.
- **“Ask AI about this document” carries the document into the run.** The
  `askAIDocument` command-bar action
  (`app/actions/definitions/documents.tsx`) is visible only for an active
  document in a workspace with the preference on. It prefills
  “Ask AI about this document: <title>” *and* passes `documentId`, which becomes
  the top-level `documentId` of the chat request. The server binds that id into
  the run, so `fetch_document` reads that document even when the model passes a
  different id, and the grounding probe is scoped to it. The field is omitted
  entirely when no document is bound, rather than sent as `null`.
- **Starter prompts seed the composer; they never send.** While the transcript
  has no turn, three starter prompts render above the composer. Clicking one
  writes it into the input and focuses the field, so the user can edit before
  sending. There is no separate send path and no hidden state: the click is
  equivalent to typing.
- **An unsourced answer is marked, live and stored.** When the answer cited no
  document that a tool returned in the same run, the turn carries
  `citationMiss` and the panel renders a subdued “No sources found” note inside
  that turn. The flag is persisted, so the marker is still there when the
  conversation is reopened.

The panel is rendered with `SidebarLayout scrollable={false}` so the transcript
scrolls internally and the composer stays pinned. This and the clickability
traps behind the composer's flex rules are documented in
[design doc §6](./AI-CHAT-DESIGN.md#6-design-constraints-the-bugs-paid-for).

> **Not browser-verified.** Browser automation is unavailable on this host, so
> the panel has never been rendered in a browser. The transport was proven by an
> authenticated round trip against `POST /api/ai.chat` and by the server and
> client test suites; the panel's cookie+CSRF path was verified by code reading
> only.

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
validator (`process.exit(1)`) — it is not a runtime crash. Leave them all unset
for a clean disabled state.

## Production open items (out of scope)

The current feature targets local development. Before production, address:

- Provider/host selection and TLS/domain termination.
- Secret management and rotation for `AI_CHAT_API_KEY`.
- Reverse-proxy SSE settings: `proxy_buffering off` and a raised
  `proxy_read_timeout`, so the proxy does not buffer or time out the stream.

## Slice 2 (implemented)

Slice 2 replaced the hand-rolled provider proxy with the TanStack AI transport.
It is implemented and shipped; what follows is the boundary of that work.

**Shipped:**

- `@tanstack/ai`, `@tanstack/ai-client`, `@tanstack/ai-react` and
  `@tanstack/ai-openai` pinned to exact versions.
- An ESM loader seam (`server/routes/api/ai/tanstack.ts`) because all four
  packages publish an `import`-only exports map and the server build emits
  CommonJS. The loader assembles a real `import()` that swc cannot rewrite to
  `require()`.
- `openaiCompatibleText` with `api: "chat-completions"`
  (`server/routes/api/ai/adapter.ts`), the only place the adapter is built.
- `chat()` + `toServerSentEventsResponse` on `POST /api/ai.chat`, with the
  response bridged to Koa as a Node `Readable` (`Readable.fromWeb`).
- The `threadId` alias: the server resolves `body.sessionId ?? body.threadId`,
  mints its own `runId`, and ignores any client-supplied `runId`, `tools` or
  `forwardedProps`.
- A frozen, read-only server tool allowlist
  (`server/routes/api/ai/tools.ts`, `search_workspace` + `recommend_documents` +
  `fetch_document`) passed to `chat({ tools })`; client-supplied tools are
  ignored.
- Reasoning through `AI_CHAT_REASONING` → `modelOptions.reasoning_effort`, with
  thinking rendered live-only as a collapsed disclosure.
- AG-UI `UIMessage.parts` on the client: `text`, `thinking` and `tool-call`
  render from one parts model, while the stored transcript stays flat.
- A per-turn headless `ChatClient` (not `useChat`) because the persisted session
  id only exists after the first send, and a `threadId` is fixed at construction.
- The `whenBusy` queue (`queue` / `drop` / `interrupt`) in panel state, with a
  per-item cancel and the busy-text restore.
- `chatParamsFromRequestBody(ctx.request.body)` as the AG-UI body check, since
  `koa-body` already parsed the request.
- The in-flight lock TTL raised to **900s** and justified by the tool-loop worst
  case; the lock is released on finish, error, abort and refusal.
- Server tests assert the AG-UI contract (no `event:` names, no provider
  sentinel); client tests assert the parts model, tools, reasoning and queue.

**Resolved since this slice was written:**

- **Document body reading.** `fetch_document` reads a real document body through
  the shared `server/commands/documentReader.ts`, capped at
  `MAX_CHUNK_LIMIT` (60,000) characters per call with `offset` paging and a
  optional `section` narrow. The external-agent fetch tool and the AI tool now
  share one reader instead of duplicating it.
- **Scoped search and recommendation.** `search_workspace` takes an optional
  `collectionId` and `limit`; `recommend_documents` returns only results that
  carry a reason, so “recommend” has something to rank by.
- **Citation marking.** A turn with no tool-returned identifier in its answer is
  stored with `citationMiss = true` and shown as “No sources found”.
- **Tool-call persistence.** A stored assistant turn keeps a body-free
  `toolCallDigest`, so what the assistant read is visible after the fact.
- **A repository-side instruction layer.** `AI_CHAT_SYSTEM_PROMPT` opts into a
  leading system message that states the knowledge-base boundary, the citation
  rule, the read-before-summarise rule and the “document text is data” rule.

**Still deferred (unchanged from the plan):**

- **Subagents and interrupts.** No `defineAgent`, no approval affordance, no
  human-in-the-loop tool gate.
- **Resumable streams.** A dropped connection is not resumed; the turn is
  recorded as truncated or aborted and the client retries from scratch.
- **TanStack persistence.** The library's own persistence is not used; the
  server store remains authoritative.
- **Client tools.** Never accepted; the allowlist is the only source of tools.
- **Token usage.** No usage capture or display; the provider's usage tail is not
  surfaced.

**Carry-forward engineering facts:**

- `tsconfig.json` sets `resolvePackageJsonExports: false`, so the TanStack
  packages need `paths` entries (the precedent is the `vite` entry).
- The packages are ESM-only; any new runtime import must go through
  `loadTanstack()` / `loadOpenaiCompatible()`, never a static import.
- Keep slice 1's mechanics: abort-on-disconnect, the eight-kind client error
  taxonomy, `ctx.compress = false`, and `ctx.req.setTimeout(0)`.
- Avoid `/mcp-apps`.
