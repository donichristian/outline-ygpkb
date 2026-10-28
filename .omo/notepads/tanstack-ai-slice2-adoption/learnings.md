# Learnings â€” tanstack-ai-slice2-adoption

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /ulw-execute. Append new entries below - never overwrite._

---

## Todo 1 - Pin @tanstack/ai* deps and fix TypeScript resolution (commit fe7f814af)

Chosen exact pins (npm `dist-tags.latest`, all published 2026-10-13, pass 3-day npmMinimalAgeGate):
- @tanstack/ai        0.69.0
- @tanstack/ai-client 0.39.3
- @tanstack/ai-openai 0.30.0
- @tanstack/ai-react  0.30.4

Mutual compatibility verified: ai-client 0.39.3, ai-openai 0.30.0, ai-react 0.30.4 all peer-require `@tanstack/ai ^0.69.0`. ai-react also non-optional peers `react>=18`, `@types/react>=18` (repo has React 19 + @types/react); `@mcp-ui/client ^7` and `react-dom` peers are optional. No extra deps added.

paths entry needed? YES - exactly one. `resolvePackageJsonExports:false` (tsconfig.json:17) only breaks SUBPATH imports. Every package declares a top-level `"types"` field, so ROOT imports of `@tanstack/ai`, `@tanstack/ai-client`, `@tanstack/ai-react`, `@tanstack/ai-openai` resolve fine WITHOUT a paths entry (proved with a temp probe file: roots compiled clean, only subpaths errored TS2307). Slice 2 uses ONE subpath: `@tanstack/ai-openai/compatible` -> added paths entry `./node_modules/@tanstack/ai-openai/dist/esm/compatible/index.d.ts` (comment names resolvePackageJsonExports, mirrors vite precedent tsconfig.json:37-40). Verified load-bearing: removing it makes tsc fail TS2307 "Cannot find module '@tanstack/ai-openai/compatible'". Evidence: .omo/evidence/01-pins-tsc.txt (EXIT=0) + 01-pins-tsc-red.txt.

Entry-point names observed in installed exports maps (feeds todos 3,4,9,10):
- openaiCompatible / openaiCompatibleText -> `@tanstack/ai-openai/compatible` (exports "./compatible" -> ./dist/esm/compatible/index.d.ts). This is the Chat-Completions adapter todo 3 needs; root `@tanstack/ai-openai` also re-exports root index but compatible lives on the subpath.
- `chatParamsFromRequestBody`, `chat`, `toServerSentEventsResponse`, `mergeAgentTools` -> `@tanstack/ai` ROOT (./dist/esm/index.d.ts). Todo 4 imports these from the root, no paths entry needed.
- `@tanstack/ai/client` (core "./client" subpath) exports client-side helpers: `generationParamsFromBody`, `toolDefinition`, `hashSchemaInput`, `StreamProcessor`, `uiMessagesToWire`, `normalizeStreamChunk`, `getChunkRunId`/`getChunkThreadId`. Not currently imported by the plan (would need its own paths entry if ever used).
- Headless `ChatClient` / `fetchServerSentEvents` (todos 9/10) live in `@tanstack/ai-client` ROOT (./dist/esm/index.d.ts) -> no paths entry.
- `useChat` -> `@tanstack/ai-react` ROOT -> no paths entry.

Peer warnings after `yarn`: only pre-existing documented ones (katex vs @benrbray/prosemirror-math, react 19.3.0 vs outline-icons, react-dom 19.3.0 vs oy-vey). No new unresolved peers from the four packages.

## Todo 3 â€” adapter + gateway probe

- `openaiCompatibleText` defaults `api` to `"chat-completions"` at runtime (compatible/index.js:48), but its *declared* return type is still `OpenAICompatibleResponsesAdapter | OpenAICompatibleChatAdapter`; set `api` explicitly and type the factory with `ReturnType<typeof openaiCompatibleText>`.
- The OpenAI SDK appends `/chat/completions` to `baseURL`. `AI_CHAT_BASE_URL` already ends in `/v1` (`.env.local`: `http://127.0.0.1:8642/p/matius/v1`), so passing it unchanged reproduces the old `${base}/chat/completions` URL exactly.
- Observed AG-UI sequence (stubbed Chat Completions upstream): `RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT x2, TEXT_MESSAGE_END, RUN_FINISHED`. No `event:` lines, no `[DONE]`.
- A no-finish stream emits `RUN_ERROR` with `code:"incomplete-stream"` (openai-base chat-completions-text.ts:1285-1300), then closes; a usage-only tail (`choices: []` + `usage`) suppresses it.
- `onFinish` is awaited before SSE close but after RUN_FINISHED delivery. Measured with a deliberate 50ms hook: terminal@25ms, onFinish@79ms, close@79ms.
- The real gateway is not running on this host; the live raw probe returns ECONNREFUSED. Evidence records this and uses the stub wire for the contract verdict.
- `server/env.ts` exports `env` as a DEFAULT export; `AI_CHAT_API_KEY` is `string | undefined`.

### Todo 3 addendum â€” loader seam

- Static import of `@tanstack/ai*` is fine for Vitest (SWC emits ESM) and tsc, but wrong for the CJS server build: `require()` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. Use todo 2's `loadTanstack()` / `loadOpenaiCompatible()` for any runtime import of these packages.
- `new Function("return import(s)")` works in plain Node (CJS) but fails in Vitest's VM with "A dynamic import callback was not specified". Unit tests need `vi.mock("./tanstack")`.
- `server/env.ts` default-exports `env`; `AI_CHAT_API_KEY` is `string | undefined` (hence the `"not-configured"` placeholder required by the OpenAI SDK's non-empty-key constructor check).

## Todo 2 â€” CommonJS interop facts (W0 gate)

- Failure code for static import is **`ERR_PACKAGE_PATH_NOT_EXPORTED`**, NOT `ERR_REQUIRE_ESM`: `require()` fails resolving the `exports` map (only `import` condition) before ESM loading is attempted. Do not expect `ERR_REQUIRE_ESM` here.
- swc (`module.type: commonjs`) turns BOTH `import("literal")` and `import(variable)` into `require(...)`. Only a string-assembled `new Function("specifier","return import(specifier);")` survives. `new Function` trips oxlint `typescript/no-implied-eval` (a warning; silence with `// oxlint-disable-next-line typescript/no-implied-eval -- <reason>`).
- `typeof import("@tanstack/ai")` type annotations trip oxlint `typescript(consistent-type-imports)`. Use `import type * as X from "..."` + `type T = typeof X` instead (type-only, erased by swc).
- No top-level await in the `@tanstack/ai` / `@tanstack/ai-openai` ESM graphs (col-0 `await` scan = 0), so a plain `require(esm)` of the raw dist file would have worked â€” but the specifier never resolves, so the point is moot.
- Runtime proof from the compiled build: `require('./build/server/routes/api/ai/tanstack.js')` returns the two loaders; each caches its promise (`p === loadTanstack()`); the resolved namespaces expose `chat`, `toServerSentEventsResponse`, `chatParamsFromRequestBody`, `openaiCompatible`, `openaiCompatibleText`.
- The compiled `web` server boots under `NODE_ENV=development` for 20s with no ESM error (`.env` supplies 0 injected vars here; boot reaches the dev-mode banner and email init).

## todo 6 — refusal/busy AG-UI framing (verified)
- Evidence channel: live gateway 127.0.0.1:8642 is DOWN, so capture is the wire-level stubbed-fetch test, not curl. Temporary probe test printed frames/rows, then was deleted; permanent assertions live in ai.test.ts + aiInFlightCap.test.ts.
- 
efuseWithAgUiRun already correct: header set before ctx.body, status 200, node Readable, persisting appendTurn awaited before the frames exist, lock released on the refusal exit.
- Busy exit must NOT release the lock (it never acquired it) — asserted via Redis key still held while the first stream is open.

## Todo 8 - flatten UIMessage parts (GAP-9)
- Shared flattener: server/routes/api/ai/messages.ts -> messageText(). Non-empty legacy content wins; else concatenate content of parts with type === 'text' in order; thinking parts skipped.
- Server call sites: pendingContent (DB write) and toUpstreamMessage (provider + grounding gate). UpstreamMessage = { role: 'user'|'assistant'; content: string } removes both casts.
- Role allow-list re-asserted AFTER flattening; empty flattened text drops the message (never forwards content: '').
- zod v4: z.object({type: z.string().min(1)}).loose() accepts AG-UI parts and still rejects a system role in both shapes.
- toUpstreamMessages now caps the stateless client array too (schema already caps at 50).
- Folder suite 139/139; two known 5s timeout flakes reproduce alone as green.


## 23. AG-UI threadId as the persisted session id
- `ai.chat` now resolves `sessionId = body.sessionId ?? body.threadId` exactly once and threads that single value into ownership, lock key, persistence middleware and `chat({ threadId })`. Legacy RPC `sessionId` is untouched.
- Schema `threadId` is `z.uuid().optional()`; the `.refine` accepts messages OR sessionId OR threadId. A client-minted non-uuid `thread-...` id (TanStack's fallback) is therefore a 400 — todo 9 must send the session UUID as `threadId`.
- TanStack's own `RUN_STARTED` / `RUN_FINISHED` frames do carry `threadId`, so asserting `frames[0].threadId === session.id` is a valid end-to-end check for the resolved session.
- Test filter note: `yarn test <file> -t "<name>"` works; new totals are 144 tests in `server/routes/api/ai/`.

## Todo 10 — panel streaming over the client
- TanStack ChatClient threadId is fixed at construction; updateOptions cannot change it. A per-turn ChatClient is the clean way to address a session created mid-send.
- The connect-adapter wrapper drains on send: sendMessage resolves only after the upstream iterator closes, which is after the server's persistence middleware commits. The post-settle store re-read is therefore safe.
- Connection-thrown AiChatError is captured in a wrapper before normalizeConnectionAdapter turns it into a RUN_ERROR; prefer the captured error over ChatClient.getError() to keep HTTP status/kind.
- Panel tests must mock createAiChatConnection with AG-UI frames, and the fake server must record committed rows before RUN_FINISHED so the post-settle list returns them.
- Module-level RootStore leaks selectedSessionId/data across tests; clear it in beforeEach.

## Todo 12 — drafts + session history under the new transport
- Draft touch points: `handleChange` writes (debounced 500ms), mount `useState` reads, session-switch effect reads, submit clears, AIChatHistory delete clears after success, unmount `flushDrafts()`. Selection → null makes the draft effect read `aiChat.draft.pending`.
- No code bug from the todo-10 rewrite: all seven existing draft tests plus delete-path tests passed unchanged. Only additions were coverage.
- The shared `__mocks__/localStorage.js` has no `clear()`; wipe in `afterEach` by reverse index (`length`/`key(i)`/`removeItem`) or a draft leaks into the next test's composer (surfaced when the abort test's `session-new` draft appeared in the New chat test).
- Abort case needs a generator that yields `RUN_STARTED` then awaits an `AbortSignal` listener: clicking Stop rejects with `AbortError`, `stopTurn` bumps `turnRef` so the panel ignores it, and the draft typed during the turn stays untouched.
- Evidence: `.omo/evidence/12-drafts.txt` (7 draft-helper + 3 panel draft tests) and `12-drafts-red.txt` (abort → remount re-read), mirrored to the worktree.
- Re-verification pass added the missing pending-key clear assertion to `aiChat.test.ts` ("keep the pre-create draft under its own key") so both the session and pending keys have write/read/clear covered; commit squashed to `be1ae3ef2`. Tests 33/33, `yarn tsc --incremental false` EXIT=0.



## Todo 13 — read-only server tool allowlist
- @tanstack/ai is ESM-only, so 	oolDefinition(...).server(fn) cannot be built at module load from a static import. Pattern used: loadServerTools() lazy-caches loadTanstack().then(({ toolDefinition }) => buildServerTools(toolDefinition)) and the array is Object.freeze([...]).
- Server tools stay static; the per-request user arrives via chat({ context: { user } }) and is read as context.context.user inside .server<ServerToolContext>(fn). No per-request tool arrays, no params.tools, no orwardedProps spread — so the allowlist cannot be client-influenced.
- chat({ tools, context }) type-checked without casts; only dapter / messages / middleware still need the existing casts.
- Happy-path tool tests are cheap at the stub boundary: OpenAI-compatible SSE frame with delta.tool_calls + inish_reason:"tool_calls", second fetch returns text. Assert TOOL_CALL_START/END/RESULT, final text, and that the follow-up request body carries the tool output (title string) — proving execution, not just the frames.
- Injecting 	ools in the request body is a valid passthrough() body field, which is exactly why the red test asserts at the provider boundary: no request body ever contains the smuggled name and 	ools is always exactly ["search_workspace"].

## Todo 14 - tool-call parts in the transcript
- AG-UI frames that produce a `tool-call` part on the client: TOOL_CALL_START(toolCallId, toolCallName) -> TOOL_CALL_ARGS(delta=JSON string) -> TOOL_CALL_END(input) -> TOOL_CALL_RESULT(content=JSON string). The processor writes `output` onto the tool-call part only on TOOL_CALL_RESULT; `state` runs awaiting-input -> input-streaming -> input-complete -> complete/error.
- In a fake AG-UI stream, emit TEXT_MESSAGE_START *before* the tool frames: TOOL_CALL_START attaches to the active assistant message, otherwise the processor creates its own generated-id assistant message and a later TEXT_MESSAGE_START creates a second one - `liveAssistant` reads only the last assistant message, so the tool call would be invisible.
- MESSAGES_SNAPSHOT messages that carry a `parts` array pass through verbatim (including unknown part types), which is the cleanest way to feed an unknown-part-type fixture through the real ChatClient.
- Tool-call cards are live-only by design: AIChatMessage persists `content` alone (server flattens text parts), so a tool call cannot survive the settle boundary without a server change.

## Todo 15 - reasoning passthrough
- Installed @tanstack/ai-openai `openaiCompatibleText` adapter does NOT map `chat({ reasoning })` onto the wire: `OpenAICompatibleChatAdapter` overrides only `extractReasoning()`; the base `modelReasoning()` default is `undefined`, and `resolveReasoning(undefined, …)` returns `undefined`, so no `reasoning_effort` is ever emitted for a string-declared compatible model. The plan note's "optimistic defaults" exist at the type level only.
- The supported request-side channel for this adapter is `chat({ modelOptions })`, spread verbatim into the Chat Completions body (`@tanstack/openai-base/src/adapters/chat-completions-text.ts:1503-1516`). So the field is `modelOptions: { reasoning_effort }`, gated on the new optional `env.AI_CHAT_REASONING` (`@IsIn(["minimal","low","medium","high"])`, defaults unset) - never hard-coded, never read from `ctx.input.body` (the schema is `passthrough()`, so a client CAN send `reasoning`/`reasoning_effort` body fields; the route simply never reads them).
- Response side works in the installed adapter with no change: `extractReasoning()` reads `delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text` and the engine emits `REASONING_MESSAGE_START/CONTENT/END` AG-UI frames in that order, before the answer's `TEXT_MESSAGE_*`. IS-5 does NOT need re-scoping; todo 16 maps those frames onto the collapsed thinking disclosure client-side.
- The reasoning-bearing turn still stores only the text-channel answer: middleware accumulates `TEXT_MESSAGE_CONTENT` only, asserted in `aiReasoning.test.ts`.
- Tests: `server/routes/api/ai/aiReasoning.test.ts` (4 tests). Suite: 9 files / 151 tests green (147 baseline + 4). `yarn tsc --incremental false` EXIT=0.
- Evidence: `.omo/evidence/15-reasoning.txt` (configured -> `reasoning_effort:"medium"`) and `15-reasoning-red.txt` (unconfigured -> zero /reasoning/i keys), mirrored to the canonical `.omo/evidence/`.

## Todo 16 - thinking as a collapsed, live-only disclosure
- The disclosure was already wired (`liveAssistant` reads `part.type === "thinking"`; `ReasoningDisclosure` is a bare `styled.details` so it is collapsed unless `open` is set). Verification only, plus one real gap.
- Gap found by the whitespace case: the render gate was `isStreamingAssistant && reasoning`. An empty *string* is falsy, but a whitespace-only thinking part is truthy and rendered `<details>` with an empty body. Fixed with `reasoning.trim()` in the gate (display keeps the raw text). Empty-part case alone would have passed accidentally, so the whitespace case is the one that proves the gate.
- `fakeConnection` guarded the reasoning frames with `if (script.reasoning)`, so `reasoning: ""` never replayed a part. Changed to `!== undefined`; no duplicate helper, and every existing call site is unaffected (all pass non-empty strings).
- Store-row proof: `AIChatMessage` has no reasoning field at all and the panel's settle path only re-reads `aiChatMessages.list` (server rows), so thinking structurally cannot persist. The test still asserts it: 0 rows while streaming, then exactly 1 stored assistant row with `content === "The answer"` and no thinking text - a future local-write regression would fail it.
- `yarn tsc --incremental false` EXIT=0; `AIChatPanel.test.tsx` 29/29; `app/components/AIChat/` 51/51; oxlint clean on both files.
- Evidence: `.omo/evidence/16-thinking.txt` (a-d green run + tsc) and `16-thinking-red.txt` (whitespace-only case failing on the old gate), mirrored to the canonical `.omo/evidence/`.

## Todo 17 - whenBusy queue
- Library verdict first (evidence file 1): installed @tanstack/ai-client DOES have a queue (`queue:{whenBusy,drain,onOverflow,maxSize}`, `cancelQueued(id)`, `flushQueue()`, `discardPendingSends()` in chat-client.js:42-67, 1302-1327, 1939-2006). But it is per-ChatClient-instance state and the panel builds a fresh client per turn - it cannot span turns. Implemented as panel state mirroring the library semantics exactly.
- The queue is a ref + state pair: `queueRef` is authoritative inside the drain loop (closures after `await` are stale), `queued` state is for rendering. `replaceQueue` writes both.
- Stale-`sessionId` bug found before tests: a drained turn inherits the submit closure's `sessionId`, so it would create a SECOND session after turn 1 selected one. Fix: `sendTurn` reads `aiChatSessions.selectedSessionId` from the store at call time. Any future drain/loop-of-turns code must do the same - closure props are frozen at submit time.
- `TurnOutcome` = settled | superseded | failed is the drain contract: settled -> drain; failed -> flush; superseded -> do nothing because `stopTurn` already flushed. Without the superseded branch, an interrupted turn would asynchronously flush a queue the user refilled after the interrupt.
- Stop, interrupt, New chat and session switch all route through `stopTurn`, which now flushes the queue - one flush point, not five.
- Red-run honesty: the `drop` criterion test PASSES against the pre-feature hard guard (old guard == drop), so the red run shows 4 failed / 1 new test passing. The other four tests prove feature absence is detected.
- Red method reused from todo 16 but extended: copy both prod files to %TEMP%, `vcs checkout --` them, run, restore, then verify restoration by diffing the patch bytes (`PATCH_MATCH=True`).
- Tests: panel 29 -> 34; AIChat folder 51 -> 56; `yarn tsc --incremental false` EXIT=0; oxlint clean on the 3 files.
- Evidence: `.omo/evidence/17-queue.txt` + `17-queue-red.txt`, mirrored to canonical `.omo/evidence/`.

## Todo 19 — server test contract (commit cf165eb54)

- `grep -rn "event: \|\[DONE\]" server/routes/api/ai/*.test.ts` was NOT empty before this todo: 25 hits across aiStreaming, aiInFlightCap, ai.test, aiReasoning and tools. The old fixtures fed `data: [DONE]\n\n` as the provider terminator; the adapter does not need it (`finish_reason` is the terminal signal), so removing every sentinel left all tests green.
- Negative assertions like `not.toContain("[DONE]")` are themselves grep hits. Replace them with structural parsing (`parseAgUiFrames`) that asserts every block is `data: <json>` — stronger and grep-clean.
- Vitest: the OpenAI SDK captures `fetch` at client construction. Stub `globalThis.fetch` BEFORE `createAiChatAdapter()`, or the contract test really dials the configured base URL (observed `401 invalid_api_key`).
- `vi.spyOn(Readable, "fromWeb")` intercepts the route's call (node builtins are one module instance) and the returned value is `instanceof Readable`. The static exit check must resolve identifiers: `ctx.body = body;` is fine when `const body = new Readable(...)`.
- Full-suite counts on this machine: 240 files / 3874 tests -> 3841 passed, 27 failed, 6 skipped. All 27 failures are pre-existing environment issues (PDF fixture parse, `\` path encoding in export tasks, 5s timeouts, `@shared/types` resolution in server-shared) and ZERO are under `server/routes/api/ai`. AI folder alone: 156/156 green (was 152 before this todo).
- Running the full suite rewrites 13 unrelated `__snapshots__/*.snap` files (line endings). Revert them before committing.

## Todo 21 - docs rewrite (TanStack transport)

- The retired-claim grep must be literal: `event: complete|event: truncated|event: error|\[DONE\]|byte-identit`. Avoid writing the word `[DONE]` even in a "never used" sentence, or the check goes red. "provider sentinel" is the safe phrasing.
- Verification channel: a temporary `zzDocsProbe.test.ts` drove the real route with an ungrounded prompt and printed status/headers/body verbatim, then was deleted. The same recipe is permanently covered by `ai.test.ts -t "refuses a general-knowledge probe"` (1 passed, 24 skipped, TEST_EXIT=0).
- Docs are Markdown only; `yarn tsc --incremental false` still EXIT=0.
- Evidence: `.omo/evidence/21-docs.txt` + `21-docs-red.txt` (before grep from HEAD has hits; after grep is zero), mirrored to canonical `.omo/evidence/`.

- F1 re-audit (df22f6970): fixture provenance corrected to STUB; live gateway probe tracked as blocked row 24; gates re-run green (server 156, app 356, tsc 0). Verdict APPROVE with row 24 caveat.
- F2 review: repo route files and React components legitimately use export default; do not flag vs the "named exports only" rule.
- @vitest-isolate true applies only to server/** + plugins/** (vitest.config.ts:59-77), not app tests.
- Worktree-modified files come back CRLF while new files are LF, so oxfmt --check noise is not evidence of new format violations.
- F4: run the AI folder alone before judging lock tests. Under a concurrent full-suite load
  `aiInFlightCap` flaked (5s timeout + fetch-call race); alone it is 9/9 and the folder is 156/156.
- F4: "test:server passes" must be measured, not inferred from the AI folder. It is red at this
  tip for pre-existing Windows-path/PDF/cron reasons, so IS-7 as worded does not hold.
- F4 evidence: .omo/evidence/F4-ideal-state.txt (canonical + worktree).

## Todo 28 - panel re-read failure
- Post-stream aiChatMessages.list() rejection must not clear pending; clear it in the success handler of the promise (	hen(onSuccess, noop)), not after the await. Store.list() only writes rows inside runInAction after a successful post, so a rejection leaves committed rows untouched and the local turn is the only copy.
- Panel mount effect and post-settle both read the same endpoint; a failure test must stub /ai.messages.list wholesale and answer /ai.sessions.list too.
- Evidence: .omo/evidence/28-panel-reread.txt (red then green, canonical + worktree). App AI folder 59/59; tsc EXIT=0.

## Upstream sync (main <- upstream/main, 157 commits)
- 15 conflicts, not the 13 the dry run predicted: `package.json`, `tsconfig.json` and `yarn.lock` also conflicted. Treat merge-tree dry runs as a lower bound.
- Upstream replaced `koa-router` with `@koa/router` and renamed Tooltip's `placement` to `side`; both break the fork's AI files at tsc, not at merge time. Fix the fork's code, not the upstream base.
- `node_modules/.bin/swc` cannot be invoked through `cmd.exe` from `build.js` (`'node_modules' is not recognized`), but `yarn swc` can. The fork's Windows-safe `fs` helpers plus `yarn swc` must be re-applied on top of upstream's rewritten `build.js` (which also adds watch mode and the locales copy).
- Upstream has its own `vitePort` getter; the fork has `VITE_DEV_PORT`. Collapse to one source of truth: `VITE_DEV_PORT` defaults to `PORT + 1`, `vitePort` returns it. Otherwise CSP, `routes/app.ts` and `vite.config.mts` disagree.
- `shared/types.ts` -> `shared/types/` needs no import rewrite: `@shared/*` still resolves `@shared/types` to `shared/types/index.ts`. Only the fork's own additions (TeamPreference.AIChat) had to be re-applied to `shared/types/team.ts`.
- The locale catalog must be regenerated, not merged: take upstream's file then `yarn i18next --silent '{shared,app,server,plugins}/**/*.{ts,tsx}'`. The parser honours `lineEnding: auto` and writes CRLF on Windows (1995 lines), so normalise to LF afterwards or the diff becomes the whole file.
- Pre-existing `test:server` red set must be measured against a real pre-merge worktree: detached worktree at the old tip + its own `yarn install` + the same nine files = 9 files / 26 tests. Merged tree reproduces exactly 26/9, so the delta is zero. A 27th failure appeared once as a 5 s docx-conversion timeout under full-suite load; it passes isolated and repeats green in a second full run.
- Cron failures ("Cannot find package '@shared/types'") persist after the module split because `requireDirectory()` loads task files through Node's native loader, which ignores the Vite alias. Pre-existing, unchanged by the sync.
- Evidence: `.omo/evidence/upstream-sync-conflicts.md` (canonical + worktree).

## CI fix - plugin entry-point glob test
- The fork's PluginManager.test.ts globbed the real build/ directory, which CI never builds (checkout -> install -> sequelize db:migrate -> test), so both build-dependent cases were red on the runner.
- Fix: build a relative fixture root (plugin-glob-fixture-<uuid>/) in beforeAll, glob through pluginEntryPointGlob(fixtureRoot), remove it in afterAll. Relative is mandatory: the helper does not normalise separators, so an absolute C:\ root would reintroduce the backslash bug the Windows case guards.
- Evidence: .omo/evidence/ci-plugin-glob-test.md (worktree ci-fix-w1). 4/4 green with build/ absent and present; tsc EXIT=0; lint EXIT=0.
- Commit: 6380a83965 test(plugins): make the entry-point glob test independent of the build output
