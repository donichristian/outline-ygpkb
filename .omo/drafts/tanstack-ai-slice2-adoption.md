---
slug: tanstack-ai-slice2-adoption
intent: clear
review_required: false
classification: architecture
status: plan-written
plan_path: .omo/plans/tanstack-ai-slice2-adoption.md
created: 2026-10-16
note: >
  Hand-written draft and plan. This session exposes no shell/exec tool, so the
  skill's scripts/scaffold-plan.mjs could not be run; both artifacts use the
  skill's documented template and header order verbatim.
---

# tanstack-ai-slice2-adoption - draft state (final)

## Working contract

Prometheus / planning consultant. No implementation in this session, and no
implementer subagents. Approval authorizes writing the plan only; execution
starts in a separate worker session (`$ulw-execute`).

## Intent routing

- `intent: clear` - the outcome was specified by `docs/AI-CHAT.md:584-601` and
  confirmed by the owner questions.
- `review_required: false` - no high-accuracy / 고정밀 request. The dual
  high-accuracy review is optional and offered at handoff.
- `classification: architecture`.

## Owner decisions (locked)

| # | Decision | Answer |
|---|---|---|
| D1 | Slice-2 boundary | Transport swap only, keep the rest. TanStack `chat()` + `toServerSentEventsResponse`; client `useChat` + `UIMessage.parts`. KEEP grounding gate, `ai_chat_*` tables, per-session in-flight lock, refusal/busy taxonomy, CSRF. |
| D2 | Persistence | Reuse existing tables; map `sessionId` -> `threadId`; no migration; four RPC endpoints unchanged. |
| D3 | Capabilities in slice | Read-only server tools IN + `reasoning` passthrough IN + message queue IN. |
| D4 | Transcript ownership | Keep the store-merge (`storedTurns + pending`); `useChat` is the frame source only. |
| D5 | Stateless mode | Keep `messages`-only requests working and non-persisted; retire the byte-identical passthrough guarantee explicitly. |
| D6 | Tools vs lock | Keep the per-`(user,session)` lock; release on `RUN_ERROR` too; raise/justify the TTL for multi-round-trip tool runs. |

## Deferred (out of scope, named)

Subagents / `defineAgent` / `SUBAGENT_*`; resumable streams; `@tanstack/ai-persistence`
/ `withPersistence`; client-supplied tools / spread `forwardedProps`; token-usage
capture; a new `finishReason` column; agentic-loop tuning beyond defaults.

## Defaults adopted (reversible internals)

X1 exact version pins. X2 tests-after, colocated, `// @vitest-isolate true` for
mocking server tests. X3 reasoning live-only. X4 no new columns/migration.
X5 `AI_CHAT_GROUNDING` default true. X6 provider key stays server-side.
X7 server-minted `runId` stays the authoritative row-correlation id; the AG-UI
`runId` is transport-only. X8 `apiResponse.ts` unchanged, but every `ai.chat`
exit must assign a node `Readable` (never a bare web `ReadableStream`).
X9 ThinkingParts are filtered out on finalize. X10 refusal/busy are framed as
synthetic complete AG-UI runs.

## Metis gap analysis (mandatory Phase-3 step) - FOLDED

Metis returned 13 findings, 7 contradictions, 5 forgotten affected users. Folded
in silently as follows:

- F1 (wire body becomes AG-UI; parts must flatten) -> new **GAP-9** + todo **8**.
- F2 (refusal/busy have no AG-UI home) -> **D10 default** + todo **6**.
- F3 (`incomplete-stream` reclassifies `truncated`, `onFinish` skipped) -> **GAP-10**
  + todo **3** (gateway probe) + todo **5** (status mapping + lock release).
- F4 (persistence mechanism + persist/lock ordering unspecified) -> todo **5**
  (middleware hooks; persist before end; release after commit).
- F5 (transcript ownership / RPC contract) -> **D4** + todos **9, 10**.
- F6 (stateless byte-identity dropped) -> **GAP-11** + **D5** + todo **7** + doc todo **21**.
- F7 (`runId` authority) -> **X7** + todo **5**.
- F8 (CommonJS vs ESM runtime require, not just types) -> W0 gate todo **2**.
- F9 (`apiResponse` needs no change only if node `Readable`) -> **X8** + todo **4** + a test in todo **19**.
- F10 (ThinkingPart retention vs live-only) -> **X9** + todo **16**.
- F11 (tools loop vs lock/usage not orthogonal) -> **D6** + todos **13, 18**.
- F12 (test/doc rewrite not enumerated) -> todos **19, 20, 21**.
- F13 (no budget/scale constraint) -> constraint sweep below.
- Forgotten affected users folded in: the gateway as a contract dependency (todos 3, 5,
  21, and the Scope affected-user list); RPC consumers (IS-3 + todo 8);
  `AI_CHAT_GROUNDING=false` workspaces (todo 6 keeps the skip branch);
  i18n maintainers (todo 22); the maintainer reading the docs (todo 21).

## Constraint sweep

| Axis | Status |
|---|---|
| Budget / paid spend | defaulted - unchanged from today (no cap beyond the 10/min rate limit); recorded as a documented ceiling in todo 21. |
| Mandated stack | explored - TanStack AI mandated by `docs/AI-CHAT.md:584-601`. |
| Expected scale | defaulted - per-user chat, unchanged. |
| Target audience / compliance | defaulted - internal workspace users; grounding gate stays on. |
| Distribution / packaging | defaulted - three npm packages, exact pins, no new service. |

## Approval gate

The user answered all owner-decisions in-session; answering the open ambiguities
IS the approval. `status: plan-written`.

## Plan artifact

Written to `.omo/plans/tanstack-ai-slice2-adoption.md`.

Structural self-check performed: first `## ` heading is `## TL;DR (For humans)`;
template header order preserved; 22 column-zero `- [ ] N.` implementation rows and
4 `- [ ] F<n>.` verifier rows; every implementation row carries a nested
`Recommended task executor category:` line; no prose heading doubles as a task;
`## Scope` opens with `### Affected user and ideal state`; `## Success criteria`
maps IS-1..IS-9 to todos, QA scenarios, and evidence paths; effort band is one
band (XL).

Effort: **XL** - 22 implementation todos across 7 waves + 4 verifier tasks.

## Dual high-accuracy review

Requested by the user in-session ("invoke momus and oracle"). Degraded intake: no
exec tool in this session, so no SHA-256 — `artifact_identity` is a content
identity (path + first heading + row cardinality 22/4 + band XL) and both lanes
echoed it.

### Round 1 — r1-2026-10-16-tanstack-ai-slice2

| Lane | Launch | Session receipt | Verdict |
|---|---|---|---|
| `momus` | `l1-momus` | `ses_ebc2c58b4ffe1jYjIO34ZLJNjt` (echoed sub-session `ses_ebc6990fdffeBqD70swTl2QZEF`) | CHANGES_REQUESTED |
| `independent` (oracle) | `l1-oracle` | `ses_ebc2c2c1bffeNtfoJDjR7WjSbS` | CHANGES_REQUESTED |

Both lanes drifted clean (path, heading, 22/4 rows matched). Both converged
independently on the same two blockers.

**Accepted blocker ledger (frozen after round 1):**

- **B1 — the refusal/busy `kind` has no AG-UI home.** Category:
  `explicit_requirement_or_accepted_decision` / ideal-state row unreachable.
  Todo 6 framed refusal and busy as plain AG-UI text runs with no discriminator,
  while todo 11 required the client to map a run to `refusal`/`busy` and todo 18
  required the client to know a turn was busy. As written, `refusal`/`busy` were
  unreachable and a busy run could render as a phantom answer.
  **Fix applied:** todo 6 now emits a machine-readable discriminator (`CUSTOM`
  event, or a response header as fallback) carrying `kind: "refusal" | "busy"`,
  and declares it the only signal; todo 11 now derives `refusal`/`busy` from it
  and forbids text/run-id inference.
- **B2 — `finish_reason`-absent branch contradicts the adapter contract.**
  Category: `external_api_provider_or_release_contract_conflict`.
  The adapter converts a missing `finish_reason` into `RUN_ERROR:
  incomplete-stream` and skips `onFinish`, so todo 5's "stream ends without a
  terminal event → `truncated`" was unreachable and todo 19's "add the missing
  `finish_reason`" fixture instruction was impossible when the verdict is absent.
  **Fix applied:** todo 5 maps `RUN_ERROR` with code `incomplete-stream` →
  `truncated` (all other `RUN_ERROR` → `error`), releasing the lock in both cases;
  todo 3 records the adapter's `RUN_ERROR` code; todo 19 asserts the
  `RUN_ERROR`-code path when the verdict is absent.

**Non-blocking notes folded into existing todos (no scope expansion):**

- N1 persist-before-complete ordering unproven → todo 3 now also probes the
  middleware/terminal ordering with a timestamps spike and names the
  `StreamProcessor` fallback for todo 4.
- N2 reasoning response-side mapping unproven → todo 15 now must prove a
  `thinking` part surfaces, or record the finding and re-scope IS-5.
- N3 test non-circularity → todo 19 now replays the real captured gateway bytes
  as a contract test.
- N4 `@tanstack/ai-client` omitted → todo 1 now pins it as the fourth package.
- N5 `AiChatSchema` acceptance not stated → todo 8 now asserts it.
- N6 effort/risk reassessment → recorded; the true top risk is B1 + N1, not the
  two stated spikes. No plan change (W3/W4 parallelisation is an executor choice).

### Round 2 — r2-2026-10-16-tanstack-ai-slice2 (COMPLETE)

| Lane | Launch | Session receipt | Verdict | B1 | B2 |
|---|---|---|---|---|---|
| `momus` | `l2-momus` | `ses_ebc251122ffehDpS231qi3oREe` | APPROVED | RESOLVED | RESOLVED |
| `independent` (oracle) | `l2-oracle` | `ses_ebc24f9cfffexeA3c9Ub3SF4tD` | APPROVED | RESOLVED | RESOLVED |

Both lanes reported: no regressions introduced by the fixes; no new eligible
blockers; handoff-ready. Two rounds of five used (`max_rounds: 5`).

Non-blocking residuals recorded for the executor:

- Round 2 / note 1: no test asserts the missing-`finish_reason` → `status =
  truncated` mapping directly (todo 19's contract test asserts the real-bytes
  `RUN_FINISHED` path). Todo 5's acceptance specifies the mapping, so it is a
  coverage gap, not a broken flow. The executor should add the negative-path
  assertion in todo 19.
- Round 2 / note 2: todo 6 leaves the discriminator channel as `CUSTOM` event or
  response header ("if the client cannot read custom events"). The executor must
  settle that choice at the W1/W2 boundary before todo 11 wires the read.
- Round 2 / note 3: todo 19's contract test is conditional on todo 3's verdict
  being `finish_reason present`; if the verdict is `absent`, that assertion must
  be inverted to the `incomplete-stream → truncated` path.

```json
{
  "review_required": true,
  "plan_path": ".omo/plans/tanstack-ai-slice2-adoption.md",
  "plan_sha256": null,
  "identity_note": "degraded: no SHA-256 (no exec tool in this session). Final live validation repeated at handoff against the content markers; passed.",
  "review_round_id": "r2-2026-10-16-tanstack-ai-slice2",
  "round_status": "complete",
  "rounds_used": 2,
  "rounds_cap": 5,
  "pending-action": "hand off to $ulw-execute; do not execute in this session",
  "review": {
    "momus": { "status": "approved", "launch_id": "l2-momus", "session": "ses_ebc251122ffehDpS231qi3oREe", "verdict": "APPROVED" },
    "independent": { "status": "approved", "launch_id": "l2-oracle", "session": "ses_ebc24f9cfffexeA3c9Ub3SF4tD", "verdict": "APPROVED" }
  },
  "convergence_ledger": {
    "round_1_accepted_blockers": ["B1 refusal/busy discriminator", "B2 incomplete-stream mapping"],
    "round_1_non_blocking_notes": ["N1 persist ordering", "N2 reasoning response mapping", "N3 test non-circularity", "N4 @tanstack/ai-client", "N5 AiChatSchema acceptance", "N6 effort/risk"],
    "round_2_result": "both blockers RESOLVED; no regressions; no new eligible blockers"
  }
}
```

### Round 3 — r3-2026-10-16-tanstack-ai-slice2 (COMPLETE)

Residuals from round 2 closed, then both lanes re-run. Revision markers for this
round: todo 6 contains `X-AI-Chat-Kind: refusal|busy`; todo 5 contains
`incomplete-stream`; todo 19 contains `the negative path`.

| Lane | Launch | Session receipt | Verdict | R2-N1 | R2-N2 | R2-N3 |
|---|---|---|---|---|---|---|
| `momus` | `l3-momus` | `ses_ebc1f3c87ffeK8V14FC2mnk5V1` | APPROVED | RESOLVED | RESOLVED | RESOLVED |
| `independent` (oracle) | `l3-oracle` | `ses_ebc1f25a8ffeVGX7e3Q0GugrTw` | APPROVED | RESOLVED | RESOLVED | RESOLVED |

Fixes that closed the residuals:

- R2-N1: todo 6 now names ONE discriminator channel — the response header
  `X-AI-Chat-Kind: refusal|busy` — with the rationale that a response header is
  library-independent; no `CUSTOM` event. Todo 9 captures the header via a
  `fetchClient` wrapper (the library adapter does not surface headers to
  callers) with an observability test; todo 11 derives `refusal`/`busy` from it.
- R2-N2: todo 19 asserts the negative path — a stubbed no-`finish_reason`
  stream → `RUN_ERROR` code `incomplete-stream` → `status = truncated` + lock
  release.
- R2-N3: todo 19's contract test now states both branches explicitly
  (`finish_reason present` → `RUN_FINISHED`; absent → `RUN_ERROR:
  incomplete-stream` → `truncated`).

### Final state

- Rounds used: 3 of 5. Frozen blockers B1 and B2 intact and RESOLVED.
- Regressions: none. New eligible blockers: none.
- Residual non-blocking notes carried to the executor (do not block):
  (a) `fetchClient` is the named capture mechanism but the exact library symbol
  is unproven in-plan — todo 9's acceptance test is the backstop;
  (b) todo 19's contract test is verdict-conditional and meaningful only after
  todo 3 lands (already gated in W0);
  (c) a real (non-synthetic) run legitimately carries no header → `null`, which
  todos 9 and 11 treat as a normal answer.
- Identity validation: degraded (no SHA-256; no exec tool). Content markers
  re-checked at handoff and matched; both lanes reported NO DRIFT.

```json
{
  "review_required": true,
  "plan_path": ".omo/plans/tanstack-ai-slice2-adoption.md",
  "plan_sha256": null,
  "identity_note": "degraded: no SHA-256 (no exec tool). Content markers re-verified at handoff; matched.",
  "review_round_id": "r3-2026-10-16-tanstack-ai-slice2",
  "round_status": "complete",
  "rounds_used": 3,
  "rounds_cap": 5,
  "final_verdict": "APPROVED by both lanes",
  "pending-action": "hand off to $ulw-execute; do not execute in this session",
  "review": {
    "momus": { "status": "approved", "launch_id": "l3-momus", "session": "ses_ebc1f3c87ffeK8V14FC2mnk5V1", "verdict": "APPROVED" },
    "independent": { "status": "approved", "launch_id": "l3-oracle", "session": "ses_ebc1f25a8ffeVGX7e3Q0GugrTw", "verdict": "APPROVED" }
  }
}
```
