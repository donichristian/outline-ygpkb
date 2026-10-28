
## F4 re-verification @ 744bb9309 (wave 6)

- IS-1 DELIVERED. Proof: app/components/AIChat/AIChatPanel.test.tsx :: restores the active conversation when the panel is closed and reopened. Body clicks the session item ONCE, then two bare cleanup/remount cycles assert transcripts() === [question one, answer one] with no dropdown interaction. Cannot pass without store-owned selection (AIChatSessionsStore.selectedSessionId, observable at :48); the mock answers /ai.messages.list with [] so the transcript comes from the seeded store, not a refetch.
- Element identity intact: AIChatContext.test.tsx :: reuses the same element object after a close and reopen asserts elements[1] toBe first.
- IS-3 not regressed: AIChatPanel.test.tsx :: leaves the panel on an empty conversation after an explicit New chat asserts [] after ai-chat-new; AIChatHistory.test.tsx :: New chat returns the panel to a fresh, unselected conversation additionally asserts streamAiChat options.sessionId is undefined.
- IS-4 survived the i18n change: turnMarker now returns {labelKey, tone} (AIChatPanel.tsx ~line 445) and the render calls t(marker.labelKey). AIChatHistory.test.tsx asserts marker.textContent contains Response cut short / Stopped / Failed, so the markers still paint real text.
- IS-7 DELIVERED. Proof: AIChatPanel.test.tsx :: restores an unsent draft after the panel is unmounted and remounted. writeDraft only runs from handleChange, and the only read on mount is the useState initializer, so removing the wiring makes inputValue() come back empty.
- All eight re-checked on the client: no regressions found. Selected session id is store state, not IndexedDB-persisted, so a full page reload still opens a new conversation; IS-1 only claims close/reopen.
- Non-blocking: panel mount calls void aiChatSessions.list() with no catch; Store.list rethrows, so a failed list is an unhandled rejection. Pre-existing, outside wave 6.
