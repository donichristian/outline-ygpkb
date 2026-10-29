# tanstack-ai-slice2-adoption - Work Plan

## TL;DR (For humans)

**What you'll get.** The Outline fork's AI chat stops being a hand-rolled SSE proxy and
speaks the TanStack AI / AG-UI stream contract on both ends: `chat()` +
`toServerSentEventsResponse` on the server, `useChat` + `UIMessage.parts` on the client.
Read-only server tools, `reasoning` passthrough, and a real message queue land in the same
slice.

**Why this approach.** `docs/AI-CHAT.md:584-601` already reserves this as slice 2. We keep
the pieces that are load-bearing and correct today — the grounding gate, the four RPC
endpoints, the `ai_chat_sessions`/`ai_chat_messages` tables, the per-session in-flight
lock, the refusal/busy taxonomy, the CSRF path — and replace only the transport. No
migration, no new columns, no data loss.

**What it will NOT do.** No subagents, no resumable streams, no `@tanstack/ai-persistence`,
no client-supplied tools, no token-usage capture, no `finishReason` column, no agentic-loop
tuning. No new product surface — this is a transport and rendering swap plus three
capabilities.

**Effort.** XL — multi-wave architectural work: 22 implementation todos across 7 waves, one
full server-transport rewrite, one client-transport rewrite, two new capability layers, and
a rewrite of ~20 test files.

**Risk.** Two spikes gate everything: (1) the `@tanstack/ai*` packages must be
`require`-able from the CommonJS server build (`.swcrc:31-33`, no `type: module`), not just
type-resolvable; (2) the OpenAI-compatible gateway must always send a terminal
`finish_reason` (or a usage-only tail) or Chat-Completions adapters emit
`RUN_ERROR: incomplete-stream` and skip `onFinish`. Both are verified in W0 before any
rewrite.

**Decisions.** D1 transport swap only, keep the rest. D2 reuse the existing tables;
`sessionId` → `threadId`. D3 tools + reasoning + queue all IN this slice. The transcript
stays store-merged with `useChat` as the frame source; stateless (`messages`-only) requests
keep working but lose the byte-identical passthrough guarantee; the per-session lock stays
and gains an `onError` release plus a justified TTL.

## Scope

### Affected user and ideal state

**Who this touches**

1. **Workspace member using the AI chat panel** — sends a message, watches it stream, stops
   it, reopens the conversation later, asks a question the tool allowlist can answer.
2. **Developer maintaining the fork** — must be able to follow the TanStack AI guides
   instead of reverse-engineering a bespoke transport.
3. **The OpenAI-compatible gateway** (Hermes or any compatible provider) — a *program*
   consumer whose `finish_reason`/usage behaviour now decides whether a whole stream
   succeeds. It is a contract dependency, not a black box.
4. **RPC consumers** of `ai.sessions.create|list|delete` and `ai.messages.list` — scripts and
   API-key callers that read the flat `{id, seq, role, content, status, runId, createdAt}`
   message shape.

**Ideal state**

| ID | Property (what will be true) | Reason |
|---|---|---|
| IS-1 | The server emits and consumes the TanStack AI / AG-UI stream contract via `chat()` + `toServerSentEventsResponse`; no bespoke `sseFrame` proxy remains on the chat path. | Makes the guides applicable and the next slice cheap. |
| IS-2 | Every existing behaviour survives: feature-gate 404, grounding refusal rendered inline as an ordinary assistant turn and persisted `completed`, CSRF requirement, one turn in flight per session, session/message persistence, all four RPC endpoints, and the `completed\|aborted\|error\|truncated` turn-status enum. | No user-visible regression. |
| IS-3 | Messages on the client are `UIMessage.parts` (`text` / `thinking` / `tool-call`) rather than flat `{role, content}` strings; the stored transcript is flattened from text parts so the DB column and the RPC shape are unchanged. | Enables reasoning and tool rendering from the library model without breaking RPC consumers. |
| IS-4 | A fixed read-only server tool allowlist works end-to-end (model calls tool → server executes → result returns → call renders), and any client-supplied tool payload is ignored. | Closes the bounded half of the Agentic Cycle guide with no client-controlled surface. |
| IS-5 | `reasoning` passthrough produces `ThinkingPart`s behind a collapsed disclosure, live-only for the in-flight turn (dropped once the turn finalizes). | Replaces the ad-hoc `{type:"reasoning"}` event with the guide's model while preserving today's UX. |
| IS-6 | A send while a reply is streaming is governed by `whenBusy` (`queue` / `drop` / `interrupt`); a refused or busy send never silently discards the typed text. | Closes the Message Queue guide and the known composer-text-loss defect. |
| IS-7 | `yarn lint`, `yarn tsc --incremental false`, `yarn build:server`, `yarn test:server`, `yarn test:app` all pass; new tests prove IS-1..IS-6, IS-8, IS-9. **Amended during the Final Wave (row 25):** `yarn test:server` exits 1 on a pre-existing Windows baseline of 26 failures in 9 files, all outside the AI surface (cron period parsing, storage `files.get`, `documents.export`, `revisions.export`, `MarkdownAPIImport`, `documentImporter`, PDF converter); the same failures reproduce at base `9253e4f6d`. The four other commands exit 0, and for `test:server` the gate is "no NEW failure versus the baseline", proven by the AI suites being green. | No regression; alignment is verifiable by a machine. |
| IS-8 | A request with `messages` and no `sessionId` still works and still stores nothing; the "byte-identical to the provider" guarantee is retired and documented as retired. | Preserves the stateless API consumers; removes a guarantee that a wrapping transport cannot honour. |
| IS-9 | A tool-driven run cannot outlive or strand the per-session lock: the lock releases on `RUN_ERROR` as well as on finish, and its TTL is justified against a multi-round-trip tool run. | Keeps the one-turn-in-flight invariant true once one HTTP run can make N upstream calls. |

**Gaps from today**

| ID | Gap | Reason |
|---|---|---|
| GAP-1 | No `@tanstack/ai*` dependency; types may need a `tsconfig.json` `paths` entry (precedent `tsconfig.json:39-40`) and the CJS server build must actually `require` them. | Nothing to build on. |
| GAP-2 | `POST /api/ai.chat` hand-rolls `fetch` + `Readable.fromWeb` + `sseFrame` + its own `event: complete\|truncated\|error` frames (`server/routes/api/ai/ai.ts:180,522,561,584,634-643`). | Not the AG-UI contract. |
| GAP-3 | The client hand-rolls `fetch` + `parseSSEStream` + `streamAiChat` with flat messages (`app/utils/aiChat.ts:11-16,206,425`). | No `useChat`, no parts. |
| GAP-4 | `sessionId` is never framed as `threadId`; `runId` appears only on the terminal frame and is server-minted (`ai.ts:266,637`). | The AG-UI id pair must be established without handing id authority to the client. |
| GAP-5 | No `tools` anywhere: request schema, upstream body, model, client. | Tool calls are impossible. |
| GAP-6 | Reasoning is parsed client-side from `reasoning_content` only, rendered in a bespoke `<details>`, never modelled as a part, and there is no `reasoning` request option (`app/utils/aiChat.ts:152,184`; `ai.ts:530-534`). | Not the guide's model. |
| GAP-7 | No queue: a second send is hard-dropped (`AIChatPanel.tsx:249`) and a busy refusal clears the composer without restoring it (`AIChatPanel.tsx:269,272`). | Guide unimplemented; text-loss defect. |
| GAP-8 | The refusal/busy taxonomy is bespoke (`kind:"refusal"\|"busy"`, `ai.ts:222`) and must survive a transport that has no `event:` names. | A silent UX regression if it is not explicitly re-framed. |
| GAP-9 | The wire body becomes AG-UI (`messages: UIMessage[]`, `threadId`, `runId`), so `schema.ts`, `toUpstreamMessages`/`resolveUpstreamMessages`, `scope.ts` `promptText`, and the persistence path must all flatten parts→text. | Adopting parts is not "keep the rest" unless the three server call sites are updated. |
| GAP-10 | A stream that ends without `finish_reason` is reclassified from `truncated` to `RUN_ERROR: incomplete-stream`, and if persistence/lock-release hang off `onFinish` the row is lost and the lock is stranded to TTL. | Highest live-failure risk; breaks IS-2 and IS-9. |
| GAP-11 | Stateless requests lose their byte-identical passthrough once every response is wrapped in AG-UI frames; the guarantee is documented and tested (`aiStreaming.test.ts:677-733`). | Must be retired explicitly, not silently. |

**Must have**

- The TanStack AI server transport (`chat()` + `toServerSentEventsResponse`) with the
  grounding gate, in-flight lock, CSRF, persistence, and rate limits intact.
- `useChat` on the client as the frame source, with the store-backed transcript merge kept.
- Read-only server tool allowlist; `reasoning` passthrough; `whenBusy` queue.
- The four RPC endpoints unchanged in shape and behaviour.
- A verified W0 gate: deps `require`-able from the CJS build **and** a gateway
  `finish_reason` probe.
- Rewritten tests for every frame the transport now emits, plus new tests for tools,
  reasoning, and queue.

**Must NOT have** (guardrail — do not invent these)

- Subagents, `defineAgent`, `SUBAGENT_*` events, or `subagents:{}`.
- Resumable streams, `Last-Event-ID`, or a durability adapter.
- `@tanstack/ai-persistence` / `withPersistence`.
- Accepting client-supplied `tools` or spreading `forwardedProps`.
- Token-usage capture or persistence; a new `finishReason` column.
- A new DB column, a new migration, or a change to `ai_chat_*` table shape.
- `maxIterations`/`combineStrategies`/`toolCallBudget` tuning beyond TanStack defaults.
- Any change to the grading, editor, or unrelated Outline subsystems.

## Verification strategy

- **Test strategy: tests-after**, colocated `*.test.ts` next to source, matching the repo
  convention. New server tests that use `vi.mock`/`vi.resetModules` begin with
  `// @vitest-isolate true` as their first line (`vitest.config.ts:64-77`). New tests must
  live under `app/`, `shared/`, `server/`, or `plugins/` — no new top-level test tree
  (`vitest.config.ts:59-62,117-154`).
- **Order of verification** (from `AGENTS.md`): `yarn lint` → `yarn tsc --incremental false`
  → `yarn test <file>` → `yarn build:server`. A type error usually explains a test failure.
- **Every todo is agent-executable.** No acceptance criterion requires a human, a browser
  click, or a visual judgement. Anything a browser would prove is asserted at the DOM level
  (jsdom) or at the wire level (server test with a stubbed `fetch`).
- **Evidence paths.** Every QA scenario writes its raw output to
  `.omo/evidence/<todo>-<name>.txt` (e.g. `.omo/evidence/04-server-transport.txt`). The
  file must contain the exact command and its unedited output.
- **No `event:` names, no `[DONE]`.** No new or updated test may assert an SSE `event:`
  line or `data: [DONE]`; the AG-UI event name is the JSON `type` field.
- **Node `Readable` invariant.** Every `ai.chat` exit that assigns `ctx.body` must assign a
  node `Readable` (via `Readable.fromWeb`), never a bare web `ReadableStream`, because
  `server/routes/api/middlewares/apiResponse.ts:10-15` skips only `node:stream.Readable`,
  `readable-stream` `Readable`, and `Buffer`. A dedicated test asserts this.
- **Manual QA is a scripted curl**, not a human: an authenticated round trip against
  `POST /api/ai.chat` with a grounded prompt, asserting the frame sequence contains
  `RUN_STARTED` … `RUN_FINISHED`.

## Execution strategy

**Dependency matrix**

| Wave | Todos | Depends on | Parallel-safe |
|---|---|---|---|
| W0 Foundations | 1, 2, 3 | — | 1 then {2,3}; 2 and 3 in parallel |
| W1 Server transport | 4, 5, 6, 7, 8 | W0 all | 5 must follow 4; 6,7,8 may follow 4 in parallel |
| W2 Client transport | 9, 10, 11, 12 | W1 (frames frozen) | 9 then {10,11,12}; 11 and 12 in parallel |
| W3 Tools | 13, 14 | W1; 14 also needs W2 | sequential |
| W4 Reasoning | 15, 16 | W1; 16 also needs W2 | sequential |
| W5 Queue | 17, 18 | W2 | sequential |
| W6 Tests + docs | 19, 20, 21, 22 | W1–W5 | 19,20,21,22 in parallel |
| Final wave | F1–F4 | all | parallel |

**Freeze points.** W1 freezes the wire contract; W2 freezes the client transport; nothing
after W2 may change frame names. If a later todo needs a wire change, it must edit the W1
todos' acceptance criteria first and re-run F1.

**Worktree.** This is branch work: the executor should use a task-owned worktree
(`$ulw-execute --worktree <abs-path>`) and open the PR against `development`, not `main`
(`AGENTS.md` branch hierarchy `main → development → feature`).

**Commit discipline.** One conventional commit per todo with a scope, e.g.
`feat(ai-chat): pin @tanstack/ai deps and fix tsconfig resolution`. Husky is not installed,
so run `yarn lint`, `yarn format:check` on touched files, and `git status` manually before
each commit.

## Todos

- [x] 1. Pin the `@tanstack/ai*` dependencies and fix TypeScript resolution
  Add `@tanstack/ai`, `@tanstack/ai-client`, `@tanstack/ai-react`, `@tanstack/ai-openai`
  to `package.json`
  `dependencies` (alphabetically between `@simplewebauthn/server` and `@types/*`, joining
  the existing `@tanstack/*` block at `package.json:115-116`). Use exact pins (no caret) —
  this is the docs' own slice-2 instruction (`docs/AI-CHAT.md:588-590`) and the repo pins
  load-bearing deps exactly (e.g. `koa-router": "7.4.0"`). Inspect each installed package's
  `package.json` `exports`/`types`; if types resolve only via `exports` and
  `resolvePackageJsonExports: false` (`tsconfig.json:17`) blocks them, add `paths` entries
  mirroring the precedent at `tsconfig.json:39-40`. Run `yarn` to regenerate the v10
  lockfile.

  References: `package.json:1-5,6-42,115-116,390`; `tsconfig.json:15-17,32-41`;
  `yarn.lock:4-6`; precedent comment `tsconfig.json:37-38`; `docs/AI-CHAT.md:584-601`;
  `AGENTS.md` (dependency + pinning rules); library research notes on required peers
  (`@types/react >=18` is a non-optional peer of `@tanstack/ai-react`; `@mcp-ui/client` and
  `react-dom` are optional).

  Acceptance criteria:
  - `yarn` completes with lockfile v10 and no unresolved peer warnings other than the
    documented optional ones.
  - `package.json` contains the four packages with exact versions — `@tanstack/ai-client` is
    pinned directly because todo 9 uses `fetchServerSentEvents` and todo 10 uses `ChatClient`,
    both of which live in it; it is not left to hoisting.
  - `yarn tsc --incremental false` passes.
  - If `paths` entries were needed, they are present and carry a comment naming
    `resolvePackageJsonExports`, matching the `vite` precedent at `tsconfig.json:37-40`.

  QA — happy: `yarn tsc --incremental false; echo EXIT=$?` → `EXIT=0`; evidence
  `.omo/evidence/01-pins-tsc.txt`.
  QA — failure: temporarily remove one `paths` entry if added and confirm `yarn tsc` fails
  with a "cannot find module" error, then restore it; evidence
  `.omo/evidence/01-pins-tsc-red.txt`.

  Commit: `feat(ai-chat): pin @tanstack/ai deps and fix tsconfig resolution`

  Recommended task executor category: `quick` — mechanical dependency + config edit with a
  compile gate.

- [x] 2. Prove the packages load in the CommonJS server build
  This is the W0 gate that can kill the whole approach. `package.json` has no
  `type: module`, `.swcrc:31-33` emits CommonJS, and `build:server` (`package.json:10`) runs
  `node ./build.js`. Add a temporary server-side import of the adapters from
  `server/routes/api/ai/` behind no runtime branch (an import is enough), then run
  `yarn build:server` and boot the server long enough to confirm no `ERR_REQUIRE_ESM`.
  If the packages are ESM-only, replace the static import at the server boundary with a
  dynamic `await import()` and record the chosen mechanism in the plan's notes before
  removing the probe.

  References: `package.json:1-5,6-42,47-49`; `.swcrc:23-33`; `tsconfig.json:8,15-17`;
  `server/main.ts` and `server/index.ts` boot path; `AGENTS.md` ("`yarn build:server`
  required before `db:migrate`"; no `type: module`).

  Acceptance criteria:
  - `yarn build:server` exits 0 with the probe import present.
  - The compiled server boots (web service) with no `ERR_REQUIRE_ESM` / `require() of ES
    Module` error in its first 20 lines of output.
  - The probe import is removed before the todo closes, and the decision (static import vs
    dynamic `import()`) is written into the W1 todo references.

  QA — happy: `yarn build:server && node -e "require('./build/server/routes/api/ai/ai.js')"`
  → exits 0; evidence `.omo/evidence/02-cjs-boot.txt`.
  QA — failure: if boot throws `ERR_REQUIRE_ESM`, the run is recorded as a failure and a
  dynamic-`import()` variant is proven instead; evidence `.omo/evidence/02-cjs-boot-red.txt`.

  Commit: `chore(ai-chat): verify @tanstack/ai loads in the CommonJS server build`

  Recommended task executor category: `deep-low` — a hairy build/runtime interop question
  the worker can settle from the artefacts.

- [x] 3. Resolve the adapter invocation and probe the gateway `finish_reason`
  Two unknowns must be closed before W1. (a) The repo's endpoint is a pure Chat Completions
  proxy (`POST ${AI_CHAT_BASE_URL}/chat/completions`, `stream:true`, body
  `{model, stream, messages}` at `server/routes/api/ai/ai.ts:522-536`). `openaiText`
  targets the Responses API, so the adapter must be a Chat-Completions adapter with a
  custom base URL — `openaiCompatible` from `@tanstack/ai-openai/compatible`, or
  `openaiCompatibleText` / `createOpenaiChatCompletions`. Read the installed
  `.d.ts` files and write the exact invocation into `server/routes/api/ai/adapter.ts`
  (a new thin module exporting one factory that reads `env.AI_CHAT_BASE_URL`,
  `env.AI_CHAT_API_KEY`, `env.AI_CHAT_MODEL` and never exposes the key). (b) Probe the
  configured gateway with a raw `stream:true` request and record whether the final chunk
  carries a non-null `finish_reason` or a usage-only tail. Write the probe's raw last two
  chunks to evidence. If the gateway omits `finish_reason`, the W1 status mapping must treat
  that case as `truncated` (not `error`) and the lock must still release.

  References: `server/routes/api/ai/ai.ts:520-576,584-668,674-724`; `server/env.ts:357-395`;
  `server/routes/api/ai/schema.ts:8,14`; library research notes (adapter targets Responses
  vs Chat Completions; `ClientOptions` passthrough `baseURL`/`defaultHeaders`/`fetch`;
  Chat-Completions adapters require `finish_reason` or a usage-only tail else
  `RUN_ERROR: incomplete-stream` and no `onFinish`).

  Acceptance criteria:
  - `server/routes/api/ai/adapter.ts` exists, exports one factory, is JSDoc'd, and is the
    ONLY place the adapter is constructed.
  - The exact invocation used is quoted in the file's JSDoc.
  - `.omo/evidence/03-gateway-finish-reason.txt` contains the probe's final chunks verbatim
    and a one-line verdict: `finish_reason present` or `finish_reason absent`.
  - The same evidence records two further facts the W1 mapping depends on: (a) the adapter's
    `RUN_ERROR` code when the gateway sends no `finish_reason` (expected `incomplete-stream`,
    per the cited contract), and (b) the middleware/terminal ordering — whether an
    `onFinish`/`onError` hook completes before the SSE stream closes, proven with a minimal
    `chat()` + `toServerSentEventsResponse` spike that timestamps the DB commit against the
    stream close. If the ordering cannot be satisfied on that path, this todo records that the
    fallback is a manual `StreamProcessor` that withholds the terminal event until the row
    commits, and W1 todo 4 must implement the fallback.
  - No secret value (`AI_CHAT_API_KEY`) appears in the evidence file or the adapter module's
    exports.

  QA — happy: with `AI_CHAT_BASE_URL`/`AI_CHAT_MODEL` set, the probe returns a terminal
  chunk; evidence `.omo/evidence/03-gateway-finish-reason.txt`.
  QA — failure: with `AI_CHAT_MODEL` unset, the adapter factory throws/404s before any
  network call and the probe records "provider unconfigured"; evidence
  `.omo/evidence/03-gateway-unconfigured.txt`.

  Commit: `feat(ai-chat): add the TanStack AI adapter factory and probe the gateway`

  Recommended task executor category: `deep-high` — the adapter-selection decision cannot be
  settled from evidence alone (the guide says `openaiText`, the wire is Chat Completions) and
  the `incomplete-stream` risk is a contract question.

- [x] 4. Rewrite `POST /api/ai.chat` onto `chat()` + `toServerSentEventsResponse`
  Replace the hand-rolled proxying inside the handler with a TanStack run, while keeping
  every gate and lock in place and in order. Read the AG-UI body with
  `chatParamsFromRequestBody(ctx.request.body)` (NOT `chatParamsFromRequest`, which needs a
  Web `Request` — `koa-body` already parsed the body). Preserve, in this order: feature gate
  `assertAiChatEnabled` (`ai.ts:258`), `auth([APP])` + `ten-per-minute` + `validate`
  (`:251-256`), ownership (`findOwned`, `:275-281`), the Redis in-flight lock (`:294-353`),
  the user-turn write (`:408-419`), the grounding gate (`:451-486`), and the stateless
  branch (`:614-619`). Build the run with `chat({ adapter: adapterFactory(model), messages:
  resolvedMessages, threadId: sessionId, abortController: ac, tools, reasoning })`, then
  `const response = toServerSentEventsResponse(stream, { abortController: ac })`, copy its
  status and headers onto the Koa context, set `X-Accel-Buffering: no`, keep
  `ctx.compress = false` (`:434`) and `ctx.req.setTimeout(0)` (`:438`), and assign
  `ctx.body = Readable.fromWeb(response.body)`. Delete `sseFrame`, `refuseWithSseError`'s
  old shape use, `inspectChunk`, and the bespoke `finish()` frame authoring; the raw
  `fetch` to `/chat/completions` goes away. Wire the abort controller to
  `ctx.res.on("close")` exactly as today (`:504-513`).

  References: `server/routes/api/ai/ai.ts:1-28,171-256,258-266,275-353,355-430,434-438,
  504-513,520-576,584-745`; `server/routes/api/ai/index.ts:16-21`;
  `server/routes/api/index.ts:18,102`; `server/routes/api/middlewares/apiResponse.ts:6-22`;
  `server/routes/api/ai/adapter.ts` (todo 3); library research notes (Koa must use
  `chatParamsFromRequestBody`; no official Koa guide, `Readable.fromWeb` retained; frames
  carry no `event:` name and no `[DONE]`).

  Acceptance criteria:
  - No `fetch(` and no `sseFrame` remain in `server/routes/api/ai/ai.ts`.
  - The handler assigns `ctx.body` only via `Readable.fromWeb(...)`.
  - A grounded authenticated round trip emits an AG-UI frame sequence containing
    `RUN_STARTED` and `RUN_FINISHED` (the JSON `type` field), with no `event:` line and no
    `[DONE]`.
  - The feature-gate, CSRF, ownership, and rate-limit behaviours are unchanged
    (existing assertions still pass after their frame expectations are updated in todo 19).
  - `ctx.compress = false` and `ctx.req.setTimeout(0)` are still present.

  QA — happy: authenticated `curl -N` against a local server with a grounded prompt;
  evidence `.omo/evidence/04-server-transport.txt` shows the frame sequence.
  QA — failure: AMENDED during execution — `chat()` returns a lazy `AsyncIterable`, so the
  provider call fires on the first pull, i.e. AFTER the SSE response is already committed. A
  provider-down stub therefore yields `200 text/event-stream` ending in a terminal `RUN_ERROR`
  frame (not a JSON error body, and not a broken pipe). A JSON error is still returned for
  every pre-stream failure (feature gate 404, CSRF 403, ownership 404, unconfigured provider,
  invalid body). Evidence records the observed behaviour; rejection is covered by the
  `RUN_ERROR` terminal assertion.

  Commit: `feat(ai-chat): stream via TanStack chat() and toServerSentEventsResponse`

  Recommended task executor category: `deep-high` — a cross-boundary contract rewrite argued
  from the wire, the framework, and the lock/persistence invariants.

- [x] 5. Persist the assistant turn and release the lock on every terminal path
  The route no longer owns the provider bytes, so persistence moves into the TanStack run via
  middleware hooks. Add a middleware that accumulates the assistant text from text chunks and
  writes the assistant row through the existing `aiChatMessageCreator`
  (`server/commands/aiChatMessageCreator.ts:55-63`) with the server-minted `runId`. Release
  the in-flight lock after the row commits — and ALSO on `RUN_ERROR`, so a stream with no
  `finish_reason` cannot strand the key to TTL. Map the terminal outcome to the status enum:
  a clean terminal finish → `completed`; a stream that ends without a terminal event →
  `truncated` (preserve today's semantics, `ai.ts:718-724`); an abort → `aborted`; a
  provider failure → `error`. Never persist an empty assistant turn (`ai.ts:648-655`).
  Preserve "durable before end" (`docs/AI-CHAT.md:495-498`): the row must be committed before
  the response stream is allowed to complete.

  References: `server/routes/api/ai/ai.ts:209,294-353,365-400,596-668,710-745`;
  `server/commands/aiChatMessageCreator.ts:55-63,64-105`; `server/models/AIChatMessage.ts:16-33,50-87`;
  `server/presenters/aiChatSession.ts:31-40`; `docs/AI-CHAT.md:413-446,495-498`;
  `docs/AI-CHAT-DESIGN.md`; library research notes (consume chunks via middleware
  `onChunk`/`onFinish`/`onError` or `StreamProcessor`; `withPersistence` is NOT needed);
  todo 3's `finish_reason` verdict.

  Acceptance criteria:
  - A completed grounded turn writes exactly one assistant row with the same `runId` as its
    user row and `status = completed`.
  - A stream with no `finish_reason` maps to `status = truncated`. Because the adapter
    converts that case into `RUN_ERROR` with code `incomplete-stream` (per todo 3's contract),
    the mapping is implemented at the error layer: a `RUN_ERROR` whose code is
    `incomplete-stream` maps to `truncated`; every other `RUN_ERROR` maps to `error`. Both
    release the lock. A user abort maps to `aborted`, as today.
  - A provider failure writes `status = error` and releases the lock.
  - A client abort writes `status = aborted` and releases the lock.
  - An empty assistant turn writes no row.
  - The lock key `aiChat:inflight:<userId>:<sessionId>` is absent after every one of the
    above.

  QA — happy: `yarn test server/routes/api/ai/aiStreaming.test.ts` (updated) plus a real
  round trip asserting the row exists before the stream ends; evidence
  `.omo/evidence/05-persist.txt`.
  QA — failure: stub a stream that errors mid-flight; assert `status = error` and no lock
  key remains; evidence `.omo/evidence/05-persist-red.txt`.

  Commit: `feat(ai-chat): persist turns via chat middleware and release the lock on error`

  Recommended task executor category: `deep-high` — the persist/lock ordering invariant
  cannot be settled from the code alone.

- [x] 6. Frame the grounding refusal and the busy refusal as ordinary AG-UI turns
  Both refusals happen before a TanStack run exists, so they cannot use
  `toServerSentEventsResponse`. Hand-author the AG-UI text frames instead: emit
  `RUN_STARTED` → `TEXT_MESSAGE_START` → `TEXT_MESSAGE_CONTENT`(refusal text) →
  `TEXT_MESSAGE_END` → `RUN_FINISHED`, all under a real `runId`, and persist the assistant
  row with `status = completed` exactly as today (`ai.ts:451-486`). The refusal string must
  remain the inlined, contiguous literal so `i18next-parser` sees it and
  `server/routes/api/ai/ai.test.ts` keeps passing. Keep the turn persisted BEFORE the frame
  is written. The busy refusal (`:301-326`) gets the same synthetic-run treatment with the
  busy string, still before any provider call, still after the lock check. The response must
  still be a `200 text/event-stream` with a node `Readable` body.

  References: `server/routes/api/ai/ai.ts:222,238-249,294-326,451-486`;
  `server/routes/api/ai/scope.ts` (`OutOfScopeRefusal`, refusal reasons);
  `app/components/AIChat/AIChatPanel.tsx:307-326`; `ai.test.ts:332-374`;
  `aiStreaming.test.ts:431-452`; library research notes (no `event:` names; `useChat`
  surfaces failures as `RUN_ERROR`).

  Acceptance criteria:
  - A refused prompt returns `200 text/event-stream` whose frames form one complete AG-UI run
    carrying the refusal text.
  - The refusal is persisted as an assistant row with `status = completed`.
  - A second turn on a locked session returns the same synthetic-run shape carrying the busy
    text, and the first run is untouched.
  - No `event:` line is emitted on either path.
  - Each synthetic run carries a single, library-independent discriminator: the response
    header `X-AI-Chat-Kind: refusal|busy`, set on the hand-authored SSE response. A response
    header is chosen over an AG-UI `CUSTOM` event because it does not depend on the client
    library surfacing custom events — it is readable the moment the response arrives, before
    the body is consumed. No `CUSTOM` event is emitted. This header is the ONLY signal the
    client uses; the refusal text is never pattern-matched and the run id is never parsed.

  QA — happy: `curl -N` with an ungroundable prompt; evidence
  `.omo/evidence/06-refusal-frames.txt` shows the run and the persisted row.
  QA — failure: two concurrent turns on one session; the second observes the busy run and the
  first still completes; evidence `.omo/evidence/06-busy-red.txt`.

  Commit: `feat(ai-chat): frame refusal and busy as ordinary AG-UI turns`

  Recommended task executor category: `deep-high` — preserves a deliberate UX contract inside
  a protocol that has no equivalent, and touches the i18n extraction constraint.

- [x] 7. Keep stateless (`messages`-only) requests working without byte-identity
  A request with `messages` and no `sessionId` must still work and must still store nothing.
  Pass it through the same TanStack run with no `sessionId`/`threadId` persistence and no
  terminal-frame authoring — but note explicitly that the old byte-identical passthrough is
  retired (GAP-11). Flatten the incoming `UIMessage.parts` to text for the provider and for
  the grounding gate exactly as done for the session path (todo 4/5). Update the route's
  docblock so it no longer claims a byte-identical proxy.

  References: `server/routes/api/ai/ai.ts:614-619`;
  `server/routes/api/ai/schema.ts:33-60`; `aiStreaming.test.ts:677-733`;
  `docs/AI-CHAT.md:239-259,415-446,480-498`; decision D-stateless (keep working; retire
  byte-identity).

  Acceptance criteria:
  - A stateless request returns a valid AG-UI stream and writes zero rows.
  - No lock is taken for a stateless request (as today).
  - The route docblock and `docs/AI-CHAT.md` no longer assert byte-identity (doc edit lands
    in todo 21; the code comment is edited here).

  QA — happy: `curl -N` with a `messages`-only body; evidence
  `.omo/evidence/07-stateless.txt` shows frames and `SELECT count(*) = 0`.
  QA — failure: a stateless request with a `system` role is still rejected by the schema;
  evidence `.omo/evidence/07-stateless-red.txt`.

  Commit: `feat(ai-chat): keep stateless requests on the TanStack path`

  Recommended task executor category: `unspecified-low` — a contained branch plus a comment
  fix.

- [x] 8. Map parts to text at every server call site that expects a string
  Close GAP-9. The AG-UI body carries `messages: UIMessage[]`, but the provider, the
  grounding gate, and the DB column all want text. Add one shared helper (e.g.
  `server/routes/api/ai/messages.ts`) that flattens a `UIMessage` to its concatenated
  `text` parts, and use it in `toUpstreamMessages`/`resolveUpstreamMessages`
  (`ai.ts:106-121,145-169`), in the pending-turn extraction (`:406`), and in
  `findUngroundedReason`'s prompt-text reading (`scope.ts`). The stored
  `ai_chat_messages.content` remains the flattened string, so `presentAIChatMessage`
  (`server/presenters/aiChatSession.ts:31-40`) and the four RPC endpoints are unchanged.
  Re-assert the role allow-list after flattening.

  References: `server/routes/api/ai/ai.ts:38-121,145-169,406-430`;
  `server/routes/api/ai/scope.ts`; `server/routes/api/ai/schema.ts:26-31`;
  `server/models/AIChatMessage.ts:64-65`; `server/presenters/aiChatSession.ts:31-40`;
  `server/routes/api/ai/upstreamMessages.test.ts`.

  Acceptance criteria:
  - `toUpstreamMessages` accepts `UIMessage[]` and returns the same `{role, content}[]` shape
    as today for equivalent input.
  - A multi-part assistant message flattens to the concatenation of its text parts, in order.
  - A message with no text parts contributes an empty string and is not forwarded as a
    provider message with content.
  - `presentAIChatMessage` output is byte-for-byte unchanged for stored rows.
  - `AiChatSchema` accepts the AG-UI `messages` shape (`UIMessage[]` with `parts`) so
    `validate(T.AiChatSchema)` no longer rejects an AG-UI body, and still rejects a `system`
    role.

  QA — happy: `yarn test server/routes/api/ai/upstreamMessages.test.ts` with new parts
  fixtures; evidence `.omo/evidence/08-flatten.txt`.
  QA — failure: a `system` role inside AG-UI messages is dropped, not forwarded; evidence
  `.omo/evidence/08-flatten-red.txt`.

  Commit: `feat(ai-chat): flatten UIMessage parts to text at the server call sites`

  Recommended task executor category: `unspecified-high` — a multi-file pure-function change
  with a compatibility gate.

- [x] 9. Wire the client to a TanStack connection with the existing CSRF headers
  Replace the raw `fetch` in `app/utils/aiChat.ts` with a TanStack connection adapter
  supplied to `useChat`, reusing the exact header block that exists today
  (`app/utils/aiChat.ts:432-451`): `Content-Type`, `[CSRF.headerName]` (=
  `"x-csrf-token"`) from `getCSRFToken()` (`app/utils/csrf.ts:10-12`), `x-editor-version` =
  `EDITOR_VERSION`, and `credentials: "same-origin"`. Because the token must be read per
  request, use the function form of the connection's headers option. Send the session id so
  it maps to the server's `threadId`; do NOT send client-supplied tools; do NOT send
  `forwardedProps`. Keep the module's draft helpers (`aiChat.ts:541-649`) unchanged and
  exported. Also surface the `X-AI-Chat-Kind` response header (todo 6) through the connection:
  the library's own adapter does not hand response headers to callers, so capture it in a
  `fetchClient` fetch wrapper and expose the value to the taxonomy mapping.

  References: `app/utils/aiChat.ts:102-115,425-512,541-649`; `app/utils/csrf.ts:10-12`;
  `app/utils/ApiClient.ts:184-192,212-220`; `shared/constants.ts:50`;
  `app/components/AIChat/AIChatPanel.tsx:246-348`; library research notes
  (`fetchServerSentEvents(url, headersFnOrOptions)`; headers may be a function evaluated per
  request; the AG-UI body is sent).

  Acceptance criteria:
  - One connection factory exists in `app/utils/aiChat.ts` and is the only place the AI chat
    URL and the three headers are set.
  - A test asserts the outgoing request carries `x-csrf-token` equal to the cookie value and
    `x-editor-version`, read at call time (not captured at module load).
  - The connection never sends a `tools` field derived from client state.
  - The connection captures the `X-AI-Chat-Kind` response header from todo 6 (via the
    `fetchClient` wrapper) and exposes its value to the taxonomy mapping in todo 11. A test
    asserts a response carrying `X-AI-Chat-Kind: refusal` is observed as `refusal`, and that a
    response without the header is observed as `null` (a normal answer).
  - `yarn tsc --incremental false` passes.

  QA — happy: `yarn test app/utils/aiChat.test.ts` asserting headers and body; evidence
  `.omo/evidence/09-client-connection.txt`.
  QA — failure: with the CSRF cookie absent the request omits the header and the server's 403
  path is surfaced as an `http`-kind error; evidence
  `.omo/evidence/09-client-connection-red.txt`.

  Commit: `feat(ai-chat): connect the client through a TanStack transport with CSRF headers`

  Recommended task executor category: `visual-engineering` — frontend transport/UI plumbing.

- [x] 10. Run the panel's streaming turn through `useChat` while keeping the store merge
  Adopt `useChat` (or its headless `ChatClient`) as the frame source for the in-flight turn,
  but keep the panel's transcript as `storedTurns` (from `aiChatMessages.data`, sorted by
  `seq`) merged with the local pending turn — the decision D-transcript. Preserve: the
  `isStreaming` guard semantics, the Stop button (`AIChatPanel.tsx:220-223,502-510`), the
  abort-on-unmount (`:129-135`), the autoscroll, the Enter-to-send handler (`:368-376`), and
  the session-switch/new-chat resets (`:189-206`). The reasoning accumulator moves to a
  ThinkingPart-derived value (todo 16). Do NOT let `useChat` own the committed history.

  References: `app/components/AIChat/AIChatPanel.tsx:102-119,129-218,246-376,480-519`;
  `app/stores/AIChatMessagesStore.ts:43-91`; `app/stores/AIChatSessionsStore.ts:48-121`;
  `app/models/AIChatMessage.ts:12-65`; `app/utils/aiChat.ts:102-115`;
  `app/components/AIChat/AIChatPanel.test.tsx:326-479,596-770,835-955`.

  Acceptance criteria:
  - A streamed reply still renders incrementally and still marks `isStreaming`.
  - Stop still aborts and leaves no error banner.
  - Session switch and New chat still clear the pending turn and re-read the store rows.
  - The transcript for a reopened session is still driven by store rows, not `useChat`.
  - No test asserts the old `{messages:[{role,content}], sessionId}` body shape.

  QA — happy: `yarn test app/components/AIChat/AIChatPanel.test.tsx`; evidence
  `.omo/evidence/10-panel-stream.txt`.
  QA — failure: aborting mid-stream leaves the panel in a clean non-error state; evidence
  `.omo/evidence/10-panel-stream-red.txt`.

  Commit: `feat(ai-chat): stream the panel turn through useChat over the store transcript`

  Recommended task executor category: `visual-engineering` — a stateful React integration with
  layout/UX consequences.

- [x] 11. Preserve the eight-kind error taxonomy over AG-UI
  The panel's `errorText` (`AIChatPanel.tsx:54-91`) and the turn markers depend on
  `AiChatErrorKind` = `http | stream | refusal | busy | truncated | aborted | network |
  malformed` (`app/utils/aiChat.ts:47-63`). Map AG-UI/HTTP outcomes onto those kinds in one
  module: HTTP status → `http`; a synthetic refusal run → `refusal`; a synthetic busy run →
  `busy`; a terminal frame whose reason is absent → `truncated`; a user stop → `aborted`; a
  connection failure → `network`; an unparseable frame → `malformed`. Keep `AiChatError`
  (`aiChat.ts:123-143`) as the transport error type so the panel's `instanceof` branch
  (`:335-336`) still works.

  References: `app/utils/aiChat.ts:47-63,123-143,287-398`;
  `app/components/AIChat/AIChatPanel.tsx:54-91,307-341,539-556`;
  `app/components/AIChat/AIChatPanel.test.tsx:521-595`.

  Acceptance criteria:
  - Each of the eight kinds is reachable and asserted by at least one test. `refusal` and
    `busy` are derived from the `X-AI-Chat-Kind` response header (todo 6) as exposed by the
    connection factory (todo 9) — never inferred from the message text, the run id, or the
    absence of tool calls. With no header present the turn is a normal answer.
  - The refusal kind still renders inline (not in the error banner); the busy kind still
    renders as a retry-later notice.
  - `yarn test app/utils/aiChat.test.ts app/components/AIChat/AIChatPanel.test.tsx` passes.

  QA — happy: `yarn test` for the two files; evidence `.omo/evidence/11-taxonomy.txt`.
  QA — failure: an unparseable frame maps to `malformed` and never throws an unhandled
  rejection; evidence `.omo/evidence/11-taxonomy-red.txt`.

  Commit: `feat(ai-chat): map AG-UI outcomes onto the eight-kind error taxonomy`

  Recommended task executor category: `unspecified-high` — a multi-file mapping with
  behavioural equivalence.

- [x] 12. Keep drafts and session history intact under the new transport
  Verify and repair the interaction between the new transport and the localStorage draft
  helpers plus the history dropdown. The composer must still restore a draft per session, and
  deleting a session must still clear its draft (`AIChatHistory.tsx:80-102`). Record which
  state is React-local versus store-backed in a short comment block at the top of the panel
  so a future reader does not re-introduce the split-brain Metis flagged.

  References: `app/utils/aiChat.ts:541-649`;
  `app/components/AIChat/AIChatHistory.tsx:80-102,104-226`;
  `app/components/AIChat/AIChatPanel.tsx:129-164,189-206,350-361`;
  `app/components/AIChat/AIChatHistory.test.tsx:257-497`;
  `app/utils/aiChat.test.ts`.

  Acceptance criteria:
  - Draft write/read/clear round-trips for a session and for the pending key.
  - Deleting the active session clears its draft and starts a new chat.
  - A comment block at the top of `AIChatPanel.tsx` names the React-local state and the
    store-backed state explicitly.

  QA — happy: `yarn test app/components/AIChat/AIChatHistory.test.tsx app/utils/aiChat.test.ts`;
  evidence `.omo/evidence/12-drafts.txt`.
  QA — failure: a draft survives an abort (it is re-read on the next mount); evidence
  `.omo/evidence/12-drafts-red.txt`.

  Commit: `fix(ai-chat): preserve drafts and session history under the new transport`

  Recommended task executor category: `quick` — a contained verification plus a small fix.

- [x] 13. Add the read-only server tool allowlist
  Close GAP-5 and IS-4. Define the allowlist with `toolDefinition({...}).server(fn)` in one
  module (e.g. `server/routes/api/ai/tools.ts`), each tool JSDoc'd, each read-only, and pass
  them to `chat({ tools })` in the route. The tools must be static: never read tools from
  the request body, never spread `forwardedProps`, and never merge client-supplied tools
  (the security callout in the library research notes). Start with the smallest useful set —
  the grounding/KB search the workspace already exposes — rather than inventing new document
  writers. Keep the run's tool budget inside TanStack defaults (no `maxIterations` tuning).

  References: `server/routes/api/ai/ai.ts:251-256,425-436`;
  `server/routes/api/ai/scope.ts`; `server/models/Document.ts` and the existing search
  provider used by `scope.ts`; library research notes (`toolDefinition(...).server(fn)`,
  never merge `params.tools`); `docs/AI-CHAT.md`.

  Acceptance criteria:
  - `server/routes/api/ai/tools.ts` exports a frozen array of server tools, each with an
    `inputSchema` and a `.server()` implementation.
  - The route passes that array to `chat({ tools })` and passes nothing derived from the
    request.
  - A request body containing a `tools` field is ignored (asserted by a test).
  - No tool writes to a document, collection, or any table other than `ai_chat_*`.

  QA — happy: a prompt that requires the allowlisted tool produces `TOOL_CALL_*` frames and
  a final answer; evidence `.omo/evidence/13-tools.txt`.
  QA — failure: a request with an injected `tools` array does not add any tool to the run;
  evidence `.omo/evidence/13-tools-red.txt`.

  Commit: `feat(ai-chat): add the read-only server tool allowlist`

  Recommended task executor category: `unspecified-high` — a security-sensitive multi-file
  feature.

- [x] 14. Render tool calls from `UIMessage.parts`
  Render `tool-call` parts in the transcript: the tool name, its input, and its output, with
  a pending/complete state. Keep it read-only in appearance — no approval affordance (that is
  the deferred subagents/interrupts slice). Reuse the panel's existing styled-component
  conventions and the transcript turn wrapper. Reasoning and text parts continue to render as
  before.

  References: `app/components/AIChat/AIChatPanel.tsx:600-664` (render + styled patterns);
  `app/models/AIChatMessage.ts`; library research notes (`tool-call` parts carry
  `name`/`input`/`output`); `app/components/AIChat/AIChatPanel.test.tsx`.

  Acceptance criteria:
  - A tool call renders name + input + output; a still-running tool call renders a pending
    state.
  - A part type the panel does not know renders nothing (no crash).
  - `yarn test app/components/AIChat/AIChatPanel.test.tsx` passes.

  QA — happy: a fixture conversation with one tool call renders three fields; evidence
  `.omo/evidence/14-tool-parts.txt`.
  QA — failure: an unknown part type is ignored without error; evidence
  `.omo/evidence/14-tool-parts-red.txt`.

  Commit: `feat(ai-chat): render tool-call parts in the transcript`

  Recommended task executor category: `visual-engineering` — new UI rendering.

- [x] 15. Pass `reasoning` through and declare the model's capability
  Add a `reasoning` option to the run so thinking models stream thinking tokens. Because
  `openaiCompatible` reasoning support is undocumented and string-declared models get only
  optimistic defaults, declare the capability explicitly on the adapter model (or set
  `reasoning` only when configured) so a plain gateway is not sent an unsupported field.
  Gate it behind env/config rather than hard-coding `"high"`. Keep the request body free of
  any client-supplied reasoning level.

  References: `server/routes/api/ai/adapter.ts` (todo 3); `server/env.ts:357-395`;
  `server/routes/api/ai/ai.ts:425-436`; library research notes (`reasoning: "high"` →
  `reasoning_effort` on Chat Completions; levels; unknown models get optimistic defaults;
  `openaiCompatible` reasoning undocumented).

  Acceptance criteria:
  - When reasoning is unconfigured, the upstream body contains no reasoning field.
  - When configured, the field the adapter emits is captured in a test.
  - No client-supplied reasoning value reaches the adapter.
  - The response side is proven: a recorded provider chunk carrying `reasoning_content` (or the
    adapter's thinking event) surfaces as a `thinking` part. If the adapter does not surface it,
    this todo records the finding and IS-5 is re-scoped explicitly — it is never left silently
    unmet.

  QA — happy: a stubbed adapter boundary records the outgoing provider body with the expected
  reasoning field; evidence `.omo/evidence/15-reasoning.txt`.
  QA — failure: unconfigured reasoning → the body has no reasoning field; evidence
  `.omo/evidence/15-reasoning-red.txt`.

  Commit: `feat(ai-chat): pass reasoning through the adapter`

  Recommended task executor category: `deep-low` — an adapter-capability question the worker
  can settle from the installed types plus a probe.

- [x] 16. Render thinking as a collapsed, live-only disclosure
  Drive the existing collapsed `<details>` disclosure from `thinking` parts instead of the
  ad-hoc `{type:"reasoning"}` event, and preserve today's behaviour exactly: the disclosure
  shows only for the in-flight turn and disappears once the turn finalizes (the parts model
  would otherwise retain it, so the panel must filter it out on finalize). Never persist
  thinking; never let it enter the answer text.

  References: `app/components/AIChat/AIChatPanel.tsx:112-115,292-295,437-449,646-664`;
  `app/utils/aiChat.ts:36-41,181-187`; `app/components/AIChat/AIChatPanel.test.tsx:396-432`;
  `docs/AI-CHAT.md:514-519`; decision D-reasoning (live-only).

  Acceptance criteria:
  - Thinking renders in a collapsed disclosure while streaming.
  - After the turn completes, no thinking disclosure remains in the transcript.
  - Thinking text never appears in the assistant answer text or in a stored row.

  QA — happy: `yarn test app/components/AIChat/AIChatPanel.test.tsx`; evidence
  `.omo/evidence/16-thinking.txt`.
  QA — failure: a model with empty thinking parts renders no empty disclosure; evidence
  `.omo/evidence/16-thinking-red.txt`.

  Commit: `feat(ai-chat): render thinking parts as a live-only disclosure`

  Recommended task executor category: `visual-engineering` — a UI behaviour with a strict
  invariant.

- [x] 17. Add the `whenBusy` message queue
  Give the composer the guide's queue semantics: a `queue` option with `whenBusy`
  (`"queue"` default, `"drop"`, `"interrupt"`), a pending-queue render distinct from the
  transcript, and a per-item cancel. Replace the hard `if (!content || isStreaming) return;`
  guard (`AIChatPanel.tsx:249`) with that policy. Keep the "one turn in flight per session"
  server lock as the backstop (todo 18).

  References: `app/components/AIChat/AIChatPanel.tsx:106-119,246-272,480-519`;
  `app/utils/aiChat.ts:102-115`; library research notes (`queue:{whenBusy,drain,maxSize,
  onOverflow}`, `cancelQueued(id)`, drains only after a successful settle, flushes on
  error/abort).

  Acceptance criteria:
  - A send while streaming is queued by default and sends after the first turn settles.
  - `whenBusy: "drop"` ignores the send without adding it to the queue.
  - `whenBusy: "interrupt"` aborts the current turn and sends the new message.
  - `cancelQueued(id)` removes a waiting item.
  - The queue never merges into the persisted transcript.

  QA — happy: `yarn test app/components/AIChat/AIChatPanel.test.tsx` with queue cases;
  evidence `.omo/evidence/17-queue.txt`.
  QA — failure: aborting the active turn flushes (does not send) the queue; evidence
  `.omo/evidence/17-queue-red.txt`.

  Commit: `feat(ai-chat): add the whenBusy message queue`

  Recommended task executor category: `visual-engineering` — stateful composer UX.

- [x] 18. Make the busy refusal non-destructive and keep the lock justified
  Close GAP-7 and IS-9. On a busy refusal, restore the typed text into the composer (today it
  is cleared before the request at `AIChatPanel.tsx:269,272`) instead of leaving the user with
  an empty box. On the server, release the in-flight lock on `RUN_ERROR` as well as on
  finish, and raise/justify the 300s TTL (`ai.ts:209`) against a multi-round-trip tool run —
  record the chosen TTL and its rationale in a comment. The lock remains per
  `(user, session)`.

  References: `server/routes/api/ai/ai.ts:196-209,294-353,612-668`;
  `app/components/AIChat/AIChatPanel.tsx:78-91,269-272,335-341`;
  `app/stores/AIChatMessagesStore.ts`; `docs/AI-CHAT.md:538-540`.

  Acceptance criteria:
  - A busy refusal leaves the typed text in the composer, ready to retry.
  - The lock is released on finish, on error, on abort, and on the refusal path.
  - The TTL constant carries a comment citing the tool-loop worst case.
  - A test asserts no lock key survives any of the four exits.

  QA — happy: `yarn test server/routes/api/ai/aiInFlightCap.test.ts` after updating it;
  evidence `.omo/evidence/18-busy.txt`.
  QA — failure: two concurrent turns from different tabs → the second gets the busy run and
  the first still completes; evidence `.omo/evidence/18-busy-red.txt`.

  Commit: `fix(ai-chat): restore composer text on a busy refusal and release the lock on error`

  Recommended task executor category: `unspecified-high` — server invariant + client UX in one
  change.

- [x] 19. Rewrite the server tests for the AG-UI frame contract
  Enumerate and update every server test that pins the old frames. The known set:
  `server/routes/api/ai/aiStreaming.test.ts:408,410,595,600,631,668`,
  `aiInFlightCap.test.ts:331-343`, `ai.test.ts:332-374`,
  `upstreamMessages.test.ts:383,425,453`, `aiSessions.test.ts:554`. Replace every `event:`
  and `data: [DONE]` assertion with the AG-UI JSON `type` assertions. Keep the fake-upstream
  harness pattern (`vi.stubGlobal("fetch", …)` returning `new Response(new ReadableStream…)`)
  but feed it a Chat-Completions chunk shape the adapter accepts, and add the missing
  `finish_reason` where the old fixtures omitted it (per todo 3's verdict). Add the node
  `Readable` invariant test from the verification strategy.

  References: `server/routes/api/ai/ai.test.ts`, `aiStreaming.test.ts`,
  `aiInFlightCap.test.ts`, `upstreamMessages.test.ts`, `aiSessions.test.ts`, `schema.test.ts`;
  `vitest.config.ts:59-77`; todo 3's evidence file.

  Acceptance criteria:
  - `grep -rn "event: \|\[DONE\]" server/routes/api/ai/*.test.ts` returns nothing.
  - `yarn test:server` passes.
  - A test asserts that no `ai.chat` exit assigns a web `ReadableStream` to `ctx.body`.
  - A test asserts the negative path: a stubbed stream that ends with no `finish_reason` yields
    `RUN_ERROR` with code `incomplete-stream`, which maps to `status = truncated` and releases
    the lock — proving the todo 5 mapping, not only the happy path.
  - A contract test replays the real gateway bytes captured in
    `.omo/evidence/03-gateway-finish-reason.txt` through `chat()` + the adapter. Its assertion
    follows todo 3's verdict explicitly, both ways: when the verdict is `finish_reason
    present`, it asserts a `RUN_FINISHED`; when the verdict is `finish_reason absent`, it
    asserts a `RUN_ERROR: incomplete-stream` mapping to `truncated`. Either way the fixture is
    the gateway's own output, not a hand-written chunk, so the suite cannot pass on the plan's
    own assumptions.

  QA — happy: `yarn test:server`; evidence `.omo/evidence/19-server-tests.txt`.
  QA — failure: reintroduce one `event:` assertion and confirm the suite fails, then remove
  it; evidence `.omo/evidence/19-server-tests-red.txt`.

  Commit: `test(ai-chat): assert the AG-UI frame contract on the server`

  Recommended task executor category: `unspecified-high` — a broad but mechanical test
  rewrite across five files.

- [x] 20. Rewrite the client tests for the new transport and parts
  Update `app/utils/aiChat.test.ts` (headers, body, error kinds, drafts) and
  `app/components/AIChat/AIChatPanel.test.tsx` (mock surface, body assertions at
  `:859-918`, streaming, Stop, reasoning disclosure, refusal inline, turn markers), plus
  `AIChatHistory.test.tsx` and the store tests where they reference frames. Ensure no client
  test asserts the old wire body or the old `event:`/`[DONE]` frames.

  References: `app/utils/aiChat.test.ts`, `app/components/AIChat/AIChatPanel.test.tsx`,
  `AIChatHistory.test.tsx`, `AIChatContext.test.tsx`, `AIChatTrigger.test.tsx`,
  `app/stores/AIChatSessionsStore.test.ts`, `app/stores/AIChatMessagesStore.test.ts`;
  `vitest.config.ts:117-130`.

  Acceptance criteria:
  - `yarn test:app` passes.
  - No client test asserts `event:` names, `[DONE]`, or the
    `{messages:[{role,content}],sessionId}` body.
  - Tools, reasoning, and queue each have at least one test.

  QA — happy: `yarn test:app`; evidence `.omo/evidence/20-app-tests.txt`.
  QA — failure: delete one queue assertion and confirm the suite fails, then restore it;
  evidence `.omo/evidence/20-app-tests-red.txt`.

  Commit: `test(ai-chat): assert the new client transport, parts, and queue`

  Recommended task executor category: `unspecified-high` — broad test rewrite.

- [x] 21. Update the AI chat documentation
  Update `docs/AI-CHAT.md` and `docs/AI-CHAT-DESIGN.md` so they describe the TanStack
  transport: how to run the spike, the frame contract (AG-UI, no `event:` names, no
  `[DONE]`), the tools/reasoning/queue surfaces, the retirement of the byte-identical
  stateless guarantee, the lock TTL rationale, and the `chatParamsFromRequestBody` note for
  the fork's Koa route. Remove or correct every curl recipe that asserts the old frames, and
  update the slice-2 section to say "implemented" with the deferred list intact.

  References: `docs/AI-CHAT.md:1-21,115-148,150-259,413-446,480-601`;
  `docs/AI-CHAT-DESIGN.md`; `AGENTS.md` (docs pointers).

  Acceptance criteria:
  - No doc asserts `event: complete|truncated|error`, `data: [DONE]`, or byte-identity.
  - The slice-2 section names what shipped and what is still deferred (subagents, resumable
    streams, TanStack persistence, client tools, token usage).
  - Every curl recipe runs against a local server as written (verified for at least one).

  QA — happy: run the streaming curl recipe verbatim against a local dev server; evidence
  `.omo/evidence/21-docs.txt`.
  QA — failure: grep the two docs for the retired claims and confirm zero hits; evidence
  `.omo/evidence/21-docs-red.txt`.

  Commit: `docs(ai-chat): document the TanStack AI transport and slice-2 boundary`

  Recommended task executor category: `writing` — documentation.

- [x] 22. Extract the new user-facing strings
  Extract any new user-facing copy (queue labels, busy retry text, tool-call states,
  reasoning disclosure) so the translation catalogue is complete. Note that
  `yarn build:i18n` fails on Windows (`AGENTS.md`), so run the extraction deliberately and
  revert `shared/i18n/locales/en_US/translation.json` if the diff is CRLF-only churn.

  References: `AGENTS.md` (i18n section, Windows failure); `shared/i18n/locales/`;
  `app/components/AIChat/AIChatPanel.tsx` (new copy); `docs/AI-CHAT.md`.

  Acceptance criteria:
  - Every new English string added by W3–W5 appears in the extracted catalogue.
  - `git status` shows no unintended CRLF churn in `translation.json`.
  - `yarn tsc --incremental false` still passes.

  QA — happy: the new strings appear in the catalogue; evidence
  `.omo/evidence/22-i18n.txt`.
  QA — failure: revert the locale file when the change is CRLF-only and confirm `git status`
  is clean; evidence `.omo/evidence/22-i18n-red.txt`.

  Commit: `chore(ai-chat): extract the new user-facing strings`

  Recommended task executor category: `quick` — a mechanical extraction step.

- [x] 23. Accept the AG-UI `threadId` as the persisted session id (discovered in W1; run BEFORE todo 9)
  `@tanstack/ai-client` sends an AG-UI `RunAgentInput` whose only session identifier is
  `threadId`; the route today reads only `body.sessionId`, so a resumed session addressed by an
  AG-UI client would silently start a stateless chat. Resolve the session as
  `body.sessionId ?? body.threadId` (both uuid), keep `sessionId` working for legacy RPC
  callers, and keep a request with neither field stateless (stores nothing, takes no lock).
  Add `threadId` as an optional uuid on the schema body.

  Acceptance criteria:
  - A body carrying ONLY `threadId` appends both rows to that session and takes the in-flight
    lock, and `chat({ threadId: <session id> })` is fed that same session.
  - A foreign or unknown `threadId` → 404 with no rows written and no lock taken.
  - A body with neither `sessionId` nor `threadId` still stores nothing.
  - `sessionId` continues to work unchanged.

  QA — happy: `yarn test server/routes/api/ai/aiStreaming.test.ts`; evidence
  `.omo/evidence/23-threadid.txt`. QA — failure: a foreign `threadId` → 404, zero rows, no lock;
  evidence `.omo/evidence/23-threadid-red.txt`.

  Commit: `fix(ai-chat): accept the AG-UI threadId as the persisted session id`

  Recommended task executor category: `unspecified-high` — a contained server contract fix.

- [~] 24. Replay the LIVE gateway bytes through `chat()` + the adapter (opened by F1, FAIL-1)
  BLOCKED: the Hermes gateway at `127.0.0.1:8642` refuses every connection
  (`ECONNREFUSED`, recorded in `.omo/evidence/03-gateway-finish-reason.txt` §1), so no live
  Chat-Completions chunks exist on this host. Todo 19's contract test replays a stub-produced
  sequence that matches the wire shape and the todo 3 verdict; its comments were corrected to say
  so, but the plan's "the fixture is the gateway's own output" criterion stays unmet.

  Unblocks when: an operator starts Hermes and `AI_CHAT_BASE_URL` answers 200.
  Acceptance: capture the real 200 stream verbatim to `.omo/evidence/24-live-gateway.txt`, replay
  those bytes through `chat()` + `openaiCompatibleText`, and re-derive the `finish_reason` verdict
  from them (asserting `RUN_FINISHED` or `RUN_ERROR: incomplete-stream` accordingly).

- [x] 25. Re-scope IS-7's gate to the truth, and complete the evidence set (opened by F4)
  RESOLVED: IS-7 and its evidence row now name the pre-existing Windows baseline (26 failures / 9
  files, reproduced at base `9253e4f6d`) instead of claiming `yarn test:server` passes, and
  `01-pins-tsc.txt`, `02-cjs-boot.txt`, `20-app-tests.txt` are mirrored into the worktree evidence
  dir (51 files, verified). No code change was warranted: the failures are outside the AI surface
  and predate the branch.
  `yarn test:server` exits 1 at this tip with 26 failures in 9 files, ALL outside the AI surface
  (cron period parsing, storage `files.get`, `documents.export`, `revisions.export`,
  `MarkdownAPIImport`, `documentImporter`, PDF converter). The same failures reproduce at base
  `9253e4f6d`, so they are a pre-existing Windows baseline, not a regression of this branch.
  IS-7 nevertheless claims the command "passes". Either the claim is corrected to name the
  baseline, or the baseline is fixed — do not leave the plan asserting a false gate.
  Also: `01-pins-tsc.txt`, `02-cjs-boot.txt`, `20-app-tests.txt` exist only in the canonical
  evidence dir; mirror them into the worktree's.

- [x] 26. Release the in-flight lock on every pre-stream throw (opened by F2 D1 / F4 IS-9)
  RESOLVED in `c5a487867`: everything after acquisition is wrapped in `try/finally` guarded by
  `streamHandedOff`; the release now happens on every exit before the stream exists (refusal, DB
  rejection, grounding, loader rejection, error) and never after handoff, where the terminal hooks
  own it. The redundant explicit releases inside the refusal path and the stream-creation catch were
  removed, so release has one owner per phase. Tests: "releases the lock when reading the committed
  window throws before the stream exists" and "…when the engine loader rejects before the stream
  exists" — both red (500 + key still set) before the fix, both assert `KEYS aiChat:inflight:*`
  empty after it. Evidence `.omo/evidence/26-lock-prestream.txt` (both dirs).
  After the Redis lock is taken (`ai.ts` ~:365-394) the handler has NO outer try/finally. The awaits
  at `appendTurn` (~:444), `resolveUpstreamMessages` (~:460-465), the grounding probe (~:488) and
  `Promise.all([loadTanstack(), loadServerTools()])` (~:557-560) sit outside the guarded block, so
  a rejection there returns JSON 500 and strands `aiChat:inflight:<user>:<session>` for the full
  900s TTL — every later turn on that session is refused busy. Release exactly once and
  idempotently on every path after acquisition, and add a test that forces a pre-stream rejection
  (e.g. a failing loader or `resolveUpstreamMessages`) and asserts
  `KEYS aiChat:inflight:*` is empty.

- [x] 27. Do not send an assistant-last pending turn twice upstream (opened by F2 D2)
  RESOLVED in `c5a487867`: `toUpstreamMessages` drops a pending assistant turn that the committed
  window already ends with (same role and content), so a regeneration sends the answer once; a user
  turn that was not persisted still appends. Proof at the stub boundary:
  "sends an assistant-last regeneration turn upstream exactly once" (red before the fix — the
  provider saw the assistant message twice) plus a resolver unit test. Evidence
  `.omo/evidence/27-assistant-dup.txt` (both dirs).
  `ai.ts` ~:435 sets `pendingTurn` from `messages.at(-1)` and ~:460-465 passes it whenever the role
  is not `user`. For an OWNED session the stored window already ends with that assistant row (the
  regeneration case), so the provider receives the same assistant message twice. The user-turn case
  is guarded and tested; the assistant case is neither. Guard it (never re-send an assistant turn
  the committed window already contains) and assert at the stub boundary that the provider sees the
  assistant message exactly once.

- [x] 28. Keep the streamed turn visible when the post-stream re-read fails (opened by F2 D3)
  RESOLVED in `f75f642de`: `setPending([])` moved inside the `list()` success branch, so a rejected
  re-read keeps the local turn until a later successful refresh replaces it. Two panel tests: "keeps
  the streamed turn when the history re-read fails" (red before) and "clears the local turn once the
  history re-read succeeds". Verified: `app/components/AIChat` 59/59, full `yarn test:app` 358/358,
  `yarn tsc --incremental false` EXIT=0. Evidence `.omo/evidence/28-panel-reread.txt` (both dirs).
  `app/components/AIChat/AIChatPanel.tsx` ~:593-600: `aiChatMessages.list({ sessionId })` swallows
  its rejection (`.then(() => undefined, () => undefined)`) and `setPending([])` then runs
  unconditionally, so a failed re-read drops the turn the user just watched stream in — the answer
  vanishes from the transcript even though the server committed it. Clear the local turn only when
  the re-read actually replaced it. Add a panel test: `list()` rejects → the streamed turn is still
  rendered and pending is not cleared; then a successful list clears it.

## Final verification wave

Runs after ALL todos. F1 must pass before F2–F4 are meaningful.

- [x] F1. Plan compliance audit (adversarial)
  Re-read this plan and the repo, and verify every Must-have is present and every Must-NOT-has
  is absent. Specifically grep for: `subagent`/`defineAgent`/`withPersistence`/`resumable`,
  a new migration or a changed `ai_chat_*` column, token-usage capture, a bare web
  `ReadableStream` assigned to `ctx.body`, and any surviving `event:` or `[DONE]` assertion.
  Verify `git diff --stat` touches only the AI chat surface plus the listed config files.
  Report each Must item as PASS/FAIL with the command and output as evidence.

  Acceptance: every Must-have PASS, every Must-NOT-have absent, or the plan is rejected and a
  new `- [ ] N.` row is opened for each shortfall.

  Recommended task executor category: `unspecified-high` — verifier lane, no product code.

- [x] F2. Code-quality review
  APPROVED round 2 at `c5a487867`: D1 (pre-stream lock leak) and D2 (duplicate assistant turn) both
  verified fixed by re-reading the code and the tests, 161/161 AI tests, tsc 0. One residual note
  (D3, panel drops the streamed turn when the post-stream re-read fails) became row 28 rather than a
  silent omission. Verdict in `.omo/evidence/F2-code-quality.txt`.
  Review the changed files against the repo conventions in `AGENTS.md` and the subdirectory
  guides: JSDoc on every export, named exports, no `any`, curly braces on every `if`, early
  returns, members ordered, styled-components, no new files outside the AI chat surface,
  `ponytail:` comments naming any deliberate ceiling. Confirm the `Command`/
  `server/commands` and `models` conventions were respected (ctx-threaded writes, events).

  Acceptance: zero convention violations, or each is filed as a new todo row.

  Recommended task executor category: `unspecified-high` — verifier lane, no product code.

- [~] F3. Real manual QA (scripted)
  BLOCKED IN PART: steps 2 (grounding refusal inline + persisted), 3 (busy semantics) and 6
  (session delete clears the draft) PASS and are recorded in `.omo/evidence/F3-manual-qa.txt`.
  Steps 1 (grounded frame sequence), 4 (allowlisted tool renders) and 5 (queue while streaming,
  end to end) are BLOCKED by the same root cause: nothing listens on `127.0.0.1:8642`, so no model
  tokens, grounded answer or model-selected tool call can be produced. Client-level queue behaviour
  is independently green (todo 17). Those three steps must be re-run when the gateway is restored —
  tracked as row 24. Do NOT record them as passed and do NOT substitute fabricated transcripts.
  Against a local dev server with a configured gateway: (1) run a grounded prompt and capture
  the full frame sequence; (2) run an ungroundable prompt and confirm the refusal arrives
  inline and is persisted; (3) start a second turn on the same session and confirm the busy
  behaviour; (4) ask a prompt that triggers the allowlisted tool and confirm the tool renders;
  (5) exercise the queue by sending while streaming; (6) delete a session and confirm its
  draft is cleared. Assert the DB rows and the lock key state after each step.

  Acceptance: every step's expected outcome observed and recorded to
  `.omo/evidence/F3-manual-qa.txt`.

  Recommended task executor category: `unspecified-high` — verifier lane, no product code.

- [x] F4. Ideal-state fidelity, 1:1 against every IS row
  APPROVED round 2 at `c5a487867`: IS-7's gate now names the pre-existing Windows `test:server`
  baseline instead of claiming a pass, IS-9's "cannot strand the lock" is true and covered by two
  red-before/green-after tests, and IS-1…IS-9 each have a proof. Live-gateway halves remain tracked
  by row 24 (`[~]`). Verdict in `.omo/evidence/F4-ideal-state.txt`.
  Walk IS-1 … IS-9 and produce one line per row naming the delivering todo(s), the exact QA
  command, and the evidence file that proves it. Any IS row without a passing proof becomes a
  new `- [ ] N.` implementation row — never a note.

  Acceptance: every IS row has a passing proof; shortfalls re-opened as todos.

  Recommended task executor category: `unspecified-high` — verifier lane, no product code.

## Commit strategy

- One conventional commit per todo, scoped `(ai-chat)`, e.g.
  `feat(ai-chat): stream via TanStack chat() and toServerSentEventsResponse`.
- Branch off `development`; open the PR against `development` (`AGENTS.md` branch hierarchy).
  Never target `main`.
- Husky is not installed, so run before every commit: `yarn lint` on touched files,
  `yarn format:check` on touched files (bare `yarn format` rewrites the repo — do not run it),
  and `git status` to confirm no unintended locale churn.
- Order within a wave matters: W0 commits land before W1, and the two spikes (todos 2, 3)
  must be green before todo 4 begins. If a spike fails, stop and re-plan — do not carry a
  broken assumption into the rewrite.
- The two W0 spikes are reported in their commit bodies with the raw evidence path, so a
  reviewer can audit the `ERR_REQUIRE_ESM` and `finish_reason` conclusions without re-running
  them.
- Final wave F1–F4 produce no product commits; their evidence files are attached to the PR
  description.

## Success criteria

| IS row | Delivered by | Proving QA scenario | Evidence path |
|---|---|---|---|
| IS-1 TanStack/AG-UI stream contract on the chat path | 3, 4, 19 | authenticated `curl -N` shows an AG-UI run (no `event:` line, no `[DONE]`); `grep -n "sseFrame\|fetch(" server/routes/api/ai/ai.ts` is empty | `.omo/evidence/04-server-transport.txt` |
| IS-2 all existing behaviours survive | 4, 5, 6, 7, 18, 19 | feature-gate 404, CSRF 403, ownership 404, grounding refusal inline + persisted `completed`, one-turn-in-flight, four RPC endpoints, status enum — each asserted by its updated test in `yarn test:server` | `.omo/evidence/19-server-tests.txt` |
| IS-3 client uses `UIMessage.parts`; stored transcript stays flat | 8, 10, 20 | a multi-part assistant message renders from parts while `presentAIChatMessage` output is unchanged; `yarn test:app` | `.omo/evidence/20-app-tests.txt` |
| IS-4 read-only server tools end-to-end; client tools never accepted | 13, 14, 20 | tool-triggering prompt yields `TOOL_CALL_*` frames + rendered card; injected client `tools` are ignored | `.omo/evidence/13-tools.txt`, `.omo/evidence/13-tools-red.txt` |
| IS-5 `reasoning` passthrough → collapsed live-only ThinkingPart | 15, 16, 20 | disclosure appears while streaming and is gone after finalize; no reasoning in the answer text or any row | `.omo/evidence/16-thinking.txt` |
| IS-6 `whenBusy` queue; no silent text loss | 17, 18, 20 | queue/drop/interrupt cases pass; a busy refusal leaves the composer populated | `.omo/evidence/17-queue.txt`, `.omo/evidence/18-busy.txt` |
| IS-7 lint + tsc + build:server + test:app exit 0; test:server shows no new failure over the pre-existing Windows baseline | 1, 2, 19, 20, 22 | `lint`, `tsc --incremental false`, `build:server`, `test:app` each exit 0; `test:server` = 3842 passed / 26 failed, the 26 pre-existing and outside the AI surface (same set at base `9253e4f6d`); AI suites 156/156 | `.omo/evidence/01-pins-tsc.txt`, `.omo/evidence/02-cjs-boot.txt`, `.omo/evidence/19-server-tests.txt`, `.omo/evidence/20-app-tests.txt` (all four mirrored into the worktree) |
| IS-8 stateless requests still work and store nothing | 7, 19 | `messages`-only `curl` returns a run and leaves zero rows; no lock key | `.omo/evidence/07-stateless.txt` |
| IS-9 tool runs cannot strand the lock; TTL justified | 5, 18, 19 | no lock key survives finish/error/abort/refusal; TTL comment cites the tool-loop worst case | `.omo/evidence/18-busy.txt`, `.omo/evidence/05-persist-red.txt` |
