# Issues — tanstack-ai-chat

Problems and gotchas encountered during work on this plan.

_Auto-scaffolded by /ulw-execute. Append new entries below - never overwrite._

---

## 2026-10-12 — Delivery receipt (slice 1)

| Field | Value |
|---|---|
| PR | https://github.com/donichristian/outline-ygpkb/pull/7 |
| Base / head | `development` <- `feat/ai-chat` |
| Merged at | 2026-10-12T06:28:25Z by `donichristian` |
| Merge commit | `b8488010e77b8ea8049a7efdf36dc717c0343cf9` |
| Merge method | **merge commit** (`gh pr merge --merge`) |
| Branch head merged | `d36d4e4c1836c939716e64f5be0ae9c8a3cb07db` |
| Remote branch | `feat/ai-chat` still on origin, NOT deleted |

### CI status: absent, not pending
Actions has never run in this repo, so the merge relied entirely on the recorded local
gates (`yarn tsc --incremental false`, `yarn oxlint`, `yarn test` = 51 passed / 1 skipped,
plus the live Koa SSE contract). Evidence:

- `gh pr checks 7` -> `no checks reported on the 'feat/ai-chat' branch`, exit 1
- check-runs on `d36d4e4c1` -> `total_count: 0`
- Actions runs on `development` -> `0`; repo-wide -> `0`
- 10 workflow files exist on disk (incl. `ci.yml`) but none has ever executed —
  Actions is disabled on this fork. Do not mistake this for a passing build.

### Gotcha: `gh` resolves to the `upstream` remote
`gh` picks `outline/outline` over `donichristian/outline-ygpkb` because both remotes are
configured. Consequences:
- `gh pr create` without `--repo` fails with a misleading
  `donichristian does not have the correct permissions to execute CreatePullRequest`
  (it is trying to create the PR upstream).
- `gh pr view 7` without `--repo` silently returns **outline/outline PR #7** — a real,
  unrelated, already-merged PR. Always pass `--repo donichristian/outline-ygpkb`.

### Gotcha: the git shim ignores the bash tool's `workdir`
`C:\Users\Media\AppData\Local\Temp\opencode\vcs-ai.mjs` hardcodes
`cwd = outline-ygpkb-aichat` (line 3). Passing the shared checkout as `workdir` changes
nothing. Use `vcs.mjs` (same dir, cwd = `outline-ygpkb`) for shared-checkout operations.

### Worktree removal: PARTIAL — directory still on disk
`git worktree remove` run *from inside* the worktree deregistered it (the `.git/worktrees`
admin entry is gone and `git worktree list` no longer lists it) but then failed to delete
the directory: `error: failed to delete '.../outline-ygpkb-aichat': Invalid argument`.

Cause: a live dev stack is rooted inside that directory and actively writing to it —
PID 7408 `nodemon`, 19788 `concurrently`, 10748 `vite`, 19292/22472/9536 `build:server` ->
`build.js` -> `swc`, all launched from `outline-ygpkb-aichat/node_modules`. Windows refuses
to unlink open files.

Not force-deleted, deliberately:
- those processes were not in the do-not-touch list but were not authorised either;
- the orphan still holds untracked `.omo-qa/` QA evidence that git no longer tracks
  (see commit `8fd769f41 chore(ai): stop tracking .omo-qa QA artifacts`).

Nothing is lost. `feat/ai-chat` is intact locally and on origin at `d36d4e4c1`, and
`merge-base --is-ancestor d36d4e4c1 origin/development` exits 0.

**Remaining step for a human:** stop the aichat-rooted dev stack (PIDs 7408, 19788, 10748,
19292, 22472, 9536, 20892, 21148), then
`Remove-Item -Recurse -Force D:\Work-Project\Outline-YGPKB\outline-ygpkb-aichat`.
~1.1 GB / 107,513 files. Do NOT kill PID 14744 (:3050) or PID 21108 (:20127) —
those belong to another agent.

### Final tree state
- Shared checkout `D:\Work-Project\Outline-YGPKB\outline-ygpkb`: on `development` at
  `b8488010e`, working tree clean, single registered worktree.
- Orphan directory `D:\Work-Project\Outline-YGPKB\outline-ygpkb-aichat`: no git metadata,
  not a worktree, still on disk.

## Cleanup receipt — 2026-10-12

Post-merge cleanup of the orphan worktree. The "Remaining step for a human" note above
is now **done**.

**Evidence preserved.** `.omo-qa/` copied out before any destructive step:
- Source `D:\Work-Project\Outline-YGPKB\outline-ygpkb-aichat\.omo-qa` (now deleted)
- Destination `D:\Work-Project\Outline-YGPKB\outline-ygpkb\.omo-qa`
- Destination did not exist beforehand, so this was a clean copy with no merge needed.
- **49 evidence files, 498,465 bytes** copied; per-file comparison against the source
  gave 0 missing, 0 extra, 0 size differences. Plus a new `PRESERVED.md` provenance
  note, so the destination holds 50 files / 499,099 bytes.
- The source was measured at 496,604 bytes on arrival and had already grown to 498,465
  by the first copy — the dev stack was still appending to its own logs. Re-copied
  after the processes were stopped to capture the final tails, then re-verified.

**Gotcha worth remembering:** `Copy-Item -LiteralPath $src -Destination $dst -Recurse
-Force` *nests* rather than merges when `$dst` already exists — the second sync
produced `dst\.omo-qa\.omo-qa` and the file count read 99 instead of 50. Check for a
nested duplicate after any second copy. Copy to a non-existent destination, or sync
file-by-file, when the target may already exist.

**Processes stopped** (all ten still alive when we started; none had self-exited):
leaf nodes `7408` nodemon, `19788` concurrently, `10748` vite, `20892` yarn
dev:backend, `21148` yarn vite:dev; parents `14592`, `21336` (node), `18788`, `20748`,
`21156` (cmd). All confirmed GONE after `Stop-Process -Force`.
Note `21336` was `node`, not `cmd` as the earlier note assumed.

**Protected processes survived**, checked both before and after the deletion:
- PID `21108` (:20127) — ALIVE, still LISTENING on 20127.
- PID `12064` (:3051) — ALIVE, still LISTENING on 3051.
- Port `3052` (the worktree's vite) — FREE.

**Worktree directory deleted.** `Remove-Item -LiteralPath ... -Recurse -Force`
succeeded on the first attempt, no `\\?\` long-path prefix and no read-only clearing
needed once the processes released their files. `Test-Path` returns `False`.

**Final shared-checkout state:** `development` @ `b8488010e`, working tree clean,
`origin/development` also `b8488010e` (untouched), `worktree list` shows exactly one
entry. `.omo/` in the shared checkout was left intact. No commits, no fetches, no
branch moves.

## Branch prune receipt — 2026-10-12

Local branch deleted, remote branch confirmed still present.

- `merge-base --is-ancestor d36d4e4c1836c939716e64f5be0ae9c8a3cb07db development`
  -> exit **0** (re-proved the safety net immediately before deleting anything).
- `git branch -d feat/ai-chat` (the **safe** form, never `-D`) ->
  `Deleted branch feat/ai-chat (was d36d4e4c1).` Git accepted it, consistent with the
  ancestor check.
- `git remote prune origin` -> **no output**: there were no stale remote-tracking refs to
  remove. Harmless no-op.
- Remote branch confirmed intact on GitHub:
  `gh api repos/donichristian/outline-ygpkb/branches/feat/ai-chat` ->
  `feat/ai-chat d36d4e4c1836c939716e64f5be0ae9c8a3cb07db`, exit 0.
- Local remote-tracking ref `origin/feat/ai-chat` also survived the prune — correct,
  since `remote prune` only drops refs whose remote branch no longer exists.

Protected branches unmoved:
- `development` / `HEAD` / `origin/development` all `b8488010e77b8ea8049a7efdf36dc717c0343cf9`
- `origin/main` `eaac31aa23e773e39553bad96475d36f3bf14a5a`
- `status --short` empty; `worktree list` shows exactly one entry.

### Gotcha: `gh api` args get mangled by the bash tool
`gh api repos/... --jq '.name + " " + .commit.sha'` failed with
`accepts 1 arg(s), received 2` — the harness prepends a bash env block that PowerShell
5.1 mis-parses, splitting the positional endpoint and the `--jq` value. `Get-Command gh`
confirms a real `gh.exe`, so this is a shell-quoting problem, not a gh problem.
**Workaround:** put the call in a temp `.ps1`, call `gh api <endpoint>` with no flags,
pipe stdout through `ConvertFrom-Json`, and print `$LASTEXITCODE` alongside the value so
a 404 is still distinguishable from a shell error.

`vcs.mjs` (git) was unaffected throughout — route git through it, and only gh needs the
`.ps1` detour.
## Fix receipt: AI chat panel Send button not reachable (slice-1 transport spike)

**Status:** fixed, left uncommitted in the working tree. Only `app/components/AIChat/AIChatPanel.tsx` is modified.

### Defect 1 (the reported one) - nested scroller + unshrinkable flex child
Two stacked causes, both confirmed by reading the components rather than guessing:

1. `SidebarLayout` defaults `scrollable = true` (`app/scenes/Document/components/SidebarLayout.tsx:34`), so
   the panel body was wrapped in a `Scrollable` whose height is content-driven. The panel's own
   `height: 100%` `Container` therefore resolved against an auto-height parent and did nothing.
2. `Transcript` (`styled(Scrollable)`) had `flex: 1` but no `min-height: 0`. A flex item defaults to
   `min-height: auto` and refuses to shrink below its content height, so the transcript grew with the
   message list while `Container`'s `overflow: hidden` clipped the composer out of the reachable area.

Height chain verified by reading the components, not assumed:
`Aside` -> `Position` is `position: fixed; top: 0; bottom: 0; display: flex; flex-direction: column`, so it
has a definite height; `ErrorBoundary` returns `this.props.children` with no DOM wrapper, so `Header` and
`Container` are direct flex children. Mobile path: `Drawer`'s `StyledContent` is fixed `bottom: 0` with
`max-height: 90vh`, and `StyledInnerContent` is a `height: 100%` flex column, so that chain also resolves.
No extra height hack was needed anywhere.

Precedent for `scrollable={false}` already exists in the same sidebar: `Comments.tsx:219` and
`History.tsx:258`.

### Defect 2 (found only by looking at it) - Send button visible but unclickable
After fixing defect 1 and rendering the panel, the button still could not be clicked with a real mouse
(`trustedMouseClickStartedStream=false` at every viewport, while `el.click()` worked).
`document.elementFromPoint` at the button centre returned the `TEXTAREA`, not the button.

Cause: `Input`'s root `Wrapper` (`app/components/Input.tsx:81-94`) sets
`flex: ${props.flex ? "1" : "0"}`, i.e. `flex-basis: 0%` with `flex-grow: 0`. `Composer` is
`flex-direction: column`, so the main axis is height and the wrapper collapsed to **height 0** (measured
`formChildren[0].rect.h === 0`). Its inner `Outline` is `position: relative`, so it painted in the
positioned layer, above the static button row, and the textarea visually covered the Send/Stop button.

Fix, local to the panel: `Composer > * { flex: 0 0 auto; }` so both children size to their content.
Deliberately not fixed in `Input.tsx` - `flex: 0` is relied on by other callers and widening the blast
radius was out of scope here. **ponytail:** if a third composer-like column reuses `Input` directly,
promote the rule into `Input`'s `Wrapper`.

### Exact change
- `AIChatPanel.tsx:147` - `<SidebarLayout ... scrollable={false}>`
- `Container` - explicit `min-height: 0` (already inherited from `Flex`, made explicit)
- `Transcript` - `min-height: 0`
- `Composer` - `> * { flex: 0 0 auto; }`

Nothing else touched. No streaming, error-handling or submit logic changed. `Composer`'s existing
`flex-shrink: 0` was kept.

### Verification evidence
- `yarn tsc --incremental false` -> exit 0.
- `yarn vitest run app/components/AIChat/AIChatPanel.test.tsx` -> 5 passed.
- `yarn oxlint app/components/AIChat/AIChatPanel.tsx` -> exit 0, no output. LSP diagnostics clean.
- Real browser render: headless Chrome over the DevTools Protocol, with the harness mounting the real
  `AIChatPanel` inside the real `SidebarLayout`/`Aside` on the running Vite dev server (`:3051`), driven
  with **trusted** mouse clicks at 1440x600, 1440x1000 and 390x844 (mobile drawer). Measured per state:
  - Send button `visible=true` and fully inside the viewport in empty, typed and populated states.
  - Send disabled while the input is blank, enabled once typed.
  - `elementFromPoint` at the button centre now returns the button, not the textarea.
  - A trusted mouse click starts the stream at all three viewports; Stop correctly replaces Send mid-stream.
  - Regression case: with ~230k px of accumulated transcript (`scrollHeight` 229710 vs `clientHeight` 406
    at 600 px tall), the composer stays pinned at the panel bottom and stays visible.
  - `document.scrollWidth === innerWidth` in every state -> no horizontal scrollbar.
  - Composer bottom sits exactly at the viewport bottom at 600 px and 1000 px.

Screenshots and `results.json`: `C:\Users\Media\AppData\Local\Temp\opencode\aichat-shots\`.
The temporary render harness (`__verify_aichat.html` + `__verify_aichat.tsx` at repo root) was deleted;
`git status` shows only the one modified file.

### Method notes for the next person
- No Playwright/Puppeteer in this repo. Drove Chrome headless over the DevTools Protocol using Node 22's
  global `WebSocket` - zero dependencies added. Chrome is at
  `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`.
- Vite `base` is `/static/` and there is **no root `index.html`**. A harness HTML must therefore be served
  at `/static/<name>.html` and its script tag written as `src="/<name>.tsx"` (bare absolute path). Writing
  `src="/static/<name>.tsx"` gets rewritten to `/static/static/...` and 404s silently.
- The harness must supply `window.env` before any module runs (the app server injects it into the real
  page; the Vite dev server does not). Scrape `window.env = {...};` out of `http://localhost:3050/` and
  inject it with `Page.addScriptToEvaluateOnNewDocument`.
- Minimal provider set to mount this panel: `Provider rootStore` -> `Router` (`Theme` needs it via
  `useQuery`/`useLocation`) -> `Theme` -> `ActionContextProvider` (`Button`/`ActionButton` needs it) ->
  `LazyMotion`.
- Cold Vite transform of this dependency graph exceeds 20 s on first load; budget 90 s for the first wait.

### Config state check (read-only)
**`.env.development` does NOT contain any `AI_CHAT_*` variables.** The file is 13 lines and internally
consistent - 7 assignments plus 3 comment lines and blank separators. No key is truncated and there is no
duplicate block, so the interrupted write did not damage this file.

The `AI_CHAT_*` trio actually lives in **`.env.local`** (35 lines), where it is complete:
`AI_CHAT_BASE_URL` (value length 25), `AI_CHAT_API_KEY` (value length 35), `AI_CHAT_MODEL` (value length 7)
at lines 29/32/35, no duplicates, no quoting. Names and lengths only - the key value was deliberately not
recorded here. Nothing was modified.

## Commit receipt: floating AI chat trigger (2026-10-13)

| Field | Value |
|---|---|
| Commit | `364d9e47c` |
| Branch | `development` (pushed: **no**) |
| Subject | `feat(ai): floating AI chat trigger and panel layout fix` |
| Files | 4 — `AIChatPanel.tsx` (M), `AuthenticatedLayout.tsx` (M), `AIChatTrigger.tsx` (A), `AIChatTrigger.test.tsx` (A) |
| Diff | 220 insertions, 1 deletion |
| Tree after | `git status --short` empty |

### Gates
- `vitest run app/components/AIChat/AIChatTrigger.test.tsx --project app` -> **4 passed**, exit 0.
- `yarn tsc --incremental false` -> **exit 0**, zero errors repo-wide.
- `yarn oxlint` on the 4 files -> exit 0. Only the pre-existing `react(refs)` warning at
  `AuthenticatedLayout.tsx:109` (PortalContext `layoutRef.current`), untouched by this work.

### Defect found and fixed during verification
The `~/components/Button` mock in `AIChatTrigger.test.tsx` **hardcoded**
`style={{ position: "fixed", right: 24, bottom: 24 }}`, so
`expect(button?.style.position).toBe("fixed")` was asserting the mock, not `AIChatTrigger`.
A vacuous pass. The mock now forwards `style` verbatim, and the assertion was extended to
`position` / `right` / `bottom` / `zIndex` (`depths.sidebar - 1` = 899). With `style` forwarded,
an omitted `style` yields `""` and the test fails, so the assertion is non-vacuous.

Confirmed `style` genuinely reaches the DOM in production code, not just through the mock:
`AIChatTrigger` -> `Button` (does not destructure `style`, so it stays in `...rest`, `Button.tsx:180`)
-> `RealButton = styled(ActionButton)` (`Button.tsx:18`, styled forwards `style` + `data-*`)
-> `ActionButton` -> `<button {...rest} />` (`ActionButton.tsx:37,56`). Inline `style` outranks the
styled-components class, so `position: fixed` wins. **No `styled(Button)` wrapper needed.**

### Visual verification: NOT DONE — do not assume the trigger was seen working
No screenshot was taken and none exists. The floating trigger itself has **no browser evidence**.

Blocked: `browser-doctor.mjs` returned `no-cli`. `browser-install.mjs --browser=chrome` installed
the CLI (0.3.2) and registered the extension, but the daemon still reports
`Windows named-pipe discovery is not implemented` and Chrome must be told to enable the extension
by hand. Not a code problem.

**Remaining step for a human:** in Google Chrome, open the toolbar menu and enable "BrowserSkill".
Then re-run the doctor. Only after that can the trigger be screenshotted.

Unverified assumptions still standing: `TeamPreference.AIChat` was **never confirmed ON** — `psql`
is not on PATH, so the preference was never read from the dev DB. The trigger's `useAIChatPanel()`
gating is covered by unit tests only.

The **panel layout fix** is a separate matter and *does* have real evidence: 12 screenshots and
`results.json` in `C:\Users\Media\AppData\Local\Temp\opencode\aichat-shots\` (see the slice-1 receipt
above). Do not transfer that confidence to the trigger.

### Environment notes
- `yarn test <file>` is unusable on Windows: the script is `TZ=UTC vitest run` and the POSIX prefix
  breaks under PowerShell, and yarn reports a misleading
  `ESM syntax in a file loaded as CommonJS (vitest.config.ts:1:1)` error. That message is a **Vite
  config-loader warning on stderr, not a failure** — exit code is what matters. Working form:
  set `$env:TZ = "UTC"` in a temp `.ps1` and call `yarn vitest run <file> --project app`.
- The bash tool returns mangled/grep-formatted output for `yarn` invocations. Put every multi-step
  command in a temp `.ps1` and run it with `powershell -NoProfile -ExecutionPolicy Bypass -File`.

---

## 2026-10-13 — Can-fail receipt: `AIChatTrigger.test.tsx`

Proved the 4-test suite can fail, then restored the tree byte-identically. Working tree was
clean before and after; HEAD stayed `364d9e47cbacb3a8561ec49c7371e14eac1df87a`. No commit,
amend, or push.

Command used for every run (temp `.ps1`, `yarn` output captured to a file because the bash tool
mangles it):

```powershell
Set-Location "D:\Work-Project\Outline-YGPKB\outline-ygpkb"
$res = yarn test app/components/AIChat/AIChatTrigger.test.tsx 2>&1
$code = $LASTEXITCODE
Set-Content -Path $out -Value (($res | Out-String) + "`nEXIT=$code") -Encoding UTF8
```

| Stage | Mutation | Result | EXIT |
|---|---|---|---|
| Baseline | none | `Test Files 1 passed (1)` / `Tests 4 passed (4)` | 0 |
| Mutation A | test line 108 -> `expect(button?.style.zIndex).toBe("12345")` | 1 failed / 3 passed | 1 |
| Mutation A revert | assertion back to `String(depths.sidebar - 1)` | — | — |
| Mutation B | `style={{...}}` prop removed from `<Button>` in `AIChatTrigger.tsx` | 1 failed / 3 passed | 1 |
| Restore | `node vcs.mjs checkout -- app/components/AIChat/AIChatTrigger.tsx` | `git status --short` empty | 0 |
| Final | none | `Tests 4 passed (4)` | 0 |

Mutation A failure text:

```
FAIL  |app| app/components/AIChat/AIChatTrigger.test.tsx > AIChatTrigger > renders the trigger button when AI chat is enabled and panel is closed
AssertionError: expected '899' to be '12345' // Object.is equality
Expected: "12345"
Received: "899"
```

Mutation B failure text — the vacuity proof:

```
FAIL  |app| app/components/AIChat/AIChatTrigger.test.tsx > AIChatTrigger > renders the trigger button when AI chat is enabled and panel is closed
AssertionError: expected '' to be 'fixed' // Object.is equality
- Expected
+ Received
- fixed
```

Empty string means the inline `style` never reached the DOM, i.e. the assertion reads
`AIChatTrigger`'s output. Under the old hardcoding mock this same mutation would have passed.
Non-vacuous, confirmed empirically.

### Corrections to earlier notes in this file
- `yarn test <file>` **does** work on this Windows box (the `TZ=UTC` prefix concern above did not
  reproduce; `corepack` yarn ran it fine). Only the Vite `ESM syntax in a file loaded as CommonJS`
  stderr warning appears, and it is noise — trust `$LASTEXITCODE`.
- To restore a mutated file byte-exactly, prefer
  `node vcs.mjs checkout -- <path>` over piping `git show` output back through
  `Out-String`; the latter reintroduces CRLF endings and leaves the file showing as modified.

---

## Delivery receipt: AI chat trigger PR (2026-10-13)

| Field | Value |
|---|---|
| PR | https://github.com/donichristian/outline-ygpkb/pull/8 |
| Base / head | `development` <- `fix/ai-chat-trigger-layout` |
| Title | `feat(ai): floating AI chat trigger and panel layout fix` |
| Branch head merged | `fad6382f72b499c79272ba7a6c5cf72177b92b00` |
| Merge commit | `e3a8c8077064258cb26fa1603b74aeb81e357047` |
| Merge method | **merge commit** (`gh pr merge --merge --match-head-commit fad6382f7`) |
| Merged at | 2026-10-13T01:59:17Z by `donichristian` |
| Branch | deleted locally (`-d`) **and** on origin (`push --delete`) |

`rev-list --parents` on the merge commit gives
`e3a8c8077 b8488010e fad6382f7` — two parents, matching the existing `development`
pattern (`b8488010e` for PR #7, `eaac31aa2` for PR #5). No squash.

### CI status: absent, not pending (same as slice 1)
- `gh pr checks 8` -> `no checks reported on the 'fix/ai-chat-trigger-layout' branch`, exit 1
- `gh run list --repo donichristian/outline-ygpkb` -> empty, exit 0. Zero workflow runs
  ever on this fork.
- Merge therefore relied **entirely on local gates**, re-run on the branch before push:
  `yarn tsc --incremental false` -> exit 0; `yarn test app/components/AIChat/AIChatTrigger.test.tsx`
  -> `Test Files 1 passed (1)` / `Tests 4 passed (4)`, exit 0. Do not read the merge as
  CI-backed.

### Gotcha: `364d9e47c` can never be an ancestor of `origin/development`
The delivery instructions asked for both of these, and they are mutually exclusive:
1. build the branch by **cherry-picking** `364d9e47c` onto `origin/development`, and
2. assert `merge-base --is-ancestor 364d9e47c origin/development` exits 0.

A cherry-pick writes a **new** commit object (`fad6382f7`, same tree, same author/date,
new committer/date -> different SHA). `364d9e47c` only ever existed on the local
`development` branch and was never pushed, so no merge can ever make it an ancestor of
anything on origin. `merge-base --is-ancestor 364d9e47c origin/development` exits **1**,
and that is correct, not a delivery failure.

The substantive intent — *the fix content is on `development`* — is verified instead:
- `merge-base --is-ancestor fad6382f7 origin/development` -> exit **0**
- `git diff 364d9e47c origin/development --stat` -> **empty**
- `rev-parse 364d9e47c^{tree}` == `rev-parse origin/development^{tree}`
  == `88447a6bd957888c723f034717b83dfe7ba28a9e`

**For future deliveries:** pick one. Either push the original SHA (no cherry-pick, then
the ancestor check works and a plain `merge --ff-only` syncs local `development`), or
cherry-pick and verify by tree SHA / empty diff instead of by original-SHA ancestry.

### Gotcha: `merge --ff-only` fails; align with `reset --hard`
Because `364d9e47c` was never pushed, local `development` and `origin/development`
**diverged** (1 local commit vs 2 remote), so `git merge --ff-only origin/development`
died with `fatal: Not possible to fast-forward, aborting.` Local `development` was put on
the merge commit with `git reset --hard origin/development`. Safe here *because the trees
were proven identical* (same tree SHA above) — nothing was lost, and `364d9e47c` remains
in the reflog. Never do this without that tree check first.

### Shell gotchas hit this run
- `node vcs.mjs rev-parse 364d9e47c^{tree}` is mangled by the harness — the `^{...}` is
  PowerShell-parsed into junk (`ambiguous argument 'dAByAGUAZQA='`). **Quote it**:
  `rev-parse "364d9e47c^{tree}"`.
- The bash tool also renders `yarn test` output as a grep-style summary with no exit
  code. Capture to a file from a temp `.ps1` and grep the log for `Test Files`/`Tests`.

### Final tree state
- Shared checkout `D:\Work-Project\Outline-YGPKB\outline-ygpkb`: on `development` at
  `e3a8c8077`, in sync with `origin/development`, `git status --short` empty.
- `fix/ai-chat-trigger-layout` gone locally and on origin. `git branch -a` lists only
  `development`, `main`, `origin/development`, `origin/feat/ai-chat`, `origin/main`.
- `origin/feat/ai-chat` **preserved** (`d36d4e4c1`) as before — deliberately not pruned.
- No source file was modified during this task; no `.env*` file was staged, committed, or
  printed. No process was killed.

---

## 2026-10-13 — Single-line AI chat composer (replaces the auto-growing textarea)

Changed `app/components/AIChat/AIChatPanel.tsx` + its test, on `development`.

### What changed
- Composer input `type="textarea"` -> `type="text"`; dropped `autoSize` / `minHeight` /
  `maxHeight` (textarea-only props).
- `Composer` `flex-direction: column` -> `row`, `align-items: center`. The `<Flex>` wrapper
  around the Send/Stop button was removed so the button is a direct flex child; `gap: 8` and
  `flex: 0 0 auto` on the Composer cover it. `data-testid` values unchanged.
- Added `margin={0}` on the `Input`. `Outline` defaults to `margin: 0 0 16px`, which in a
  centred row pushed the input off-centre.
- Plain Enter now sends, handled locally via a new `onKeyDown` on `Input`.

### The Enter trap, and why no shared-component change
`Input.tsx` `handleKeyDown` fires `onRequestSubmit` only on
`ev.key === "Enter" && ev.metaKey`, and **returns early** in that branch. So:
- Cmd+Enter -> `onRequestSubmit` -> `requestSubmit()`. `props.onKeyDown` is NOT called.
- plain Enter -> falls through to `props.onKeyDown` -> the panel's own handler.

That early `return` is what guarantees the two paths cannot double-submit synchronously.
`ev.preventDefault()` stops the browser's implicit form submission on Enter, which would
otherwise submit a second time. `Input.tsx` itself is untouched.

### Flex-layout reasoning (the `Wrapper` trap, now on width)
`Input`'s root `Wrapper` carries `flex: 0` -> `flex-basis: 0%`. In the old **column** layout
that collapsed the box to zero *height* — commit `364d9e47c`'s unclickable-Send bug. In a
**row** the same declaration collapses it to zero *width* instead, and the old
`> * { flex: 0 0 auto; }` fix made that worse, not better.

Fix, with a comment left in the styled component:
```
> :first-child { flex: 1 1 auto; min-width: 0; }   /* input wrapper */
> :last-child  { flex: 0 0 auto; }                /* Send/Stop */
```
Specificity of `Composer.class > :first-child` is (0,2,0), beating `Wrapper`'s bare class
(0,1,0), so the override wins. `min-width: 0` is needed too: `Wrapper` sets
`min-width: initial`, which on a row flex item is the *automatic minimum size* (min-content),
so the input would refuse to yield space to the button. `RealButton` already has
`flex-shrink: 0`.

Nothing in the input is absolutely positioned; `Outline` is `position: relative` and in normal
flow, so nothing can paint over the button now that it occupies real width.

### Tests
`AIChatPanel.test.tsx`: `typeMessage` retargeted from `HTMLTextAreaElement.prototype`'s value
setter to `HTMLInputElement.prototype`'s (the control is now an `<input>`); added a
`pressEnter` helper dispatching a `keydown` `Enter` with no metaKey; added "sends the message
when Enter is pressed in the prompt", asserting `streamAiChat` called once and a
`message-user` node carrying the text.

- `yarn test app/components/AIChat/AIChatPanel.test.tsx` -> **6 passed (6)**, exit 0.
- Can-fail proof: mutated `ev.key === "Enter"` -> `"Escape"`, re-ran ->
  `AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times`,
  `Tests 1 failed | 5 passed (6)`, exit 1. Only the new test failed. Reverted, re-ran -> 6/6.

### Gotcha: `git checkout -- <file>` reverts the WHOLE file, not the mutation
Using it as the can-fail-proof revert wiped the entire uncommitted feature — all three source
edits had to be re-applied. For a can-fail proof on uncommitted work, revert only the mutated
line with the Edit tool. `checkout --` is only safe when the file's committed state already
contains the feature.

### Verification status
- Verified: unit tests 6/6, can-fail proof, `yarn tsc --incremental false` exit 0,
  `oxlint` 0 warnings / 0 errors across `app/components/AIChat/`.
- NOT verified: no visual check. Browser automation is broken on this machine
  (`Windows named-pipe discovery is not implemented`). The layout above is reasoned from the
  CSS, not observed in a rendered browser, and `elementFromPoint` at the button centre was not
  exercised. Needs a manual look at the composer in a live panel.

### Commit
`fix(ai): use a single-line prompt input in AI chat` on `development`, 2 files staged, not
pushed. No `.env*` file staged or printed. No process killed.

---

## KB scope gate (server-side) — `4b9465113`

Hermes `matius` carries the KB-only boundary as prompt text (SOUL.md + `guidanceMCP`) and
honoured it in 3 of 5 probes; the other 2 leaked `Paris.`. Prompt text is not a boundary.

### Policy chosen and why

**Pre-flight deterministic classifier, fail-open** (`server/routes/api/ai/scope.ts`), applied to
**user messages only** before the `fetch` to `${AI_CHAT_BASE_URL}/chat/completions`.

Considered and rejected:

- **Post-hoc citation check** (option b) — cannot satisfy the requirement: it consumes the
  upstream call, so `"What is the capital of France?"` still pays the latency. Also **not
  tractable here**: no sample Hermes answer exists in the repo or the notepad, the profile lives
  outside this checkout, and a mis-anchored grounding check would silently suppress *every*
  legitimate KB answer. That failure is worse than the advisory leak and is unverifiable while
  browser automation is broken on this host. Left as the named upgrade path.
- **Allow-list of KB tokens** — rejects real KB questions ("how do I reset the VPN") far more
  often than it catches probes. Worse than useless; not shipped.
- **KB full-text grounding against team documents** — semantically the right rule, but the
  false-reject rate on paraphrased questions is unknown and unbounded, and it would add a DB
  read to a route that currently does none. Noted as upgrade path, not shipped.

Chosen: a **narrow deny-list** of parametric-memory probe shapes (16 patterns: `capital of`,
`population of`, `who is the president`, `recipe for`, `weather in`, `write me a poem`, …).
Denial, never denial-by-absence — the gate never rejects a prompt for *lacking* a KB signal, so
ordinary KB questions cannot be caught by it.

Normalization defeats case, whitespace runs, tabs, fullwidth characters (NFKC) and
zero-width/soft-hyphen marks; each probe is matched twice (word-spacing tolerant and fully
compacted) so `c a p i t a l   o f` is caught.

### Stated ceiling (also in a `ponytail:` comment in `scope.ts`)

- **False negative** — an off-topic prompt phrased outside the 16 shapes still reaches the
  provider, which leaks from memory ~40% of the time. This is a latency filter, not a boundary
  on output.
- **False positive** — a real KB question sharing a shape is refused
  ("What is the capital city of our Jakarta office?"). Documented fail-closed choice: the gate
  cannot tell it apart from the probe, and refusing a genuine question beats leaking one.
- **No rescue rule** — deliberately none. A KB anchor in the prompt does not override a match,
  because "see the travel policy doc" would otherwise be a one-phrase bypass.
- **Not defeated**: empty input (early `"empty prompt"` return), whitespace-only, and a
  conversation with no user message.
- Assistant messages are excluded from classification so a leaked phrase echoed into the
  transcript cannot lock the conversation permanently.

### Refusal channel

Reused the route's existing in-band error frame (`sseFrame({ error }, "error")` via a new
`refuseWithSseError` helper, headers shared with the streaming path through `setSseHeaders`).
Verified by reading the client rather than assuming: `app/utils/aiChat.ts` `parseFrame` throws
`AiChatError(message, "stream")`, and `AIChatPanel.errorText` falls through to `error.message`
for that kind — so the refusal renders as readable text. **No client change was needed or
made.**

`setSseHeaders` extracted and reused in the existing stream path — same three headers, no
behaviour change.

### Translation

Message is `t(OutOfScopeRefusal)` using the server-side `i18next` convention already used in
`server/presenters/unfurl.ts`; the English text is its own key. **Gap reported, not worked
around:** the key will only exist in the locale files after `yarn build:i18n`, which fails on
Windows (`command not found: mkdir`). Until it runs somewhere, `t()` returns the key — correct
English, untranslated. Locale JSON was not hand-edited. A later `build:i18n` on a POSIX host
picks it up with no further change.

### Verification

- `yarn test server/routes/api/ai/ai.test.ts` → **17 passed**, exit 0 (was 9). Covers: off-topic
  refused with `fetchMock` **not** called; near-miss refused (documented fail-closed policy);
  case/tabs/spacing variant refused; whitespace-only refused; assistant-only conversation
  refused; empty string still 400 at the schema; on-topic question still proxied and streamed
  with `data: [DONE]` and no `event: error`; assistant echo does not re-trigger the gate.
- **Can-fail proof**: `if (spaced.test(text) || compact.test(dense))` mutated to `if (false)` →
  `Tests 3 failed | 14 passed`, exit 1, `AssertionError: expected 500 to deeply equal 200`
  (the un-refused request reached upstream). Reverted with `edit`, **not** `git checkout --`.
  Re-run → 17 passed, exit 0.
- `yarn tsc --incremental false` → exit 0.
- `oxlint --type-aware server/routes/api/ai/` → exit 0 (oxlint emits no stdout/stderr in this
  environment; exit code is the only signal).
- Browser automation is broken on this host, so the streaming and refusal rendering paths are
  verified by tests and code reading, not by a rendered panel. No screenshot claimed.

### .gitignore

`.env.local.bak-*` added after `.env.local`.
`check-ignore -v` reports `.gitignore:6:.env.local.bak-*` for both stray backups;
`.env.local` still resolves to `.gitignore:5:.env.local`. `ls-files | check-ignore --stdin`
reports exactly one tracked-but-ignored path, `.vscode/settings.json`, which is **pre-existing**
from the `.vscode/*` rule on line 8 — not caused by this change and left alone.

### Commit

`4b9465113` `fix(ai): enforce KB scope server-side in ai.chat route` on `development`,
4 files (`.gitignore`, `ai.ts`, `scope.ts`, `ai.test.ts`), **not pushed**. `development` is now 2
ahead of `origin/development`. No key value read or printed; no `.env*` file staged; no process
killed; no PR opened.

## Delivery receipt — PR #9 (git delivery only, no source change)

Both commits above shipped to `development` through a pull request, as required — `development`
itself was never pushed to directly.

- **Branch** `fix/ai-chat-scope-and-input`, cut from the local `development` HEAD (`4b9465113`).
  **No cherry-pick, no rebase** — the two commits were carried across by branching, so the
  original SHAs survived and ancestry could be verified by SHA. (The earlier failure mode of
  losing that ability is exactly what this avoids.)
- **PR** https://github.com/donichristian/outline-ygpkb/pull/9 — base `development`,
  head `fix/ai-chat-scope-and-input`, headRefOid `4b94651137d47dc5d685092bcb624bff339dbb84`.
  `mergeable: MERGEABLE`, `mergeStateStatus: CLEAN` at review time.
- **Merge SHA** `6c1379fee` (`6c1379fee4870965aa4e794def294ca7f4270c48`).
- **Merge method** `--merge`, pinned with `--match-head-commit 4b9465113…`. Method chosen from
  actual history, not assumption: `origin/development` carries two-parent
  `Merge pull request #N` commits (`b8488010e` for #7, `e3a8c8077` for #8). Parents of
  `6c1379fee` are `e3a8c8077` (old tip) and `4b9465113` (our head) — the merge provably landed
  that exact head.
- **CI status observed: no CI configured on this fork.** `gh pr checks 9` →
  `no checks reported on the 'fix/ai-chat-scope-and-input' branch` (exit 1);
  `statusCheckRollup: []`; `actions/runs` → `total_count: 0`. GitHub Actions has never executed
  on this repository despite workflow files being present. **No CI evidence is claimed** — the
  verification is local only.
- **Ancestry proof** — both checks exit 0 after the merge:
  - `git merge-base --is-ancestor 498d0222b origin/development` → `0`
  - `git merge-base --is-ancestor 4b9465113 origin/development` → `0`
- **Branch deleted** both places: `git push origin --delete fix/ai-chat-scope-and-input`
  (remote gone), then `git branch -d` (safe delete, was `4b9465113` — no `-D`).
  `origin/feat/ai-chat` from PR #7 was left in place deliberately.
- **Final tree** back on `development` @ `6c1379fee`, `git status --short` empty,
  `development...origin/development` = `0  0`.

### Gates re-run on the branch before pushing (all local)

| Gate | Result |
|------|--------|
| `yarn tsc --incremental false` | exit 0 |
| `yarn test server/routes/api/ai/ai.test.ts` | 17 passed, exit 0 |
| `yarn test app/components/AIChat/` | 2 files, 10 passed, exit 0 |
| `oxlint server/routes/api/ai/ app/components/AIChat/` | 10 files, 0 diagnostics, exit 0 |

oxlint note: it prints nothing to stdout/stderr in this environment, so exit code is the only
signal — `--format=json` was used to confirm it genuinely linted 10 files rather than silently
matching zero.

No key value read or printed. No `.env*` file staged or committed. No process killed. No
source file modified by this task — git delivery only.

---

## Retrieval-grounded scope gate — `c693cacc4`

Replaced the 16-entry phrase denylist in `server/routes/api/ai/scope.ts` with a
document-retrieval gate. 3 files, not pushed, `development` ahead of origin by 2.

### Policy chosen and why

**Option (a), retrieval-hit gate** — search the requesting user's own documents for the
prompt; refuse when nothing accessible matches. Not (b) post-hoc citation check: (b)
cannot satisfy the hard requirement (reject *without* contacting the gateway) because it
consumes the upstream call first, and it would buffer an unbounded response on this host
where a KB answer already takes ~102 s. (a) reuses shipped infrastructure and costs one
DB read on a path that previously did none.

**The denylist was removed, not kept as a pre-filter.** It is strictly subsumed: with an
empty-or-unrelated KB, `"What is the capital of France?"` finds nothing and is refused by
retrieval alone. Keeping it would have preserved a *known* bug it documented in its own
tests — it refused `"What is the capital city of our Jakarta office?"` even when that
document exists. Two decision mechanisms would mean two things to reason about for no
extra coverage.

### Where Outline's search actually lives — four of the obvious premises were wrong

There is **no `Document.search()`**, **no `document_search` table**, **no search-index
Sequelize model**, and **no trigram**. Grepping `server/models/Document.ts` for "search"
returns one comment.

- Entry point: `SearchProviderManager.getProvider().searchForUser(user, options)`
  (`server/utils/SearchProviderManager.ts:20`), implemented by
  `plugins/search-postgres/server/PostgresSearchProvider.ts:344`.
- Index is DB-side: a `tsvector` column `documents.searchVector` populated by the
  `documents_search_trigger()` BEFORE INSERT/UPDATE trigger (title weight A,
  `previousTitles` C, `text` D), GIN `documents_team_id_tsv_idx`. So a
  `buildDocument()` in a test is searchable **synchronously** — no queue to drain.
  (`server/queues/processors/SearchIndexProcessor.ts:44` returns early under postgres.)
- `search_queries` / `server/models/SearchQuery.ts` is **search analytics only**, not a
  content index.
- Authorization is **split**: the provider applies *visibility* as SQL OR-clauses
  (membership ids OR own-drafts-without-collection OR published-in-accessible-collection),
  with **zero** `authorize()` calls and zero policy imports. It hardcodes
  `deletedAt IS NULL` (trash excluded) and `template = false`, but **does not exclude
  `archivedAt`** — callers must pass that filter. Trash/archived/draft behaviour is in
  `buildWhere` (PostgresSearchProvider.ts:627).

Passing `filter.collectionId` or `filter.documentId` yourself would require
`authorizeFilterFields()` / `expandDocumentIdLeaves()` first. The gate passes neither,
so it needs no extra authorization calls — the visibility is already inside the query.

### Gotcha: quoted terms are AND-ed and silently capped at 3

This cost real debugging time and is the single most important thing to know about this
provider. `buildWhere` (PostgresSearchProvider.ts:728-765) lifts `"quoted"` fragments
out of the query into **separate `where[Op.and]` clauses** and keeps
`[...quotedQueries, ...likelyUrls].slice(0, 3)`. So

```
"describe" | "zanzibar" | "onboarding" | "flow"
```

is **not** an OR. It becomes `AND ilike %describe% AND ilike %zanzibar% AND
ilike %onboarding%`, `flow` is dropped, and the `tsquery` clause is skipped entirely
because `limitedQuery` is now empty. Measured against a seeded document:

| query | total |
|---|---|
| `"zanzibar" \| "onboarding" \| "flow"` | 1 |
| `"describe" \| "zanzibar" \| "onboarding" \| "flow"` | **0** |
| `describe\|zanzibar\|onboarding\|flow` (unquoted) | **1** |

A true OR must be **unquoted** `|`, which stays in `limitedQuery` and reaches
`to_tsquery`. Unquoted words are also AND-ed by `pg-tsquery`, so a whole question
(`"What is the capital city of our Jakarta office?"` →
`what&is&the&capital&city&of&our&jakarta&office:*`) matches essentially nothing —
hence the term extraction. Final shape: `term1|term2|...`, up to 8 terms, unquoted,
letters/digits only (so a term can never carry a `tsquery` operator).

Verified in isolation with throwaway probe tests before wiring the route — worth
repeating rather than assuming: `pg-tsquery`'s output for a shape is predictable, but
the provider's *pre-processing* of that shape is not.

### Authorization test is non-vacuous

`refuses a prompt whose only match is a document the user cannot read` seeds a document
the requester cannot see (own team, `buildCollection({ permission: null })` owned by
another user), then asserts refusal **and** that the fetch mock was not called. It fails
under the can-fail mutation, so it is genuinely exercising the retrieval decision rather
than an early return.

### New ceiling (also in the `ponytail:` comment in `scope.ts`)

- **Precision is a claim, not a measurement.** No false-reject rate has been measured
  against the live corpus. A full-text OR both over-matches a document that merely shares
  one word and under-matches a paraphrase that shares none.
- Biased toward **refusing**, because a refusal is visible to the user and a hallucinated
  answer is not.
- **Archived documents are excluded** — the assistant cannot open one, so an
  archived-only match would approve the prompt only for the model to refuse it after
  paying the upstream latency.
- Prompt terms are capped at 8, newest user turn first. A single-character term cannot
  ground anything. Assistant messages are never searched, so an answer cannot ground
  itself on its own prior output.
- Fails **closed**: a failed search refuses rather than passing through ungrounded.

### Added latency

One `searchForUser` call before `fetch`, `limit: 1`, no fan-out. Measured cost is one
ranked query on the read replica, plus a `COUNT` only when there is a hit
(`countResults` short-circuits on zero), plus document hydration — so 1 query on a
refusal, 2–3 on an allow. Against a ~102 s upstream KB answer this is noise. Not
benchmarked numerically on this host; the call shape is bounded by inspection.

`sequelizeReadOnly` is skipped in tests, so search reads the primary there.

### Tests

`yarn test server/routes/api/ai/ai.test.ts` → **19 passed**, exit 0 (was 17).

Three pre-existing transport tests posted `"hi"`, which the new gate correctly refuses
(the prompt has no distinctive terms). They now seed a document and post a topical
question — that is a real behaviour change in the tests, not a workaround.

Coverage: prompt matching a readable doc → allowed, upstream called, streams, no
`event: error`; matching nothing → refused, fetch **not** called; the
`"What is the capital of France?"` probe → refused in a workspace that *does* have
documents (so it tests retrieval, not an empty KB); only-inaccessible-document → refused,
fetch not called; all-weak-terms prompt → refused; whitespace-only; assistant-only
conversation; empty string still 400 at the schema; assistant echo does not re-trigger the
gate; assistant message cannot supply grounding terms.

One test was rewritten because it was **vacuous**: `does not ground a prompt on an
assistant message` originally used a user turn (`"What do you know?"`) with no distinctive
term of its own, so it refused regardless of whether assistant messages were read. It now
gives the user a term that matches nothing (`compensation`) while the assistant message
supplies the only matching term, so reading assistant messages would flip it to allowed.

### Gates

| Gate | Result |
|---|---|
| `yarn tsc --incremental false` | exit 0 |
| `yarn test server/routes/api/ai/ai.test.ts` | 19 passed, exit 0 |
| `oxlint --type-aware server/routes/api/ai/` | exit 0; `--format=json` → `number_of_files: 5`, `diagnostics: []` |

**Can-fail proof**: mutated `return total > 0 ? undefined : "no matching document";` →
`return undefined;` → `Tests 4 failed | 15 passed`, exit 1,
`AssertionError: expected 500 to deeply equal 200` on exactly the four
retrieval-dependent tests (nothing-matches, general-knowledge probe, inaccessible
document, assistant-message grounding). The three early-return tests (empty prompt,
weak terms, assistant-only) correctly stayed green — they do not reach the search.
Reverted with `edit`, **not** `git checkout --`. Re-run → 19 passed, exit 0.

### Client untouched

`AIChatPanel.errorText` (`app/components/AIChat/AIChatPanel.tsx:29`) falls through to
`error.message` for `kind === "stream"`, and `app/utils/aiChat.ts` `parseFrame` throws
`AiChatError(payload.error, "stream")`. The refusal renders verbatim. **No client change
was needed or made.** `OutOfScopeRefusal` text is unchanged, so no new i18n key and
`shared/i18n/locales/` was not hand-edited. `yarn build:i18n` was not run.

### Commit

`c693cacc4` `fix(ai): ground the ai.chat scope gate in document retrieval` on
`development`, 3 files (`ai.ts`, `scope.ts`, `ai.test.ts`), **not pushed**. Only those
three were staged — the concurrent `build:i18n` task's `package.json` / locale changes and
its uncommitted `app/scenes/*` edits were left alone. No key value read or printed, no
`.env*` file staged, no process killed, no PR opened.

## `yarn build:i18n` on Windows — fixed

**Commit** `698dd5b0ad8c46d3c390e40bd6d25e3fda12700e` on `development`, **not pushed**.

### Root cause — two independent bugs, not one

1. **`copy:i18n` was POSIX-only.** `mkdir -p ./build/shared/i18n && cp -R ...` needs a POSIX
   shell. Reproduced: `command not found: mkdir`, `EXIT=127`. Windows `mkdir` also created a
   stray `-p` directory at repo root (dated Oct 8, from an earlier run, still untracked litter).
2. **CRLF churn was NOT caused by the copy step.** Running extraction alone
   (`i18next --silent '{shared,app,server,plugins}/**/*.{ts,tsx}'`, exit 0) reproduced the same
   3-line churn. Cause: `core.autocrlf=true` with no `.gitattributes`, so the working tree holds
   CRLF, and `i18next-parser` copies the raw line ending out of multi-line template literals into
   their keys. All 27 other locales still carry the LF form, proving LF is correct.

### Fix

- New `scripts/copy-i18n.mjs`; `copy:i18n` is now `node ./scripts/copy-i18n.mjs`. Uses only Node
  stdlib (`mkdirSync recursive`, `cpSync recursive`) — no dependency added. Copies **per entry**
  rather than `cpSync(source, destination)` so it keeps `cp -R`'s merge-into-existing behaviour
  instead of nesting `locales/locales`. POSIX reasoning: `cp -R src parent` into an existing dir
  merges; per-entry copy reproduces that identically, and `mkdirSync(..., {recursive:true})` is
  the `mkdir -p` equivalent (no error when the dir already exists). Linux CI behaviour unchanged.
- It **verifies** rather than assumes: compares the two trees and byte-compares every file,
  throwing on mismatch. Proof it has teeth: injected a stale file → `copy:i18n tree mismatch —
  expected 28 files, found 29`, exit 1. Clean case → exit 0. Independent SHA256 sweep across 28
  files: 0 mismatches.

### Resulting diff

`3 files changed, 60 insertions(+), 1 deletion(-)` — `package.json` (+1/-1),
`scripts/copy-i18n.mjs` (+49), `en_US/translation.json` (**+10, zero deletions, zero CRLF**).
No other locale file touched. A second `yarn build:i18n` produces an empty diff (idempotent).
`build/shared/i18n/locales` holds 28 files across 28 locale dirs, no nesting.

### The 10 extracted keys

`AI chat`, `AI chat is not enabled for this workspace`, `Your session has expired, refresh the page
to continue`, `The AI chat request failed, try again?`, `Ask anything about your workspace`,
`Ask a question…`, `Message`, `Stop`, `Send`, `Allow members to use the built-in AI chat to ask
questions about this workspace.`

### ⚠️ `OutOfScopeRefusal` is still NOT extracted — and a re-run will not fix it

`server/routes/api/ai/ai.ts:103` calls `t(OutOfScopeRefusal)` — an **identifier**, not a string
literal. `i18next-parser` walks the AST for string-literal arguments, so it cannot see through a
const. Running extraction again, on any platform, will never add this key. It needs the call site
to pass the literal — that file is owned by the concurrent task and was deliberately not touched.
Until then `t()` returns the key, which happens to render correctly in English but is invisible to
every other locale.

### Local environment note (not committed)

Four source files were converted to LF **in the working tree only** to make extraction emit clean
keys: `app/scenes/Home.tsx`, `app/scenes/Settings/ApiKeys.tsx`,
`app/scenes/Settings/APIAndAccess.tsx`, `app/scenes/Collection/components/Empty.tsx`. Version
control confirms they are content-identical to HEAD (`diff --quiet` exit 0) — the ` M` in status is
the autocrlf stat artifact. **Not staged, not committed.** The durable repo-level fix is a
`.gitattributes` with LF enforcement, deliberately NOT done here: it would force a whole-repo
renormalization (~2601 files), which this task forbids. On Linux CI the churn cannot occur.

No key value read or printed. No `.env*` file staged. No process killed. No AI route file touched.

## `OutOfScopeRefusal` extraction gap — closed

### Diagnosis confirmed before changing anything

`ai.ts:103` was `t(OutOfScopeRefusal)` — an identifier. `i18next-parser` walks the AST for
string-literal arguments and cannot see through a const, so the string never reached the
catalog. `Select-String … -Pattern "only answers from this workspace"` on
`shared/i18n/locales/en_US/translation.json` returned nothing before the change.

### Fix

Literal inlined at the `t()` call, smart apostrophe (U+2019) copied from the constant:

```ts
refuseWithSseError(
  ctx,
  t("This assistant only answers from this workspace’s knowledge base")
);
```

`OutOfScopeRefusal` stays exported in `scope.ts` (tests import it); the now-unused import was
dropped from `ai.ts`. The constant's JSDoc previously claimed *"t() falls back to the key
until `yarn build:i18n` extracts it"* — misleading once the literal is inlined, and an
invitation to re-break the fix — so it was corrected. **Docstring only; `scope.ts` retrieval
logic untouched.** This is the one intentional extra file beyond the three named in the task.

### Drift guard — a source read, not a runtime assertion

A runtime check cannot detect drift: `i18next` falls back to the key when a translation is
missing, so `t(wrongKey)` still renders the wrong string and the existing
`expect(text).toContain(OutOfScopeRefusal)` stays green either way. The route's *source* is
the only place the literal exists, so the guard reads it:

```ts
const source = readFileSync(new URL("./ai.ts", import.meta.url), "utf8");
expect(OutOfScopeRefusal).toEqual("This assistant only answers from this workspace’s knowledge base");
expect(source).toContain(`t("${OutOfScopeRefusal}")`);
```

Non-vacuous, verified independently of the run: `EXACT_LITERAL_AT_T=true`,
`STRAIGHT_APOSTROPHE_PRESENT=false` in `ai.ts`, so straightening the apostrophe or mutating
either side breaks the assertion. `readFileSync` takes a `URL`, so no `fileURLToPath` import.

### The key that landed

```
"This assistant only answers from this workspace’s knowledge base":
  "This assistant only answers from this workspace’s knowledge base",
```

Verified by `JSON.parse` round-trip: 1 matching key, non-ASCII codepoint is `U+2019` only,
value identical to key.

### Locale diff — 1 line, and the CRLF trap fired again

`yarn build:i18n` → `copy:i18n — 28 locale files copied and verified`, **exit 0**.

First run produced `+4 -3`, not `+1`: the 3 churn lines were `Collection/components/Empty.tsx`,
`Settings/APIAndAccess.tsx` and `Settings/ApiKeys.tsx` re-emitting their multi-line template
literal keys with `\r\n`. Same `core.autocrlf=true` cause recorded in the previous entry — the
working tree holds CRLF, and `i18next-parser` copies raw line endings into keys. `Home.tsx` is
in the same CRLF state but contributes no churn (no multi-line literal).

Sequence that produced a clean diff: convert those 3 files to LF **in the working tree only**
→ re-run `yarn build:i18n` → `git checkout --` the 3 files to restore CRLF. Restoring is what
makes them clean again, because their committed blobs are the CRLF form; leaving them at LF is
the recurring ` M` hazard. Final `diff --stat -- shared/i18n/locales`:

```
 shared/i18n/locales/en_US/translation.json | 1 +
 1 file changed, 1 insertion(+)
```

**+1, −0, no other locale file, no CRLF churn, no whole-file rewrite.** Repo-level
`.gitattributes` LF enforcement is still the durable fix and is still deliberately not done —
it would force a whole-repo renormalization (~2601 files).

### Gates

| Gate | Result |
|---|---|
| `yarn build:i18n` | exit 0 — `28 locale files copied and verified` |
| `yarn tsc --incremental false` | exit 0 |
| `yarn test server/routes/api/ai/ai.test.ts` | **20 passed** (was 19), exit 0 |

Grounding gate re-confirmed unregressed after the `scope.ts` rewrite: prompt matching a
readable document → allowed with upstream called and SSE streamed, no `event: error`; prompt
matching nothing → refused with the fetch mock never called; prompt whose only match is an
inaccessible collection document → refused, fetch not called. Browser verification remains
unavailable on this host; everything above is tests, code reading and the locale diff audit.

### Commit

`fix(ai): inline the refusal literal so it is extracted` on `development`, 4 files (`ai.ts`,
`ai.test.ts`, `scope.ts` docstring, `en_US/translation.json`), **not pushed**. No key value
read or printed, no `.env*` file staged, no process killed, no PR opened.

## Delivery Receipt - AI Chat Scope & i18n Fix
- **Branch**: ix/ai-chat-grounding-and-i18n (off development, cut from cdb7b09ac)- **PR URL**: https://github.com/donichristian/outline-ygpkb/pull/10- **Merge SHA**: 2dc8e19797a34d8dd347208734a5ac1819081ce9- **Merge method**: --merge --match-head-commit cdb7b09ac51485787244c9f8cbeaf89ad28d3f86- **CI state**: **None** � GitHub Actions has never run on this fork (0 runs, 0 check-runs); local gates are the verification baseline- **Ancestry checks**: 698dd5b0a ?, c693cacc4 ?, cdb7b09ac ? (all exit 0 via merge-base --is-ancestor origin/development)- **Final tree state**: clean � no diff, status --short = nothing to commit- **Branch deletion**: ix/ai-chat-grounding-and-i18n deleted locally and on remote

## AI Chat System Design Doc

- **Doc created**: `docs/AI-CHAT-DESIGN.md` (new). YAML frontmatter (title, description,
  status shipped, last_updated 2026-10-13, related) parses clean via js-yaml; no tabs, no smart
  quotes in values. Sections: scope, request flow (Mermaid A), streaming transport + failure
  modes, the three-stage KB boundary (prompt-text -> phrase denylist -> retrieval grounding) with
  its ceiling, components (Mermaid B), design-constraint bugs, the model-routing fact, honesty
  notes, config.

- **Mermaid validation method**: `npx @mermaid-js/mermaid-cli` could NOT run - global npm's
  minizlib is broken on this host ("Class extends value undefined is not a constructor", Node
  22). Fell back to the mermaid@11.17.1 already present in the repo's `node_modules` (transitive
  dep, nothing installed, nothing added to package.json). Wrote an ephemeral jsdom harness that
  runs BOTH `mermaid.parse()` (authoritative grammar check) and `mermaid.render()` (full layout,
  catches what parse tolerates). Result: **both diagrams PARSE OK and RENDER OK to SVG**
  (diagram-1 61,752 bytes sequenceDiagram, diagram-2 37,527 bytes flowchart). Verified the
  rendered SVG contains real node/participant labels, all four `alt` conditions in the sequence
  diagram ("total > 0 (grounded)", "404 NotFoundError...", etc.), and zero syntax-error markers.
  jsdom gaps had to be stubbed (CSSStyleSheet, getBBox, navigator read-only on Node 22) - these
  are environment limitations, not diagram defects. The diagrams live as text in the markdown; no
  new dependency was added.

- **Corrected in `docs/AI-CHAT.md`** (edit only, kept operational; architecture delegated to the
  design doc via a header pointer):
  - "The gate" rewritten as **two** gates: (1) feature gate (TeamPreference.AIChat +
    AI_CHAT_BASE_URL -> 404), (2) **scope/grounding gate** (findUngroundedReason) - this was
    missing entirely and the old text implied a prompt-level boundary.
  - "What it is" now says the server checks grounding first and persists nothing; panel opened
    from floating trigger or command bar.
  - Run section: replaced the stale `http://localhost:20127/v1` / `your-model-id` sample with
    the real Hermes values (`http://127.0.0.1:8642/p/matius/v1`, `model=matius`) by NAME only,
    plus the model-selects-behaviour routing warning (matius vs ski-bot). No key value printed.
  - Direct checks: streaming curl now warns the prompt must be grounded; added a refusal-check
    example; noted `chat` resolves to Scope.Write for the CSRF rationale.
  - Added "Panel behaviour" section: single-line input, Enter sends (Input fires
    onRequestSubmit only on Cmd+Enter), floating trigger z-index 899 hides while open,
    scrollable={false}. Added not-browser-verified note.
  - "Verified constraints": added the grounding-before-provider bullet.

- **Honesty honoured**: doc states the panel has never been rendered in a browser (browser
  automation unavailable on this host), streaming proven by authenticated round trip, cookie+CSRF
  verified by code reading only, and CI does not run on this fork. No screenshots claimed. No
  secrets in either file (checked with a regex scan).

- **Commit**: staged ONLY the two doc files on `development`, **not pushed**. No source file
  touched, no locale file touched, no process killed, no PR. Husky not installed so nothing
  checked the commit automatically.

- **Commit SHA**: `65bba8f5247c25d709f59a46b2358d7a125719ea` ("docs(ai): add system design doc for
  the AI chat panel"), 2 files changed, 558 insertions(+), 21 deletions(-). `development` is
  ahead of `origin/development` by 1, working tree clean. Not pushed.

---

## Push receipt — AI chat design doc

- **Pushed SHA**: `65bba8f5247c25d709f59a46b2358d7a125719ea`
  (`docs(ai): add system design doc for the AI chat panel`)
- **Command**: `node vcs.mjs push origin development`
- **Push output**: `To https://github.com/donichristian/outline-ygpkb.git`
  / `   2dc8e1979..65bba8f52  development -> development`
- **New `origin/development`**: `65bba8f5247c25d709f59a46b2358d7a125719ea`
  (was `2dc8e1979`, the PR #10 merge)
- **Fast-forward, no force**: accepted on the first attempt; no rebase, no amend, no new
  commit, no PR. Plain `push`, never `--force`.
- **Ancestry**: `merge-base --is-ancestor 65bba8f52 origin/development` -> exit 0
- **Sync state**: `rev-parse HEAD` and `rev-parse origin/development` are byte-identical
  (`65bba8f5247c25d709f59a46b2358d7a125719ea`) — 0 ahead, 0 behind.
- **Working tree clean**: `status --short` empty after the push, before and after `fetch origin`.
- **Remote content confirmed**: `show origin/development:docs/AI-CHAT-DESIGN.md` prints the file,
  starting at the `---` frontmatter delimiter.
- **No secrets**: no `.env*` file staged or committed, no API key value recorded here.
