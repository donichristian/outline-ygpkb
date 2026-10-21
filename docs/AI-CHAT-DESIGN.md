---
title: AI Chat — System Design
description: >-
  Request path, KB-scope grounding, session persistence, the TanStack AI
  transport, the AG-UI frame contract and failure modes for the
  workspace-gated AI chat panel.
status: shipped
last_updated: 2026-10-21
related:
  - docs/AI-CHAT.md
  - docs/HERMES-OUTLINE-ARCHITECTURE.md
---

# AI Chat — System Design

Architecture for the workspace-gated AI chat panel: how a keystroke in the
right sidebar becomes a streamed answer from an OpenAI-compatible gateway
through the TanStack AI transport, how the knowledge-base boundary is enforced,
where the conversation is stored, and what happens when any of it fails.

For how to *run and use* the feature — env vars, the settings toggle, curl
recipes — see [docs/AI-CHAT.md](./AI-CHAT.md). That document is the operational
guide; this one is the design.

## 1. Scope and shape

The feature is a **TanStack AI transport, a retrieval gate, and a
server-authoritative session store**:

- **Server** — `POST /api/ai.chat` (`server/routes/api/ai/ai.ts`) validates the
  conversation, decides whether the workspace knowledge base can ground it, then
  runs `chat()` from `@tanstack/ai` against a Chat Completions adapter
  (`server/routes/api/ai/adapter.ts`). The run is framed as AG-UI over SSE by
  `toServerSentEventsResponse` and bridged to Koa as a Node `Readable`. The
  provider's bytes are re-framed, not proxied.
- **Client** — `app/utils/aiChat.ts` builds the TanStack SSE connection
  (`fetchServerSentEvents`) with the CSRF and editor-version headers;
  `AIChatPanel` runs a per-turn headless `ChatClient`, maps AG-UI frames into
  `UIMessage.parts` (`text`, `thinking`, `tool-call`) and renders them into the
  right sidebar.
- **Persistence** — server-authoritative. Two tables carry the conversation:
  `ai_chat_sessions` (one row per conversation, owned by a `(teamId, userId)`
  pair) and `ai_chat_messages` (one row per turn, ordered by `seq`, carrying
  `role`, `content`, `status` and `runId`). When a request supplies a
  `sessionId` or `threadId`, the route appends the turn, streams the answer, and
  writes the terminal assistant row; when it supplies neither, nothing is
  stored. Four RPC endpoints expose the model
  (`server/routes/api/ai/aiSessions.ts`): `ai.sessions.create`,
  `ai.sessions.list`, `ai.sessions.delete` and `ai.messages.list`. On the
  client, `AIChatSessionsStore` and `AIChatMessagesStore` (`app/stores/`) hold
  the same data and are the only thing the panel reads.

The database reads on the path are the ownership lookup, the upstream window
rebuild (§2.3), the grounding probe (§4), and — for a session-backed turn —
the `seq` allocation behind each write.

## 2. Request flow

Diagram A traces a single **session-backed** send from keystroke to the stored
answer: the ownership check, the per-session in-flight lock, the grounding
refusal branch, the TanStack run, the terminal hooks, and the frames the client
consumes. A stateless send (`messages` with neither `sessionId` nor `threadId`)
takes the same path with every storage step short-circuited — no row, no lock,
and no persistence work.

```mermaid
sequenceDiagram
autonumber
actor User
participant Panel as "AIChatPanel (client)"
participant Client as "ChatClient (per turn)"
participant Util as "app/utils/aiChat.ts"
participant MW as "Koa middleware chain"
participant Route as "POST /api/ai.chat"
participant Store as "ai_chat_sessions / ai_chat_messages"
participant Scope as "scope.ts findUngroundedReason"
participant Search as "SearchProviderManager"
participant Lock as "Redis aiChat:inflight:{user}:{session}"
participant Tan as "TanStack chat() + adapter"
participant Hermes as "OpenAI-compatible gateway"

User->>Panel: type text, press Enter or click Send
Panel->>Panel: "handleSubmit applies whenBusy (queue/drop/interrupt) and clears the composer"
Panel->>Util: "createAiChatConnection({ onKind })"
Panel->>Client: "new ChatClient({ connection, threadId: targetSessionId })"
Client->>Util: "sendMessage(content) -> AG-UI body"
Util->>MW: "fetch POST /api/ai.chat with credentials + x-csrf-token + x-editor-version"
Note over MW: "requestContext, koa-body, coalesceBody, apiResponse,<br/>apiErrorHandler, apiContext, verifyCSRFToken"
MW->>Route: dispatch to router
Route->>Route: "auth APP + rateLimiter(TenPerMinute) + validate(AiChatSchema)"
Route->>Route: "sessionId = body.sessionId ?? body.threadId; runId = uuidv4()"
alt "workspace pref off, AI_CHAT_BASE_URL unset, or AI_CHAT_MODEL unset"
Route-->>Util: "404 NotFoundError"
else gate open
Route->>Route: "AIChatSession.findOwned(sessionId, user)"
alt "sessionId/threadId present but not owned"
Route-->>Util: "404 NotFoundError as JSON, before any write or stream"
else ownedSession (or stateless: neither id)
Route->>Lock: "SET aiChat:inflight:{user}:{session} = runId EX 900 NX"
alt "lock not acquired"
Route-->>Util: "200 SSE, synthetic AG-UI run, X-AI-Chat-Kind: busy"
Util-->>Panel: "header observed; typed text restored in composer"
else acquired
Route->>Store: "appendTurn(user, messageText(last message), completed) when the newest client message is a user turn"
Route->>Route: "resolveUpstreamMessages - window from committed rows or client array"
Route->>Scope: "findUngroundedReason(user, resolvedMessages)"
Scope->>Search: "searchForUser(query, limit 1)"
alt "total === 0 or search threw (fails closed)"
Route->>Store: "appendTurn(assistant, refusal string, completed)"
Route-->>Util: "200 SSE, synthetic AG-UI run, X-AI-Chat-Kind: refusal"
Route->>Lock: "compare-and-delete release"
Panel-->>User: "refusal rendered as ordinary assistant text"
else grounded
Route->>Tan: "chat({ adapter, messages, threadId, runId, tools: allowlist, context: user, middleware })"
Tan->>Hermes: "POST /chat/completions, model, stream true"
Hermes-->>Tan: "Chat Completions chunks"
Tan->>Route: "AG-UI events: RUN_STARTED, TEXT_MESSAGE_*, TOOL_CALL_*, REASONING_MESSAGE_*"
Route-->>Util: "SSE data: {json} frames, ctx.compress false, setTimeout 0"
Util-->>Client: "AG-UI events"
Client-->>Panel: "UIMessage.parts (text, thinking, tool-call)"
Panel-->>User: "transcript updates, blinking cursor"
alt "client disconnects or user clicks Stop"
Panel->>Client: "abort()"
Client->>Tan: "AbortController signal"
Tan->>Hermes: "abort upstream fetch"
Tan->>Route: "onAbort()"
Route->>Store: "appendTurn(assistant, partial text, aborted)"
Route->>Lock: "compare-and-delete release"
else "upstream mid-stream error"
Tan->>Route: "RUN_ERROR with a generic message"
Route->>Store: "appendTurn(assistant, partial text, error)"
Route->>Lock: "compare-and-delete release"
else "stream completes"
Tan->>Route: "RUN_FINISHED when finish_reason is present; RUN_ERROR incomplete-stream otherwise"
Route->>Store: "appendTurn(assistant, text, completed | truncated)"
Route->>Lock: "compare-and-delete release"
end
Route-->>Util: "stream closes after the row is durable"
Util-->>Panel: "settled; AIChatMessagesStore.list() re-reads committed rows"
end
end
end
end
```

### 2.0.1 What the diagram asserts

- **The server owns the identifiers.** `sessionId` is resolved once as
  `body.sessionId ?? body.threadId`; the `runId` is minted server-side. A
  client-supplied `runId`, `tools` or `forwardedProps` is never forwarded.
- **Storage is server-authoritative.** The upstream window is rebuilt from
  committed rows (`resolveUpstreamMessages`), never from the client array, once
  a session id is present. A client cannot rewrite history by replaying a
  different `messages` array alongside a session id.
- **The transport owns the terminal event.** TanStack emits `RUN_FINISHED` when
  the provider returned a `finish_reason`, and `RUN_ERROR` when the stream ended
  without one. The persistence middleware maps the adapter's
  `incomplete-stream` code to `truncated`. There is no hand-authored terminal
  frame. See §3.3.
- **Refusal and busy are synthetic runs, not error frames.** Each is a complete
  five-event run carrying ordinary assistant text; the only discriminator is
  the `X-AI-Chat-Kind` response header. The client is already expecting a
  stream from this endpoint, so a bare status would leave it with nothing to
  attach the message to.
- **Every exit releases the lock**, including the two that return before a
  TanStack run exists (`busy` and `refusal`) and the three terminal hooks
  (`onFinish`, `onAbort`, `onError`).

### 2.1 Middleware chain

The route is mounted by `server/routes/api/index.ts`, whose chain is registered
before any domain router:

```
requestContext → koa-body → cleanupMultipartFiles → coalesceBody → userAgent
→ requestTracer → apiResponse → apiErrorHandler → editor → apiContext
→ verifyCSRFToken → plugin Hook.API routes → ai routes
```

Per-route the stack is `auth({ type: [AuthenticationType.APP] })` →
`rateLimiter(RateLimiterStrategy.TenPerMinute)` → `validate(T.AiChatSchema)`.

- **API keys cannot call this route.** `AuthenticationType.APP` admits
  session/bearer authentication only, so the scoped MCP credentials in
  `docs/HERMES-OUTLINE-ARCHITECTURE.md` have no path here.
- **CSRF is enforced for cookie transport.** `verifyCSRFToken()` skips requests
  whose transport is not `cookie`, and skips anything callable with
  `Scope.Read`. `POST /api/ai.chat` is not, so a cookie-authenticated request
  must carry `x-csrf-token` matching the CSRF cookie. `createAiChatConnection`
  attaches it manually from `getCSRFToken()` on every request.

### 2.2 Body shape

`validate(T.AiChatSchema)` accepts either the AG-UI body
`{ threadId, messages: UIMessage[] }` or the legacy RPC body
`{ sessionId, messages: [{ role, content }] }`. `messages` is **optional when
`sessionId` or `threadId` is present** and required otherwise; the `.refine()`
in `server/routes/api/ai/schema.ts` enforces that split. When both are supplied,
`messages` supplies only the *new* turn; the window the provider sees is rebuilt
from storage (§2.3). The panel sends both on every session-backed turn — it
creates the session on the first send of a new chat and always includes the
outgoing turn, because a turn sent with the session alone gives the server
nothing to append and an empty prompt.

Either way the array holds 1–50 messages (`AiChatMaxMessages`). A legacy
message carries 1–8000 characters of `content`; an AG-UI message carries `parts`,
whose `text` parts are flattened with `messageText` and capped at the same
`AiChatMaxMessageLength`. `role` is restricted to `user` or `assistant` in both
shapes: the `system` role is rejected at the schema so a caller cannot inject
server-side instructions. `sessionId` and `threadId` are `z.uuid()`; `threadId`
is only ever used to look up a session the caller already owns, never to create
one.

Because `koa-body` has already drained the request into `ctx.request.body`, the
route cannot hand a stream to TanStack. It calls
`chatParamsFromRequestBody(ctx.request.body)` as the AG-UI shape check and
proceeds when that throws for a legacy `{ role, content }` body, which the zod
schema has already validated.

### 2.3 The upstream window is rebuilt from storage

`resolveUpstreamMessages` (`server/routes/api/ai/ai.ts`) is what makes the store
authoritative rather than advisory:

- **No session id** — the schema has already guaranteed `messages`, so the
  client array is the whole conversation and nothing is read or written.
- **With a `sessionId` or `threadId`** — ownership is resolved first, then the
  rows are read in `seq ASC` order and reduced by `toUpstreamMessages`, which
  keeps only `role` and `content` (dropping `seq`, `status`, `runId`,
  `sessionId`, `teamId`, `userId`) and slices to the most recent
  `AiChatMaxMessages`. `messageText` flattens AG-UI `parts` to `text` first, so
  a legacy `{ role, content }` message and an equivalent AG-UI message produce
  the same provider window. The allow-list is **re-asserted at runtime** on
  every row rather than trusted from the column type, so a stored role outside
  the provider's set cannot be forwarded.

Because ownership is checked before the read, a session belonging to another
user raises `NotFoundError` **without loading a single row**, and before the
response is a stream — so a non-owned id is a normal JSON 404, never a 200 that
carries SSE.

## 3. Streaming transport

The response is AG-UI over SSE, and three details make it work:

- **`ctx.compress = false`** before anything is written. `koa-compress` treats
  `text/event-stream` as compressible and would otherwise buffer, defeating
  incremental delivery.
- **`ctx.req.setTimeout(0)`** clears the per-request socket timeout, which
  would otherwise cut a slow first token.
- **Web stream to Node bridge.** `toServerSentEventsResponse` returns a web
  `ReadableStream`, so the route assigns
  `Readable.fromWeb(response.body as ReadableStream<Uint8Array>)` to `ctx.body`.
  The `apiResponse` middleware skips `Readable` (and `Buffer`) and pipes it
  through untouched. The synthetic refusal/busy runs assign a Node `Readable`
  directly. A bare web `ReadableStream` is never assigned to `ctx.body`.

No `timeout` option is passed to `fetch`, so undici's 300-second default
applies. On client disconnect an `AbortController` aborts the upstream request,
so an abandoned browser tab does not pin a provider connection.

The disconnect listener is on **`ctx.res`, not `ctx.req`**. An `IncomingMessage`
emits `close` exactly once, as soon as its body has been consumed — which
`koa-body` did before this handler ran — so by the time a `ctx.req` listener is
attached that event is already gone and a real disconnect is invisible.
`ServerResponse` emits `close` when the socket actually goes away, which is the
signal this needs; `writableEnded` separates a genuine disconnect from the
ordinary close after `end()`. Verified against a live abort, where `res` fired
within 10 ms and `req` never fired at all.

### 3.1 Failure modes

| Failure | Mechanism | Client sees |
|---|---|---|
| Feature off / unset base URL / unset model | `assertAiChatEnabled` → `NotFoundError` | 404 JSON, `AiChatError kind=http status=404` |
| Session not owned by the caller | `AIChatSession.findOwned` → `NotFoundError`, before any write or stream | 404 JSON, `kind=http status=404` |
| Prompt not grounded | synthetic AG-UI run with `X-AI-Chat-Kind: refusal`, upstream never called; the refusal is stored as a `completed` assistant turn | ordinary transcript text, `kind=refusal` |
| Another turn already streaming for this `(user, session)` | Redis `SET … EX 900 NX` misses → synthetic AG-UI run with `X-AI-Chat-Kind: busy` | `kind=busy`, retry-later; typed text restored in the composer |
| Adapter cannot be built / provider unavailable before the stream | `createAiChatAdapter` or `chat()` throws → `ProviderUnavailableError` (502); lock released | 502 JSON, `kind=http` |
| Upstream rejects the request (non-OK) | adapter surfaces a `RUN_ERROR`; row `error` | `kind=stream` |
| Upstream mid-stream error | `RUN_ERROR` in the same stream, provider text replaced with a generic message; row `error` | `kind=stream` |
| Transport failure / abort | fetch or reader rejects; abort signal fires | `kind=network`, or `kind=aborted` when the caller aborted |
| Unparseable frame | the stream processor rejects | `kind=malformed` |
| Stream ends with no `finish_reason` | adapter `RUN_ERROR` code `incomplete-stream`; row `truncated` | `kind=truncated`, "the answer stopped before it finished" |

Upstream failure is deliberately **in-band**: if the provider dies after the
first token, the browser already holds a 200 `text/event-stream`, and replaying
a status is impossible. An AG-UI `RUN_ERROR` on the same channel is the only
lossless option. The `busy` and `refusal` runs follow the same reasoning: the
client is already expecting a stream from this endpoint and has no frame to
attach the message to otherwise.

### 3.2 From provider chunks to UI parts

The TanStack adapter consumes the provider's Chat Completions chunks and the
engine emits AG-UI events. The client never parses provider frames; `ChatClient`
reads the AG-UI events and projects them into `UIMessage.parts`:

- `TEXT_MESSAGE_*` → one `text` part. Its `content` becomes the answer and is
  the only text the server persists.
- `REASONING_MESSAGE_*` → a `thinking` part. The panel renders it in a
  collapsed `<details>` while the turn streams and drops it on finalize; it is
  never written to a row.
- `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` / `TOOL_CALL_RESULT`
  → a `tool-call` part carrying `name`, `input` and `output`. The panel renders
  a read-only card with a pending state until the result arrives.

Unknown part types render nothing, so a new event kind cannot break the panel.
The wire carries only `data: {json}` frames separated by blank lines: there is
no `event:` field and no provider sentinel, keepalive comments are not
re-emitted, and the client buffers across `read()` boundaries rather than
assuming one frame per chunk.

### 3.3 The terminal event

A stream that simply stops is ambiguous: the socket dropped, a proxy cut the
response, an output limit truncated the answer, and a complete answer all end
the stream identically. AG-UI distinguishes them at the run boundary:

- `RUN_FINISHED` means the provider returned a `finish_reason`; the turn is
  `completed`.
- `RUN_ERROR` with the adapter code `incomplete-stream` means the provider ended
  without one; the persistence middleware records `truncated`.
- `RUN_ERROR` with any other cause records `error`; `onAbort` records
  `aborted`.

The persistence middleware is the single exit point. TanStack awaits exactly one
of `onFinish`, `onAbort` or `onError` before the SSE stream closes, and each
await includes the row write and the lock release, so an `end` after an `error`
cannot append a second row. Status is decided by which hook ran, not by the
writer:

| Exit | Status |
|---|---|
| `onFinish` with a `finishReason` | `completed` |
| `onFinish` without one | `truncated` |
| `onError` with `incomplete-stream` | `truncated` |
| `onError` with any other code | `error` |
| `onAbort` | `aborted` |

An aborted or errored turn still ends the stream; it simply may carry no answer
row when no text was produced. An empty assistant turn is never persisted — the
client optimistically appends `content: ""`, so storing a blank bubble would be
indistinguishable from a lost answer. The response is terminated only once the
turn is durable, so a client that reloads history the instant the run finishes
cannot race the insert.

Turn status is recorded on the row (`AIChatMessage.status`) and returned by
`ai.messages.list`. The four values are `completed`, `aborted`, `error` and
`truncated` — the same four the client-side `AiChatTurnStatus` in
`app/utils/aiChat.ts` declares.

**A stateless chat stores nothing.** The same middleware runs, but `appendTurn`
returns immediately when there is no session id, and no lock was taken. The
stateless response is still a full AG-UI run, so a client cannot tell it apart
from a persisted one on the wire; the difference is only that nothing was
written. The old guarantee that a stateless response matched the provider's
bytes is retired: the transport re-frames every chunk and appends its own
terminal event.

### 3.4 The grounding refusal is stored, and frozen

A refusal is not an error state; it is an answer the boundary gave. So it is
persisted as a **`completed` assistant turn** carrying the exact string that was
sent on the wire.

Two ordering details are load-bearing. The user turn is written **before** the
grounding gate runs (`appendTurn` precedes `findUngroundedReason`), which is what
makes the refusal recoverable — persisting after the gate would leave the refusal
as the first row and lose the question that produced it. And the stored text is
**locale-frozen at send time**: the row holds the literal string sent, not a
translation key, so reopening the session replays the text the sender received
rather than a later translation of a key. Storing the `OutOfScopeRefusal`
constant instead would let the row drift away from the wire on any future change
to either one.

## 4. The KB boundary, rebuilt three times

The whole arc of this work is the boundary between "this workspace's knowledge
base" and "the model's parametric memory." It was built three ways, each
strictly stronger than the last.

### Stage 1 — Prompt text only (not a boundary)

The Hermes profile carried the constraint as prose: the `SOUL.md` persona plus
the workspace's `guidanceMCP`, delivered over the MCP handshake (see
`docs/HERMES-OUTLINE-ARCHITECTURE.md` §4). The toolset allowlist
(`platform_toolsets`) removed every non-KB tool, so the agent had *no path* to
answer off-topic questions with a tool.

It still answered them from memory. Measured: `"What is the capital of France?"`
returned `"Paris."` in roughly 40% of samples. Prompt text is a preference, not
a constraint — the model can always answer from weights it already holds, and
the toolset allowlist cannot prevent that. **Stage 1 is not a boundary.**

### Stage 2 — Phrase denylist (partial)

A denylist of **16 parametric-memory shapes** matched by regex. Each pattern ran
through NFKC normalization, zero-width-character stripping, and a *dual* regex
(a spacing variant and a compact variant) so `"what is the capital"` and
`"whatisthecapital"` both matched.

It caught the common cases and nothing else. Every paraphrase, every spelling
the author had not anticipated, and every language other than English walked
through. A denylist is bounded by the imagination of whoever wrote it; the space
of off-topic questions is not.

### Stage 3 — Retrieval grounding (current)

The boundary became structural: `findUngroundedReason(user, resolvedMessages)` in
`server/routes/api/ai/scope.ts`.

1. `promptText` keeps **only `user` messages**, newest first — an assistant
   echo must not lock a conversation, and a follow-up should spend the term
   budget on the current topic.
2. `normalize` applies NFKC, strips zero-width and soft-hyphen characters,
   lowercases, and replaces everything that is not a letter or digit with a
   space, so no punctuation can survive inside a search term (which also makes
   the later string interpolation `tsquery`-safe).
3. `buildProbeQuery` drops words shorter than 2 characters, drops `WeakTerms`
   (a small set of English function words and conversational filler), drops
   duplicates, and caps the query at **8 terms** (`MaxProbeTerms`), joined with
   `|` — the provider's OR operator. Left unquoted, `pg-tsquery` would AND the
   words and match nothing; quoting is worse, because the provider lifts quoted
   fragments into AND-ed clauses and keeps only the first three.
4. The probe calls `SearchProviderManager.getProvider().searchForUser(user, {
   query, filter: { field: "archivedAt", operator: "isNull" }, offset: 0,
   limit: 1 })` and **`total > 0` decides**.

Two properties are load-bearing:

- **Authorization is the search provider's.** `searchForUser` narrows to
  documents the user can read by membership and collection access. A prompt
  whose only match sits in an unreadable collection returns nothing and is
  refused, so the endpoint cannot be used to probe for inaccessible documents.
- **It fails closed.** If retrieval throws, the prompt is refused ("search
  failed") rather than passed through ungrounded.

Archived documents are excluded from the probe: the assistant cannot open one,
so an archived-only match would approve the prompt only to have the model refuse
it after the upstream latency.

### 4.1 The ceiling, stated plainly

- A lexical hit is a **claim**, not a **measurement**. `total > 0` says a
  document shared a word with the prompt, not that the workspace can answer it.
- **No false-reject rate has been measured against the live corpus.** The
  refusal rate on real traffic is unknown.
- A full-text OR **over-matches** a document that merely shares a common word
  and **under-matches** a paraphrase that shares none. Both directions are known
  and unquantified.
- The gate is **deliberately biased toward refusing**, because a refusal is
  visible to the user and a hallucination is not. A false rejection costs one
  retry; a false acceptance is an ungrounded answer presented as a citation.
- **The term extractor assumes space-delimited scripts.** Whether it retrieves
  depends on the full-text search configuration, and a prompt written in a
  whitespace-free script — Han, Thai, Khmer, Lao, Myanmar, Japanese kana,
  Hangul — is submitted as a single long term with nothing to match, so it
  degrades to near-total refusal regardless of what the workspace contains.
  Those refusals are now distinguishable in the logs as `unsupported script`,
  while a single-token prompt reports `no distinctive terms`. Only the reason
  string differs; the decision is unchanged and still fail-closed.

Cost: one search per request (two or three indexed queries on the read
replica). The upgrade path, if this proves too blunt, is ranking with embeddings,
or keeping the lexical probe and adding a post-hoc check that the upstream stream
cites a `/doc/` URL before any token of it is flushed.

### 4.2 The residual risk of storing history: durable fabrication

Persisting the conversation changes the failure mode. It does **not** change the
security boundary.

**The risk is durable fabrication** — a wrong answer that outlives the session.
Before storage, a hallucinated answer lived only in a scrolling transcript and
died with the tab. Now it is a row: reopen the session next week and the same
false claim is rendered as ordinary assistant text, complete with its original
wording and no indication that the retrieval probe only ever confirmed a shared
word. A durable wrong answer is harder to catch than a transient one precisely
because it looks exactly like a right one on a second reading, and the
`truncated` / `aborted` statuses only mark the cases where the turn *failed* —
they say nothing about whether a `completed` answer is true.

This risk is inherited from the retrieval gate itself and is not made worse by
storage. The gate admits a prompt when `total > 0` (§4.1), which is a claim, not
a measurement; storing the result just makes the consequence durable. The
mitigations already in place — bias toward refusing, the terminal event, the
stored `status` column — bound *whether an answer exists*, never *whether it is
correct*.

**What this is not.** It is **not** an access-control or exfiltration risk, and
it would be wrong to describe it that way. Two properties hold:

- **The route never injects document content.** `ai.ts` forwards exactly the
  conversation rows it holds and sends no document body, no excerpt and no
  snippet upstream. What the provider sees is the user's own turns plus its own
  answers.
- **Grounding is a boolean admit/deny.** `findUngroundedReason` returns a reason
  string or nothing; its result is never rendered into the prompt, never used to
  select which documents the model may open, and never carried into a tool call.
  There is no channel through which stored history could disclose a document the
  user cannot read.

Ownership of a stored session is enforced the same way on every read and write —
`AIChatSession.findOwned(ctx, id, user)` plus `authorize(user, …, session)` — and
the list query narrows on `(teamId, userId)` in one indexed read rather than
filtering per row. A session belonging to another user in the same team is not
that user's session. The four RPC endpoints call `assertAiChatEnabled` **before**
any ownership check, deliberately: resolving ownership first would answer 403 for
a session that is not the caller's and 404 for one that is, turning the endpoint
into an oracle for whether a given session id exists in the workspace.

### 4.3 Retention

`User.destroy()` is a **soft** delete — it stamps `deletedAt` and leaves the row
in place. The `ai_chat_sessions.userId` foreign key therefore never cascades: a
deleted user's conversations would be retained forever.

`CleanupDeletedUsersTask` closes that. It runs hourly, selects users whose
`deletedAt` is older than `RetentionDays = 30` (`User.unscoped()`,
`paranoid: false`, partitioned), and routes each through `userPermanentDeleter`,
which purges their AI chat data. So a user's chat history survives deletion for
**30 days** and is then permanently destroyed.

The same reasoning does *not* extend to `ai_chat_sessions.teamId` vs team
deletion, and the window is a floor on user deletion rather than on session
deletion: `ai.sessions.delete` is a hard destroy (sessions are not soft
deleted), and its messages go with it by way of the `ai_chat_messages.sessionId`
foreign key.

## 5. Components

Diagram B shows the client and server layers and how a click reaches the panel.
Edges are marked **server** when the boundary is enforced in Koa and **client**
when it is only a UI predicate.

```mermaid
flowchart TD
    subgraph entry["Entry points (client-side visibility only)"]
        Trigger["AIChatTrigger<br/>floating button, hides while open"]
        Action["openAIChat command-bar action<br/>visible predicate on TeamPreference.AIChat"]
        Toggle["Settings > AI toggle<br/>Teams.update persists preference"]
    end

    subgraph state["React state (not UiStore)"]
        Provider["AIChatProvider<br/>enabled = team.getPreference(AIChat)"]
        Bridge["module bridge<br/>registerAIChatOpenHandler / openAIChatPanel"]
        Content["AIChatContent effect<br/>setSidebar(panel) / setSidebar(null)"]
    end

subgraph render["Right sidebar render path"]
SidebarCtx["RightSidebarContext<br/>ephemeral content slot"]
Layout["AuthenticatedLayout > Layout<br/>AnimatePresence initial=false"]
SidebarLayout["SidebarLayout scrollable=false<br/>header + content, toggles fullscreen overlay"]
Panel["AIChatPanel<br/>Transcript + Composer + queue"]
Client["ChatClient (per turn)<br/>AG-UI events -> UIMessage.parts"]
History["AIChatHistory<br/>session dropdown, delete confirmation"]
Stores["AIChatSessionsStore + AIChatMessagesStore<br/>RootStore keys aiChatSessions / aiChatMessages"]
end

subgraph server["Koa server (enforced here)"]
Route["POST /api/ai.chat<br/>auth APP + CSRF + rateLimiter + validate"]
Gate["404 gate: TeamPreference.AIChat AND AI_CHAT_BASE_URL AND AI_CHAT_MODEL"]
Scope["scope.ts findUngroundedReason<br/>fails closed"]
Search["SearchProviderManager.getProvider().searchForUser"]
Sessions["ai.sessions.create / list / delete<br/>ai.messages.list<br/>findOwned + authorize"]
Lock["Redis in-flight cap<br/>aiChat:inflight:{user}:{session}, TTL 900s"]
Chain["TanStack chat()<br/>openaiCompatibleText adapter"]
Tools["tools.ts<br/>frozen search_workspace allowlist"]
Persist["persistence middleware<br/>appendTurn + lock release"]
Db[("ai_chat_sessions<br/>ai_chat_messages")]
end

subgraph external["External"]
Gateway["OpenAI-compatible gateway<br/>AI_CHAT_BASE_URL + AI_CHAT_MODEL"]
end

Trigger -->|"client"| Provider
Action -->|"client"| Bridge
Toggle -->|"client"| Provider
Bridge -->|"client"| Provider
Provider --> Content
Content -->|"client"| SidebarCtx
SidebarCtx --> Layout
Layout -->|"client"| SidebarLayout
SidebarLayout --> Panel
Panel --> Client
Panel --> History
History --> Stores
Client -->|"server: fetch /api/ai.chat"| Route
Stores -->|"server: RPC POST"| Sessions
Sessions --> Db
Route --> Gate
Gate --> Scope
Scope --> Search
Search -->|"server: total > 0"| Route
Route -->|"server: SET NX + compare-and-delete"| Lock
Route -->|"server: appendTurn(user)"| Db
Route -->|"server: run"| Chain
Chain -->|"server: tools"| Tools
Chain -->|"server: middleware"| Persist
Persist -->|"server: appendTurn(assistant, status)"| Db
Persist -->|"server: release lock"| Lock
Chain -->|"server: POST /chat/completions"| Gateway
Chain -->|"server: AG-UI events, then close"| Client

classDef clientOnly fill:#eef,stroke:#88a,stroke-dasharray:4 3
classDef serverSide fill:#efe,stroke:#585
class Trigger,Action,Toggle,Provider,Bridge,Content,SidebarCtx,Layout,SidebarLayout,Panel,Client,History,Stores clientOnly
class Route,Gate,Scope,Search,Sessions,Lock,Chain,Tools,Persist,Db serverSide
```

**Server-enforced edges** (a request cannot cross them without satisfying the
check): `Gate` on `TeamPreference.AIChat` + `AI_CHAT_BASE_URL` +
`AI_CHAT_MODEL`, `auth({type: [APP]})`, CSRF, the rate limiter, the zod schema,
the grounding probe, the `findOwned` + `authorize` ownership check on every
session route, the Redis in-flight cap, and the frozen server tool allowlist
(`Chain` never receives tools from the request). A client that skips every UI
predicate still hits these.

**Client-only edges** (visibility, not security): the trigger rendering, the
command-bar `visible` predicate, and the provider withholding its controls when
the preference is off. They exist so the UI does not offer a door the server
will not open; they enforce nothing.

## 6. Design constraints the bugs paid for

These are not trivia — each one is a trap a future change will re-enter.

### 6.1 The composer was clipped

`SidebarLayout` defaults `scrollable = true` and wraps its children in a
`Scrollable`. `AIChatPanel` already provides its own scroller (`Transcript`), so
the panel was nested inside a second `Scrollable`, and `Transcript` had `flex: 1`
without `min-height: 0` — a flex item defaults to `min-height: auto` and will not
shrink below its content. The transcript grew unbounded and pushed the composer
past `Container`'s `overflow: hidden`.

Fixed with `scrollable={false}` on `SidebarLayout` plus `min-height: 0` on
`Container` and `Transcript`.

### 6.2 The Send button was visible but unclickable

`Input`'s root `Wrapper` carries `flex: 0`, i.e. `flex-basis: 0%` — **zero
height** in a column. The `position: relative` inner textarea painted over the
Send button, so `document.elementFromPoint` returned `TEXTAREA` and trusted
clicks were intercepted. `el.click()` still worked, which is exactly why the
unit tests passed while a human could not press the button.

Fixed with `Composer > * { flex: 0 0 auto }`. When the composer became a **row**
the same trap re-appeared as zero **width**, requiring
`Composer > :first-child { flex: 1 1 auto; min-width: 0 }` — `0` rather than
`initial`, because `Wrapper` sets `min-width: initial`, the flex-item automatic
minimum size, which forbids the shrink.

### 6.3 The floating trigger

`AIChatTrigger` renders only when the preference is on and the panel is closed,
and positions itself `position: fixed` at `z-index: depths.sidebar - 1` (899),
just below the sliding `Aside` (900), so it sits under the panel rather than
over it.

### 6.4 Enter sends

`Input` fires `onRequestSubmit` only on **Cmd+Enter** (`Input.tsx`
`handleKeyDown` returns early on the meta branch). The panel handles plain
`Enter` locally in its own `onKeyDown`, calling `preventDefault()` and
`requestSubmit()`. The `preventDefault` is not optional: without it the browser
would implicitly submit the form a second time.

### 6.5 The vacuous test

The `Button` mock in the trigger test hardcoded the CSS under test, so the
assertion passed regardless of the component. The mock now forwards `style`
verbatim; removing `style` from the trigger fails the suite with
`expected '' to be 'fixed'`.

## 7. The routing fact that cost the most time

Within the profile-scoped URL `http://127.0.0.1:8642/p/matius/v1`, the **`model`
field selects the behaviour** — not the path, not the key.

- **`model=matius`** runs the agent: persona, KB tools, MCP guidance, the
  toolset allowlist. This is the AI chat feature.
- **`model=ski-bot`** is a bare model passthrough: no persona, no KB, no tools.

Same URL, same API key, completely different behaviour. The profile path scopes
*which profiles the gateway will serve*; the `model` string selects *what runs
inside the profile*. Changing one without knowing this looks like the boundary
randomly stopped working.

## 8. Honesty notes and verification status

- **The panel has never been rendered in a browser.** Browser automation is
  unavailable on this host (`Windows named-pipe discovery is not implemented`).
  No screenshot exists. Every claim about layout and clickability above is from
  reading the code and the CSS, and is stated as such.
- **Streaming was proven by a real authenticated round trip** through the
  pre-TanStack transport (`POST /api/ai.chat`, Bearer session JWT): 200
  `text/event-stream`, 184 ms to the first frame, 287 incremental deltas, 102 s
  total for a KB question. That measurement predates both turn storage and the
  TanStack rewrite, so it does not describe the current wire. The current
  transport is proven by the server and client suites (AG-UI frame assertions,
  the refusal and busy synthetic runs, the terminal-hook ordering) rather than
  by a live gateway transcript: the gateway at `127.0.0.1:8642` is down on this
  host, so no live model tokens exist. The refusal recipe in AI-CHAT.md was
  verified against the route boundary the test suite exercises, and that run is
  recorded verbatim; no provider output is claimed. The panel's cookie + CSRF
  path was verified by **code reading only**.
- **CI does not run on this fork.** Despite workflow files and
  `actions/permissions.enabled: true`, there are 0 check-runs and 0 workflow
  runs. All verification is local.
- Nothing in this document was inferred from a provider dashboard or an
  external service; every edge in Diagram B corresponds to an import, a call, or
  a context provider in the repository.

## 9. Configuration

Referenced by name only — values live in the environment, never in this
document.

| Variable | Notes |
|---|---|
| `AI_CHAT_BASE_URL` | `@Public`, `@IsUrl` (http/https). Appends `/chat/completions`. Unset disables the feature. |
| `AI_CHAT_API_KEY` | **Secret.** Deliberately **not** `@Public`, so it never serializes to the client. |
| `AI_CHAT_MODEL` | Handed to the `openaiCompatibleText` adapter and forwarded as `model` in the upstream body (§7). **Required to enable the route**: with `AI_CHAT_BASE_URL` set but no model, `POST /api/ai.chat` returns 404 and is never sent upstream. |
| `AI_CHAT_REASONING` | `@IsIn(["minimal", "low", "medium", "high"])`, optional. Sets the Chat Completions `reasoning_effort` through `modelOptions`; unset omits the field entirely. Never read from the request body. |
| `AI_CHAT_GROUNDING` | `@IsBoolean`, default `true`. Runs the local grounding probe (§4). Set `false` to skip it when the provider is itself the retrieval agent and enforces the boundary, so the lexical probe does not refuse prompts the provider can answer. |

`AI_CHAT_API_KEY` and `AI_CHAT_MODEL` are `@CannotUseWithout("AI_CHAT_BASE_URL")`,
so setting either without the base URL is rejected at boot. `AI_CHAT_GROUNDING`
is independent of the base URL. The feature **fails soft**: an unset
configuration is a safe no-op, not a broken server.

The converse — a base URL configured **without** a model — is **not** a boot
failure. `server/env.ts` logs a non-fatal warning and the process stays up; the
route gates on the model and returns 404, identical to the disabled state. A
boot failure was rejected because env validation runs once per process cluster,
so it would stop web, worker, cron, collaboration and websockets for a
single-route misconfiguration and crash-loop a two-step env rollout whose
intermediate state is exactly this one.

Local verification used `AI_CHAT_BASE_URL=http://127.0.0.1:8642/p/matius/v1` and
`AI_CHAT_MODEL=matius` against the Hermes gateway.
