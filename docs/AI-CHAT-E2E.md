---
title: AI Chat — End-to-End Testing
description: >-
  Why the AI chat panel has no browser gate on this host, what the jsdom suite
  does cover, and the scenarios a real harness must own.
status: shipped
last_updated: 2026-10-14
related:
  - docs/AI-CHAT.md
  - docs/AI-CHAT-DESIGN.md
---

# AI Chat — End-to-End Testing

## 1. No E2E harness exists

Four checks, all negative: `node_modules/@playwright/test`,
`node_modules/playwright` and `node_modules/.bin/playwright.cmd` are all absent,
and `package.json` has no `playwright` dependency and no `test:e2e` script.
Playwright was ruled out by the plan. No config file is shipped for a runner
that is not installed.

## 2. Already on record

`docs/AI-CHAT-DESIGN.md` §8:

> **The panel has never been rendered in a browser.** Browser automation is
> unavailable on this host (`Windows named-pipe discovery is not implemented`).

DESIGN covered the panel; persisted sessions added a cache-reconciliation
surface that no test of any kind reaches.

## 3. The standing gate

`yarn test:app` (37 files / 350 tests) and `yarn test:server server/routes/api/ai`
(7 files / 117 tests), green. Representative names, each grepped out of the file
it is cited from:

- `app/components/AIChat/AIChatPanel.test.tsx` — `keeps the transcript when the panel is closed and reopened`; `shows each session's own transcript when switching between sessions`
- `app/components/AIChat/AIChatHistory.test.tsx` — `lists the user's sessions and switches to the correct transcript`; `renders the transcript ordered by seq ascending, not by createdAt`; `deleting the active session starts a new one`
- `app/components/AIChat/AIChatContext.test.tsx` — `reuses the same element object after a close and reopen`
- `app/utils/aiChat.test.ts` — `listMessages should return the messages/truncated/cursor envelope`; `deleteSession should hit ai.sessions.delete with the session id`; `should round-trip a draft through storage`

## 4. The gap

**Cache reconciliation has no E2E gate.** A transcript must survive a page
reload and render identically on another device, because storage is
server-authoritative rather than a browser cache. Nothing tests that.

The jsdom tests cannot. They run the client against a mocked store, so the store
returns exactly what the test seeded. Divergence between what the client caches
and what the server returns is the one condition a mock makes unrepresentable.

## 5. Spec for a future harness

1. Close/reopen keeps the transcript.
2. Reload rehydrates from the server, not from cache.
3. Session switch shows each session's own transcript; delete removes it.
4. Draft restore: type without sending, close, reopen, draft returns.