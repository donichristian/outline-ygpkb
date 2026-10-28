# Decisions — tanstack-ai-slice2-adoption

Architectural choices and rationales discovered during work on this plan.

_Auto-scaffolded by /ulw-execute. Append new entries below - never overwrite._

---

## Todo 3 — adapter choice and terminal ordering

- Adapter: `openaiCompatibleText(env.AI_CHAT_MODEL, { api: "chat-completions", baseURL: env.AI_CHAT_BASE_URL, apiKey: env.AI_CHAT_API_KEY ?? "not-configured" })` from `@tanstack/ai-openai/compatible`. Rejected `openaiText` (Responses API — wrong endpoint) and a hand-rolled `fetch`+`sseFrame` proxy (W1 removes it). Rejected constructing `OpenAICompatibleChatAdapter` directly: the documented factory is the single construction site and keeps SDK wiring (baseURL, key, fetch) in one place. Declared `AiChatAdapter = ReturnType<typeof openaiCompatibleText>` because the factory's declared return type is a Chat/Responses union regardless of `api`.
- API key: passed only into the SDK; the factory never returns or logs it. Keyless gateways get the `"not-configured"` placeholder because the SDK requires a non-empty key at construction.
- `finish_reason`: the live Hermes gateway is down on this host (ECONNREFUSED 127.0.0.1:8642). The Chat Completions wire contract is proven with a stub: terminal chunk carries `finish_reason:"stop"` → verdict `finish_reason present`; a stream without it yields `RUN_ERROR` code `incomplete-stream`. W1 todo 5 maps that code to `truncated`.
- Ordering: `chat()` + `toServerSentEventsResponse` runs `onFinish`/`onError`/`onAbort` to completion BEFORE the SSE stream closes (the engine awaits `runTerminalHook()` after the loop, before the iterable reports done). The terminal RUN_FINISHED event is delivered before the hook resolves. Therefore middleware-hook persistence satisfies "durable before end" and NO manual `StreamProcessor` fallback is needed. A client reacting to RUN_FINISHED can still race the commit — same as today's route, which pushes its terminal frame before `appendTurn`.

### Todo 3 addendum — ESM loader seam (coordination with todo 2)

- `require("@tanstack/ai")` and `require("@tanstack/ai-openai/compatible")` both fail with `ERR_PACKAGE_PATH_NOT_EXPORTED` on Node 22.23.3. A static import in `adapter.ts` would be compiled to `require()` by SWC and fail in the built server. The factory is therefore **async** and loads the package through todo 2's `loadOpenaiCompatible()` in `server/routes/api/ai/tanstack.ts` (dynamic `import()` assembled with `new Function`, which survives SWC's CJS transform).
- Confirmed from a real CommonJS process: `dynamicImport("@tanstack/ai-openai/compatible")` + `chat()` runs and emits the full AG-UI sequence.
- Vitest caveat: inside Vitest's VM, `new Function("return import(...)")` throws `TypeError: A dynamic import callback was not specified`. W1/W6 unit tests that call `createAiChatAdapter` must mock `./tanstack` (or the two packages). The negative guard still runs before the loader, so it is testable without mocks.
- `adapter.ts` imports `./tanstack`; the two files must land together. `tanstack.ts` is the parallel todo-2 worker's artifact and is staged with adapter.ts so the commit is self-consistent.

---

## Todo 2 — W0 gate: CommonJS server build needs dynamic `import()`

- **Decision: dynamic `await import()` is REQUIRED; static ESM import is impossible.** All four `@tanstack/ai*` packages are `"type":"module"`, have no `main`, and their `exports` maps carry ONLY an `import` condition (no `require`, no `default`). Node v22.23.3 has `require(esm)` on by default, but that is moot: `require()` cannot even resolve the specifier — it throws `ERR_PACKAGE_PATH_NOT_EXPORTED` at the exports-map stage, before any ESM load. A static import therefore compiles to `require("@tanstack/ai")` and dies.
- **Kept mechanism:** `server/routes/api/ai/tanstack.ts` — memoized `loadTanstack()` → `@tanstack/ai` and `loadOpenaiCompatible()` → `@tanstack/ai-openai/compatible`, caching the promise. Interface matches what todo 3's `adapter.ts` imports (`loadOpenaiCompatible`).
- **swc rewrites a plain `import()` to `require()`** under `.swcrc`'s `module.type: commonjs` (verified with `@swc/core`: literal AND variable specifiers both become `Promise.resolve(...).then(() => _interop_require_wildcard(require(specifier)))`). `module.ignoreDynamic:true` keeps the import but would require editing `.swcrc`, which is forbidden. The loader assembles the import from a string instead: `new Function("specifier","return import(specifier);")`, which swc cannot rewrite.
- **Evidence:** `.omo/evidence/02-cjs-boot.txt` (happy: build exit 0, loaders resolve, 20s boot with no ESM error) and `.omo/evidence/02-cjs-boot-red.txt` (red: `ERR_PACKAGE_PATH_NOT_EXPORTED` from the compiled static probe).
- **Todo 4 and later MUST** import these packages only through `loadTanstack()` / `loadOpenaiCompatible()` for any runtime (built-server) path; static imports are type-only-safe (erased) but never runtime-safe here.
- Note: `yarn tsc` on the tree still reports one error in todo 3's untracked `adapter.ts` (`AiChatAdapter` union narrowing at adapter.ts:55) — unrelated to todo 2; `tanstack.ts` itself is diagnostic-clean and lint-clean.

## Todo 10 � useChat vs ChatClient
Chose a per-turn headless ChatClient. useChat recreates its client when threadId changes, but the first send's session uuid is only created after submit; ChatClient constructed once that id exists addresses the very first frame correctly. The client remains a frame source only: committed rows stay in AIChatMessagesStore and are merged by seq.


## Todo 15 - reasoning request field goes through modelOptions, not chat({ reasoning })
- Evidence beats the note: the installed compatible adapter drops `chat({ reasoning })` silently at runtime, so declaring a type-level capability would produce a field that never reaches the gateway. The route sets `modelOptions.reasoning_effort` only when `AI_CHAT_REASONING` is configured; absent config omits the key so a plain gateway is never sent an unsupported parameter.

## Todo 17 - queue lives in panel state, not on ChatClient
- The TanStack client's own queue is instance state on `ChatClient`. This panel constructs a new client per turn (decided at todo 10 because threadId is fixed at construction). An instance queue therefore cannot survive the turn boundary, so the queue is owned by the panel: `queued`/`queueRef` ordered FIFO, drained by `runTurns` only after a settled turn, flushed by `stopTurn`. Semantics mirror the library: drain on success, flush on stop/error, per-item cancel, `whenBusy` default `"queue"`.
- `AiChatWhenBusy` lives in `app/utils/aiChat.ts`; the option surfaces as the `whenBusy` prop of `AIChatPanel` (default `"queue"`). No UI switch exists yet - tests drive the prop directly.
- Interrupt supersedes everything: it aborts the current turn AND flushes the waiting queue, matching the spec's \"abort flushes the queue\" rule; the new message is sent directly, never queued.
- The server keeps its one-turn-per-session lock (todo 18) as the backstop; the queue never bypasses it because only one `sendTurn` runs at a time per drain loop.
