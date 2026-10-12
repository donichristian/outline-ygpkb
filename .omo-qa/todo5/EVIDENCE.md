# Todo 5 — Right-sidebar AI chat panel

## Deliverable

New UI, colocated styled-components, no new deps.

| File | Role |
|------|------|
| `app/components/AIChat/AIChatContext.tsx` | Panel open/close context + `AIChatProvider` that mounts the panel into the ephemeral right sidebar. Exports `useAIChatPanel()` → `{ open, close, isOpen } \| null` (null when the workspace gate is off). |
| `app/components/AIChat/AIChatPanel.tsx` | The panel: message transcript + composer, incremental streaming, Stop/abort, error notice. |
| `app/components/AIChat/AIChatPanel.test.tsx` | Colocated component test (project `app`, jsdom, `createRoot` + `act`). |
| `app/components/AuthenticatedLayout.tsx` | Minimal wiring: `<AIChatProvider>` nested inside `<RightSidebarProvider>`. |

Commit: `feat(ai): add right-sidebar AI chat panel`.

## Mount / open contract (for Todo 6)

- `AIChatProvider` is mounted in `AuthenticatedLayout` inside `RightSidebarProvider`,
  wrapping `Layout` (so its render is visible to `Layout`'s
  `useRightSidebarContent()` inside `<AnimatePresence>`).
- When open it calls `useSetRightSidebar(<AIChatPanel onClose/>)`; on close /
  unmount it calls `useSetRightSidebar(null)` – mirroring `useDocumentSidebar`.
- Gated on `team.getPreference(TeamPreference.AIChat)`. When off, the context
  value is `null`, no panel mounts, no entry point exists.
- **Todo 6 should call** `useAIChatPanel()` and invoke `controls?.open()` from the
  action's `perform`. `close()` and `isOpen` are available for toggling.
- The open state is local React state, NOT `UiStore.rightSidebar` – the persisted
  enum that drives the Document comments/history sidebar is untouched.

## Gates (raw evidence in this directory)

| Gate | Command | Result | Raw output |
|------|---------|--------|------------|
| Typecheck | `yarn tsc --incremental false` | exit 0, 0 `error TS` | `tsc.txt` |
| Lint (changed files) | `yarn oxlint app/components/AIChat/*.tsx app/components/AuthenticatedLayout.tsx` | exit 0, 0 errors; 1 pre-existing warning | `oxlint.txt` |
| Component test | `yarn test app/components/AIChat/AIChatPanel.test.tsx` | 4 passed (1 file) | `test-final.txt` |
| Live server reachable | headless Chrome screenshot of http://localhost:3050 | HTTP 200, login page only | `live-3050.png` |

`oxlint` warning on `AuthenticatedLayout.tsx:108` (`refs`) is **pre-existing**:
the same warning fires on the unmodified `HEAD` file (line 106,
`<PortalContext.Provider value={layoutRef.current}>`). Verified by checking out
`HEAD:app/components/AuthenticatedLayout.tsx` and linting it.

## Component test coverage (the real proof)

The test renders the panel with `createRoot` + `act` (RTL is not installed in
this repo) and mocks `streamAiChat`, `SidebarLayout` and `Button`:

1. **incremental streaming** – a gated generator yields `"Hel"`, the assertion
   sees `"Hel"` and NOT `"Hello"`, then releasing the gate yields `"lo"` and the
   transcript shows `"Hello"`. Proves text is appended per delta.
2. **Stop aborts** – a generator captures the passed `signal` and hangs; clicking
   Stop asserts `capturedSignal.aborted === true`. Proves abort propagates.
3. **AiChatError renders a visible notice** – a thrown `AiChatError` (429) renders
   `[data-testid="ai-chat-error"]` containing the message (no hung spinner).
4. **404 wording** – a thrown `AiChatError(404)` renders
   "AI chat is not enabled for this workspace".

## Adversarial classes

- **cancel/resume** – asserted: Stop sets `signal.aborted === true` (test 2).
- **stale_state** – the panel owns its `messages` state locally; it is created
  fresh on each `open` (`<AIChatPanel/>` is remounted because
  `AIChatContent` sets/clears the sidebar content), and aborts + clears on
  unmount via the `useEffect(() => () => abort())` cleanup. Closing and
  reopening therefore starts from an empty transcript. Reasoned with evidence:
  the panel is created inside `useSetRightSidebar(<AIChatPanel/>)` only while
  open, and `AIChatContent` clears to `null` when closed.
- **misleading_success_output** – error notice renders on `AiChatError` (test 3,
  4); the disabled gate is asserted at the provider level by `controls === null`
  + `enabled &&` guard (no panel/entry point renders when off).
- **dirty_worktree** – `git status --short` before: only `?? .omo-qa/`. After:
  `M app/components/AuthenticatedLayout.tsx`, `?? app/components/AIChat/`,
  `?? .omo-qa/`. Only the new UI files + the minimal wiring.
- **prompt_injection / malformed_input** – n/a client-side: the panel only
  forwards the user's text to `streamAiChat`, which posts JSON; prompt injection
  and malformed-frame handling are the server's / `aiChat.ts`'s concern (covered
  by Todos 2–4).
