# AI Chat — 4 fixes (v2, post-review)

Status: APPROVED — ready to execute
Decisions locked: D1 = A (refusal renders as a transcript turn); D2 = A (gate stays fail-closed); Issue 2 = **(b) route gate + non-fatal boot warning**; refusal transport = **payload `kind` discriminator, NOT an event rename**.

Execution is gated: this plan is the source of truth. Implementation begins on `/ulw-execute`.

## v2 changelog (what the three reviews changed)

- **Refusal transport reverted from event rename to payload `kind`.** PROVEN WRONG by Oracle: (1) a cached pre-rename SPA bundle receiving `event: refusal` falls through `parseFrame` → `JSON.parse` → `extractDelta` finds no `choices` → returns `""` → the empty bubble is suppressed (`AIChatPanel.tsx:175-177`) → **the user sees their question with no answer and no error**, strictly worse than the bug being fixed; (2) AG-UI (`RUN_ERROR`) has no `event:` names, so an event-keyed discriminator is discarded by the slice-2 migration and the bug regresses across the boundary. Replace with `{ error: message, kind: "refusal" }` on the existing `event: error`.
- **Issue 2 downgraded from boot-fail to route gate + warning.** PROVEN disproportionate by Oracle: `env.ts:34-47` validates once per process cluster, so boot-fail exits web/worker/cron/collaboration/websockets for a single-route misconfiguration, and creates a rolling-deploy crash-loop (the intermediate state of a two-step env rollout is exactly the failing state). Today URL-set-without-MODEL boots fine and yields a route 400 (`ai.ts:130,153`).
- **Panel fix no longer uses a second state variable.** With the payload `kind`, the panel knows it is a refusal at throw time — no `refusedIndex`, so the stale-index/`key={index}` class of bug cannot occur.
- **Issue 4 corrected:** `AI-CHAT-DESIGN.md:118-119` prose is ALREADY correct; only the mermaid at `:65-66` is wrong. The v1 plan wrongly said to swap the prose.
- **New mandatory guardrail:** an end-to-end wire assertion. `expectRefused` (`ai.test.ts:306`) currently passes for BOTH `{"error":…}` and `{"refusal":…}` payloads, which is why every defect class would ship green.
- **Issue 3 branch placement pinned** inside the existing `try`, so a helper throw degrades to `"search failed"` (fail-closed) rather than a 500.

---

## 0. Context an executor must hold

- Repo root: `D:\Work-Project\Outline-YGPKB\outline-ygpkb`
- `server/routes/api/AGENTS.md`: handler stays thin; validate with zod; never leak provider detail.
- `app/components/AGENTS.md`: function components + hooks, `handle*` handlers, styled-components co-located, `observer()` when reading stores.
- `app/AGENTS.md`: do NOT hand-edit `shared/i18n/locales/` — `i18next-parser` extracts them.
- `env.ts` imports neither `Logger` nor the app logger; it uses `console.warn` (`:43`) and carries `/* oxlint-disable no-console */` at `:1`. The boot warning must follow that precedent.

### Facts verified during planning (do not re-derive)

| Fact | Location |
|---|---|
| Route stack is `auth → rateLimiter → validate` | `ai.ts:65-67` |
| `refuseWithSseError` emits `event: error` with `{error}` | `ai.ts:54-61` (frame at `:58`) |
| Mid-stream failure emits `event: error` with `{error}` | `ai.ts:189-200` (frame at `:196`) |
| `parseFrame` maps `event: error` → `AiChatError(kind:"stream")` | `aiChat.ts:197-199` |
| `errorMessage(raw)` reads only `parsed.error` | `aiChat.ts:219-230` |
| `AiChatErrorKind` union | `aiChat.ts:32-40` |
| Panel routes every `AiChatError` to `setError` (red `ErrorNotice`) | `AIChatPanel.tsx:119-128`, `:194-200`, `:297-303` |
| Panel suppresses an empty assistant bubble **by returning null without consuming a logical slot** | `AIChatPanel.tsx:174-177` |
| `next` is `[...messages, user, assistant:""]`; assistant turn is index `next.length - 1` | `AIChatPanel.tsx:91-95` |
| `expectRefused` asserts only `toContain(OutOfScopeRefusal)` | `ai.test.ts:291-311` |
| `OutOfScopeRefusal` test greps the `t()` literal in `ai.ts` source | `ai.test.ts:497-508` |
| `AI_CHAT_MODEL` is `@IsOptional @CannotUseWithout("AI_CHAT_BASE_URL")` | `env.ts:371-373` |
| Env validation is a per-cluster `process.nextTick` → `process.exit(1)` | `env.ts:34-47` |
| `toOptionalString` maps `""` → `undefined` | `env.ts:979-981` |
| Decorator family + import block | `validators.ts:118-215`; `env.ts:21-28` |
| `normalize` keeps `\p{L}\p{N}`, splits on whitespace | `scope.ts:68-76` |
| `buildProbeQuery` drops terms `< 2` chars; caps at 8; `|`-joined | `scope.ts:112-130` |
| `findUngroundedReason` decision line | `scope.ts:184` (`total > 0 ? undefined : "no matching document"`) |
| Design-doc mermaid order wrong; prose already correct | `AI-CHAT-DESIGN.md:65-66` (wrong), `:118-119` (correct) |
| Refusal string already catalogued | `shared/i18n/locales/en_US/translation.json:1918` |

---

## Issue 4 — middleware order in the design doc (do first: zero risk)

Only the mermaid is wrong. **Do NOT touch the prose at `:118-119` — it is already correct.**

- `docs/AI-CHAT-DESIGN.md:65-66`: swap the two lines so the order is `auth` → `rateLimiter(TenPerMinute)` → `validate(T.AiChatSchema)`.
  - before: `:65 validate(T.AiChatSchema)` then `:66 rateLimiter(TenPerMinute)`
  - after: `:65 rateLimiter(TenPerMinute)` then `:66 validate(T.AiChatSchema)`
- Leave `docs/AI-CHAT-DESIGN.md:118-119` exactly as-is.

Acceptance: `grep -nE "rateLimiter|validate\(T\.AiChatSchema\)" docs/AI-CHAT-DESIGN.md` shows `rateLimiter` before `validate` in the mermaid block (65-66) AND unchanged correct order in the prose (118-119). Both match `ai.ts:65-67`.

---

## Issue 1 — refusal renders as a transcript turn (payload `kind`, no event rename)

**D1 = A.** The refusal is the boundary answering, not a failure. The wire already carries both on `event: error`; add a discriminator so the client can tell them apart — **in the payload, never in the event name.**

### 1.1 Server — payload discriminator (`server/routes/api/ai/ai.ts`)

- `refuseWithSseError` (`:54-61`) keeps `event: error` but changes its payload to `{ error: message, kind: "refusal" }`. Emit `sseFrame({ error: message, kind: "refusal" }, "error")`.
  - Rationale to preserve in the comment: the event name stays `error` so a browser holding a pre-rename bundle degrades to today's red-banner behaviour instead of silently dropping the answer; `error` is retained alongside `kind` for that same backward read.
- Update the JSDoc on `refuseWithSseError` (`:44-53`) and the refusal comment at `:92-108`: the refusal now reaches the panel as a refusal by virtue of the `kind` field, and the panel renders it as an ordinary transcript turn. Delete the sentence claiming it is "the same channel a mid-stream provider failure uses" — that sentence is now only half-true (same event, different payload) and is the exact confusion this change removes.
- **Do NOT touch the mid-stream error path** (`:189-200`). It stays `sseFrame({ error: "The AI chat stream failed" }, "error")` with no `kind`. Verify `ai.ts:196` is byte-identical after the edit — this is a two-producer, one-event wire, and a careless "add kind everywhere" would tag the mid-stream failure as a refusal.
- `sseFrame` (`:28-31`) is generic and unchanged.

### 1.2 Client type + parser (`app/utils/aiChat.ts`)

1. Add `| "refusal"` to `AiChatErrorKind` (`:32-40`):
   - `/** The request was refused by the grounding gate before the provider was contacted. */`
2. `errorMessage` (`:219-230`): change it to read `parsed.error` as today, and return a second value (or accept the parsed object) so `parseFrame` can see `kind`. Preferred minimal shape: keep `errorMessage(raw)` returning the string, and add a sibling `errorKind(raw)` returning `"refusal" | "stream"` by reading `parsed.kind === "refusal"`. Both parse the same raw string; keep them small.
3. In `parseFrame` (`:178-210`), the `event === "error"` branch (`:197-199`) now throws `new AiChatError(errorMessage(raw), errorKind(raw))`. The kind is `"refusal"` iff the payload `kind === "refusal"`, else `"stream"`.
   - A malformed payload (not JSON) → `errorMessage` generic fallback + `errorKind` defaults to `"stream"` — i.e. an unparseable error is treated as a failure, never silently as a refusal. This is deliberate.
4. Update the `parseSSEStream` JSDoc (`:107-119`): an `event: error` frame throws `kind:"stream"`, or `kind:"refusal"` when the payload carries `kind:"refusal"`.

### 1.3 Panel — render refusal inline (`app/components/AIChat/AIChatPanel.tsx`)

In `handleSubmit`'s `catch` (`:119-128`), branch **first** on `err instanceof AiChatError && err.kind === "refusal"`:

- write the refusal text into the trailing assistant turn's `content` using the **same functional `setMessages` updater** already used for deltas (`:109-117`) — mutate only the last message's `content`, then return the new array;
- do **not** call `setError`;
- `isStreaming` is already cleared in the `finally` (`:129-134`) — no change.

Every other kind (`http`, `network`, `stream`, `malformed`) and the non-typed fallback keep the current `setError` path unchanged.

**No second state variable.** Do not add `refusedIndex`, `data-refused`, or any index-keyed flag. Because the panel learns it is a refusal at throw time, the refusal text simply becomes the content of the last message. This avoids the stale-index hazard Oracle flagged under `key={index}` (`:180`).

**Empty-bubble suppression:** the guard at `:174-177` returns `null` when `message.role === "assistant" && !message.content`. After the refusal writes content into that last message, the guard no longer fires and the turn renders. No change to the guard is required — but the executor must confirm the refusal branch sets `content` **before** the next render (it does, via `setMessages`).

**Accessibility (required, per Oracle Q5):** the inline refusal loses the visually-distinct red border, so it must be announced. Give the refusal turn an accessible affordance: when rendering the assistant message that is the refusal, set `role` and `aria-live` so assistive tech announces it. Minimal approach that avoids new state: render a `role="status"` wrapper (or add `aria-label={t("Refusal")}`) on the assistant `Message` when it equals the refusal. If the executor prefers zero extra state, the simplest robust option is to include the refusal text in a `<span role="status">` inside the message `div`. State the chosen approach in the PR description.

### 1.4 Tests — including the mandatory end-to-end wire lock

- **`server/routes/api/ai/ai.test.ts` — HARDEN `expectRefused` (`:291-311`).** This is the guardrail the reviews demand:
  - `expect(text).toContain('data: {"error":"' + OutOfScopeRefusal + '","kind":"refusal"}')` OR, if byte-exactness is brittle, assert all three: `toContain('"kind":"refusal"')`, `toContain(OutOfScopeRefusal)`, and `not.toContain('"kind":"stream"')`.
  - Keep `toContain("event: error")` (the event name is deliberately unchanged).
  - This closes the gap where `toContain(OutOfScopeRefusal)` alone passes for both payload shapes.
- **`server/routes/api/ai/ai.test.ts`** — the mid-stream failure test (`:259-281`) MUST keep asserting `{"error":"The AI chat stream failed"}` with **no** `kind`, and MAY add `expect(text).not.toContain('"kind":"refusal"')`. This locks the two producers apart.
- **`server/routes/api/ai/ai.test.ts:497-508`** — leave the `OutOfScopeRefusal` source-grep test as-is; it stays green (the `t()` literal is unchanged).
- **`app/utils/aiChat.test.ts`:**
  - add: an `event: error` frame whose payload is `{"error":"…","kind":"refusal"}` → `rejects.toMatchObject({ kind: "refusal", message: "…" })`;
  - keep the existing `event: error` → `kind:"stream"` case (`:99-118`), and add: `event: error` with `{"error":"boom"}` (no `kind`) → `kind:"stream"` (proves the default);
  - add: a malformed (non-JSON) error payload → `kind:"stream"` (proves a broken payload never becomes a silent refusal).
- **`app/utils/aiChat.test.ts` — E2E wire lock.** Add one test that takes the **literal server frame string** `event: error\ndata: {"error":"<refusal>","kind":"refusal"}\n\n` and feeds it through `parseSSEStream`, asserting `kind:"refusal"` and the message round-trips. This is the only test that proves the two ends agree on the wire. Mirror the exact bytes asserted in the server test.
- **`app/components/AIChat/AIChatPanel.test.tsx`:** add a test that `streamAiChat` throws `new AiChatError("<refusal>", "refusal")` and assert:
  - `query("message-user")?.textContent === "hi"` (the user turn survives);
  - `query("message-assistant")?.textContent` contains the refusal text;
  - `query("ai-chat-error")` is **null**.
  This is the regression lock that was missing and let the red banner ship.

Acceptance for Issue 1:
- A refusal produces `event: error` + `{"error":…,"kind":"refusal"}` on the wire, `AiChatError(kind:"refusal")` in `streamAiChat`, and inline assistant text with no `ai-chat-error`.
- A mid-stream provider failure produces `event: error` + `{"error":…}` (no `kind`), `kind:"stream"`, and the red `ErrorNotice`.
- The server test and the client E2E test assert the same literal frame bytes.

---

## Issue 2 — `AI_CHAT_MODEL` required when a provider is configured (Option b)

**Decision (b): route gate + non-fatal boot warning. NOT boot-fail.**

### 2.1 Route gate (`server/routes/api/ai/ai.ts:74-79`)

Extend the existing 404 gate to also require the model:

```
if (
  !user.team.getPreference(TeamPreference.AIChat) ||
  !env.AI_CHAT_BASE_URL ||
  !env.AI_CHAT_MODEL
) {
  throw NotFoundError();
}
```

This makes URL-set-without-MODEL behave exactly like the feature being disabled — consistent with the "indistinguishable from any other unknown route" rule already at `:71-73`. No new error type, no new status.

### 2.2 Boot warning (`server/env.ts:34-47`)

Add a **non-fatal** warning inside the existing `validate(this).then((errors) => …)` block, **before** the `errors.length` exit check:

- when `this.AI_CHAT_BASE_URL` is set and `this.AI_CHAT_MODEL` is not, `console.warn` a clear message (e.g. `"AI_CHAT_BASE_URL is set without AI_CHAT_MODEL; the AI chat route will return 404 until AI_CHAT_MODEL is set."`).
- Follow the file's precedent: `console.warn` (line 43) with the existing `/* oxlint-disable no-console */` header. Do not import `Logger` into `env.ts` (it does not currently, and `env.ts` loads before logging is configured).
- This must NOT call `process.exit`. It must run even when `errors.length === 0`.

Implementation note: the warning is a property check, not a validator, so it does not need a decorator. If the executor prefers to keep it declarative, a `@RequiredWith` decorator is acceptable **only if** it is wired to warn rather than to the global exit path — but the straightforward `if` inside the `then()` is simpler and matches Option (b)'s intent. **Do not** add a decorator that pushes into `errors`, because that triggers the cluster-wide exit this decision rejects.

### 2.3 Tests

- **Do NOT import `env.ts` in a test** — importing it runs the `process.nextTick(() => validate(...).then(... process.exit(1)))` side effect (`:34-47`) and can kill the vitest worker. The route gate is covered by extending `ai.test.ts`'s existing 404 suite (`:131-141`): add a case that enables the workspace preference, sets `env.AI_CHAT_BASE_URL`, sets `env.AI_CHAT_MODEL = undefined`, and asserts the route returns **404** (not 500, not a provider call). Restore env in `afterEach` (already done at `:104-111`).
- The boot warning has no unit test (it is a `console.warn` inside a module-load side effect). Mark it manual-verification-only in the PR: start the stack with URL set and MODEL unset, confirm the warning prints and the cluster **stays up**, and confirm the chat route 404s.
- No `RequiredWith` decorator is added; therefore `server/utils/validators.test.ts` is unchanged by this plan.

### 2.4 Docs + sample

- `.env.sample:294-295`: change the `AI_CHAT_MODEL` comment to state it is **required to enable chat when `AI_CHAT_BASE_URL` is set** (and that leaving it unset makes the route 404, without affecting startup).
- `docs/AI-CHAT.md:88-96`: the "All three are **optional**" sentence and the `AI_CHAT_MODEL` row's Required column (`no`) must reflect: the process boots without it, but the chat route is disabled (404) until it is set. Keep the fail-soft framing — do NOT claim a boot failure.
- `docs/AI-CHAT.md:254-265` ("Fail-soft behavior when env is unset") and `docs/AI-CHAT-DESIGN.md:427-435` table: add the URL-without-MODEL row → boots normally, route 404, boot warning logged.
- Ensure no doc claims `AI_CHAT_MODEL` is rejected at boot (the v1 plan's claim, now withdrawn).

Acceptance for Issue 2:
- URL set + MODEL unset → cluster boots; chat route returns 404; a warning is logged.
- URL set + MODEL set → chat route works unchanged.
- None set → boots, route 404 (unchanged fail-soft).
- Docs/sample never claim a boot failure for this combination.

---

## Issue 3 — scope gate script ceiling (fail-closed, reason-only)

**D2 = A.** The boundary never loosens. The reason string becomes honest so the ceiling is measurable.

### 3.1 Mechanism (`server/routes/api/ai/scope.ts`)

- Add `isUntokenizableScript(normalizedPrompt: string): boolean` with an **exact** predicate (the reviews require implementable-as-written specificity):
  - input is the **normalized** prompt produced by `normalize` (`:68-76`) — state this in the JSDoc; do not pass raw text;
  - count letter characters per whitespace-free script class (`\p{Script=Han}`, `Hiragana`, `Katakana`, `Hangul`, `Thai`, `Khmer`, `Lao`, `Myanmar`) vs all letter characters (`\p{L}`);
  - return `true` when the whitespace-free-script letter count is **≥ 50%** of all letter characters. Document the 50% threshold as the pinned decision; a mixed `"deploy 支付服务"` (4 latin-ish + 4 CJK) is a boundary case — the test below pins which way it falls.
  - Must not fire for space-delimited scripts (Latin/Cyrillic/Greek/Arabic) — covered by the test.
- Insert the branch **inside the existing `try`** (`scope.ts:178-192`), in the false arm of the decision at `:184`:

```
return total > 0
  ? undefined
  : isUntokenizableScript(prompt)
    ? "unsupported script"
    : "no matching document";
```

  - Inside the `try` on purpose: if the helper ever throws, it is caught → `"search failed"` → still fail-closed, and the caller keeps its `Promise<string|undefined>` contract (no 500). If it were outside, a throw would surface as a JSON 500 and regress D1's graceful-refusal intent.
  - The search **must still run** before this branch (it already does — `:179-182` precedes `:184`).
- The decision is provably unchanged: both branches return a truthy string; only `undefined` (grounded) allows the prompt. `isUntokenizableScript` never returns a value that makes a previously-refused prompt pass.

### 3.2 Tests (`server/routes/api/ai/ai.test.ts` grounding suite — there is no `scope.test.ts`)

- **New reason test:** a multi-character Han prompt (e.g. `"支付服务的部署手册在哪里"`) against a workspace with no matching doc → the refusal frame carries `OutOfScopeRefusal` (the user-visible text is unchanged), and the route logs `reason: "unsupported script"`. Assert the log if a spy is available; otherwise assert via a direct `findUngroundedReason` unit call if the test can import `scope.ts` without side effects (it can — `scope.ts` has no module-load side effect).
- **Boundary-intact test:** prove the decision is unchanged — a prompt that DOES retrieve still returns `undefined`. If lexical matching cannot retrieve Han in the deployed `tsquery` config, this test **documents the limitation** and asserts the fail-closed refusal; it must **not** be skipped (the v1 plan's escape hatch is withdrawn).
- **Single-token Han:** pin `"好"` — after `normalize` it is one token of length 1, dropped by `buildProbeQuery` (`word.length < 2`), so the function returns `"no distinctive terms"` **before** the search. Assert that exact reason, so the ceiling is documented: the new reason only covers multi-character whitespace-free prompts.
- **Mixed script:** pin `"deploy 支付服务"` and assert which reason it yields, so the 50% threshold is locked.
- **Throw-safety:** assert that a throwing `searchForUser` still yields `"search failed"` for a Han prompt — proving the helper never runs ahead of the search and a helper throw stays fail-closed.
- **`expectRefused` (`:291-311`)** must be updated (see Issue 1.4) so the refusal payload assertion carries `kind:"refusal"`; the Han tests reuse it.

### 3.3 Ceiling documentation

- `scope.ts` `ponytail:` block (`:148-156`): append the script ceiling beside the OR-precision ceiling.
- `docs/AI-CHAT.md:80-86` note block and `docs/AI-CHAT-DESIGN.md:248-265` ("The ceiling, stated plainly"): add a bullet — the extractor assumes space-delimited scripts; whitespace-free scripts degrade to near-total refusal, now distinguishable in logs as `unsupported script`, and single-token prompts report `no distinctive terms`.

### 3.4 Pre-work probe (record outcome; no skip hatch)

Before finalizing the 50% threshold, run one authenticated round-trip with a Han prompt whose terms exist in a known document and observe whether the search returns hits.
- **Probe ran:** pin the threshold to the observed behaviour; the boundary-intact test asserts real grounding.
- **Probe could not run:** ship the helper with the 50% threshold as documented, and the boundary-intact test asserts the fail-closed refusal and is explicitly labelled in-code as documenting the limitation. Do not silently skip.

Acceptance for Issue 3:
- A non-Latin prompt that cannot retrieve returns `"unsupported script"` (logged), is refused, and the provider is never called.
- The decision path is unchanged: only the reason string differs, and only when `total === 0`.
- `"好"` returns `"no distinctive terms"`; mixed-script behaviour is pinned by a test.
- The ceiling is stated in code and both docs.

---

## TODOs

- [x] 1. Issue 4 — fix `docs/AI-CHAT-DESIGN.md:65-66` mermaid middleware order to `auth → rateLimiter → validate`; leave the already-correct prose at `:118-119` untouched
- [x] 2. Issue 1 — refusal renders as a transcript turn via payload `kind` discriminator: server `ai.ts` `refuseWithSseError` emits `{ error, kind: "refusal" }`; client `aiChat.ts` adds `kind:"refusal"` + `errorKind()`; panel renders refusal inline with an a11y affordance; harden `expectRefused` + add the E2E wire-lock test
- [x] 3. Issue 2 — `AI_CHAT_MODEL` gating (Option b): extend the `ai.ts` 404 gate with `|| !env.AI_CHAT_MODEL`; add a non-fatal `console.warn` boot warning in `env.ts`; add a route-level 404 test; update `.env.sample` + both docs
- [x] 4. Issue 3 — scope gate script ceiling (fail-closed, reason-only): add `isUntokenizableScript()` in `scope.ts`, insert the branch inside the existing `try`; add reason/boundary-intact/single-token/mixed-script/throw-safety tests; record the live-corpus probe outcome; document the ceiling
- [x] 5. Discovered by F4 (needs-fix, all LOW, docs-only): remove the two verbatim-duplicated paragraphs — `docs/AI-CHAT-DESIGN.md:268-275` (duplicate of `:260-267`) and `docs/AI-CHAT.md:96-102` (duplicate of `:88-94`) — and fix the stale mermaid label `docs/AI-CHAT-DESIGN.md:77` (`AiChatError kind=stream` → `kind=refusal`)

## Final Verification Wave

- [x] F1. Automated gates — `yarn test` on `server/routes/api/ai/ai.test.ts`, `app/utils/aiChat.test.ts`, `app/components/AIChat/AIChatPanel.test.tsx`, `app/components/AIChat/AIChatTrigger.test.tsx` all green; `yarn tsc` exit 0; `yarn lint` no new errors
- [x] F2. Wire-contract greps — no `event: refusal` anywhere; the `kind` discriminator produced in exactly one place and consumed in exactly one place; every remaining `event: error` in docs is a genuine mid-stream-failure reference
- [x] F3. No-i18n-drift — confirm zero new `t()` literals and zero edits under `shared/i18n/locales/`
- [x] F4. Independent AdversarialVerify — a verifier context distinct from the implementers re-reads every changed file and re-runs the gates; verdict must be `confirmed`

## Ordering

1. Issue 4 (docs only, zero risk)
2. Issue 1 (user-facing bug; payload `kind` + client branch + the E2E wire lock)
3. Issue 2 (route gate + boot warning; independent)
4. Issue 3 (largest; needs the probe; security-read)

Note: all four touch `docs/AI-CHAT.md` / `docs/AI-CHAT-DESIGN.md` in **different sections**. Land the doc edits issue-by-issue; do not merge them blindly (regions diverge). Issue 1 and Issue 2 share no code files.

## Global verification

- `yarn test:server` → `server/routes/api/ai/ai.test.ts`.
- `yarn test:app` → `app/utils/aiChat.test.ts`, `app/components/AIChat/AIChatPanel.test.tsx`.
  - (`AIChatTrigger.test.tsx` is untouched by this plan — run it only as a smoke check, it must stay green.)
- `lsp_diagnostics` on: `ai.ts`, `aiChat.ts`, `AIChatPanel.tsx`, `scope.ts`, `env.ts`.
- **`grep -rn 'event: error' docs/`** and confirm every remaining occurrence is a mid-stream-failure reference (`AI-CHAT-DESIGN.md:164`, `AI-CHAT.md:226`) **or** explicitly documents the refusal `kind` payload. Nothing in `docs/` may claim the refusal uses an `event: refusal` — that event does not exist in this design.
- `grep -rn 'kind.*refusal\|"refusal"' server/ app/` to confirm the discriminator is produced in exactly one place (`ai.ts` refusal path) and consumed in exactly one place (`aiChat.ts`).
- Confirm no new `t()` literal is introduced (the only refusal `t()` is `ai.ts:107`; already catalogued at `translation.json:1918`). No `shared/i18n/locales/` edits.
- Manual: boot with `AI_CHAT_BASE_URL` set and `AI_CHAT_MODEL` unset → warning logs, cluster stays up, chat route 404s.

## Risks and guardrails

| Risk | Guardrail |
|---|---|
| A cached pre-rename SPA bundle silently drops the answer | Eliminated by NOT renaming the event; the payload `error` is retained so old clients read today's red banner. |
| A server/client payload-key mismatch ships green | The hardened `expectRefused` + the `aiChat.test.ts` E2E test parse the **same literal frame bytes**. |
| Mid-stream failure accidentally tagged as a refusal | `ai.js:196` left byte-identical; mid-stream test asserts no `kind`. |
| Panel fix rendered onto the wrong turn | No second state variable; the refusal writes into the last message's content. |
| Issue 2 hard-fails the cluster | Rejected by decision (b); boot warning is non-fatal; route gate 404s. |
| Issue 3 loosens the gate | Decision line only swaps a reason string; branch is inside the `try`; boundary-intact + throw-safety tests. |
| Issue 3 helper not implementable twice | Exact predicate + pinned 50% threshold + single-token/mixed-script tests. |
| Editing generated i18n JSON | Do not; no new literal. |
| Rate limiting burns budget on refusals | Known interaction: `rateLimiter(TenPerMinute)` runs before the gate, so refusals consume budget and, once refusals look "cheap," users may re-ask into a 429. Out of scope to change here; document it in `docs/AI-CHAT.md` as a known behaviour so it is not a surprise. |
| Refusals accumulate in provider context | Known: `promptText` filters to user turns, so no grounding loop, but assistant refusals are still sent upstream next turn. Out of scope; note in the design doc. |

## Out of scope (deferred to the slice-2 refactor)

`stream.ts` extraction, the OpenAI→AG-UI protocol replacement, the `AIChatContext` module-global (`openHandler`), the `unknown`-typed `parseSSEStream` seam, moving the rate limiter after the grounding gate, and pruning assistant refusals from provider context.

## Withdrawn from v1 (do not implement)

- The `event: refusal` rename (any event rename).
- The `RequiredWith` decorator and any boot exit for a missing `AI_CHAT_MODEL`.
- Swapping the prose order at `AI-CHAT-DESIGN.md:118-119`.
- The `refusedIndex` / `data-refused` panel state.
- The optional route-level test that sets `env.AI_CHAT_MODEL = undefined` to prove a boot failure.
