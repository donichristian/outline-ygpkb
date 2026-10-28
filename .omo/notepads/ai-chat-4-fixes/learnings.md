# Learnings

## Issue 1 — refusal kind discriminator (commit f4d789320)

- Payload discriminator beats event rename. Kept `event: error`; added `kind: "refusal"` to the payload. A cached pre-rename bundle still reads `parsed.error` and degrades to the old banner; a future AG-UI/TanStack migration has no `event:` names so an event-keyed discriminator would be discarded.
- Two producers share `event: error` and are separated ONLY by the payload `kind`: refusal carries `kind:"refusal"`, mid-stream failure carries none. `aiChat.errorKind()` returns `"stream"` as the default (malformed/non-JSON/untagged can never become a silent refusal) so the fail-closed direction holds.
- Panel learns it is a refusal at throw time -> no second state variable; the refusal text just becomes the content of the last assistant message, written with the same functional `setMessages` updater used for deltas.
- Empty-bubble guard (`assistant && !content` -> null) needed no change: writing content makes it render.
- a11y: assistant content wrapped in `<span role="status">` so the inline refusal is announced without the red-banner affordance.
- Hardening `expectRefused` from a loose `toContain(OutOfScopeRefusal)` to a byte-exact frame assertion is what prevents the two payload shapes from ever collapsing again. Verified it can fail (broke it -> 5 tests failed/exit 1; restored byte-for-byte-> 20 pass/exit 0).
- Environment: worktree needed `yarn install --mode=skip-build` (~10 min); bash tool injects a CMD-style `set ...` prefix PowerShell cannot parse, so all git/yarn went through temp node scripts + `vcs.mjs`; `core.autocrlf=true` normalizes CRLF so no whitespace churn was committed.

## Issue 4 — docs defects (commit 9e96f957f)

- Three doc-only defects from an independent reviewer, all in `docs/`: a byte-identical duplicate ceiling bullet in `AI-CHAT-DESIGN.md` §4.1, a byte-identical duplicate `>` blockquote in `AI-CHAT.md` "The gate" (the two copies were joined by a `>` blank line), and a stale mermaid label `AiChatError kind=stream` on the REFUSAL path.
- Only the refusal-path mermaid row changed to `kind=refusal`. The `kind=stream` row in the §3.1 failure-modes table and `aiChat.errorKind()`'s default stay `stream` on purpose — mid-stream provider failure is a genuinely different code path.
- Fix the doc by deleting the *second* copy, not the first: the first copy sits in the position the surrounding prose flows into (bullet list → "Cost:" paragraph), so removing the later duplicate keeps markdown structure and reading order intact.
- Verified by grepping the phrase across `docs/` — after the fix it matches exactly once per file. Doc-duplication fixes need no test; grep count IS the check.
- `git status --porcelain` before staging confirmed only the two docs files were dirty; the worktree carried no unrelated churn from the earlier test install.
