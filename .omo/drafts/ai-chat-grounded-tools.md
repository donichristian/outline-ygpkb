---
slug: ai-chat-grounded-tools
status: drafting
intent: clear
review_required: false
pending-action: write .omo/plans/ai-chat-grounded-tools.md
approach: Four waves, no new runtime dependency. (1) Add a repo-side assistant instruction layer (TanStack `systemPrompts`, operator-gated) and make grounding measurable (SearchQuerySource.Ai + migration). (2) Extract one shared, authorized, capped document-body reader out of the MCP fetch tool and expose it to the AI chat as a new `fetch_document` server tool in the frozen allowlist. (3) Upgrade `search_workspace` with an authorized collection scope and add a `recommend_documents` tool that returns relevance-ranked hits with an explicit reason. (4) Persist tool calls so follow-up turns build on prior retrieval, and add the client affordances (prefill bridge, document-scoped "Ask AI" action, starter chips, no-citation warning). Every capability target (summary, search, Q&A, recommend) is closed by a server tool plus a client entry point; no vector infrastructure, no new endpoint, no client-supplied tools.
---

# Draft: ai-chat-grounded-tools

## Affected user and ideal state
<!-- Who this output touches (a customer, another programmer, a program or agent consuming it - often more than one) and how each uses it today and will use it after. -->
<!-- IS-n | property of the ideal state: nothing snags, feels odd, regresses, or degrades for them | reason -->
<!-- GAP-n | difference between IS-n and today | reason | closed by todo(s) -->

Three users, in priority order.

**U1 - workspace member using the in-app AI chat panel.** Today: opens the panel, types free text, gets an answer the assistant assembled from at most five snippets of roughly 250 characters each. Cannot ask for a summary of a specific document, cannot scope a question to a collection, cannot see whether an answer is sourced, and a follow-up question starts from zero because the assistant's own retrievals are not remembered.
**U2 - workspace operator/admin.** Today: owns the AI gateway, the workspace AI preference, and the workspace content. Cannot tell how often the assistant refuses or why, has no way to add an instruction to the assistant from inside the repo, and cannot see how much workspace content leaves the workspace per request.
**U3 - external MCP client (Hermes-style agent) using `POST /mcp`.** Today: reads workspace documents in full through the `fetch` tool and lists them through `list_documents`. Must keep behaving identically - this surface is a separate contract that the AI panel does not share.

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | A member can ask for a summary of a specific workspace document and receives a summary of that document's real content, not a guess from a snippet | The four requested capabilities must actually work; today the panel cannot open a document at all |
| IS-2 | A member can scope a question to a collection and only documents from that collection are returned | Today retrieval is workspace-wide with no scope control, so answers drift off-topic |
| IS-3 | Every answer that asserts a fact carries a citation the member can open, and an answer with no citation is visibly marked | The model only ever sees snippets, so an unsupported claim is currently indistinguishable from a supported one |
| IS-4 | A follow-up question ("now compare those two") builds on what the assistant already retrieved in the same conversation | Today tool calls are never persisted, so every turn reasons from the visible transcript alone |
| IS-5 | The operator can measure from repo data how often the assistant refuses and why | `scope.ts` states plainly that no false-reject rate has ever been measured against the live corpus |
| IS-6 | The operator can add a repo-side instruction layer to the assistant and switch it off, without editing the gateway | Today the only persona lives in the upstream gateway, outside this repo, so repo-side changes are invisible and untestable here |
| IS-7 | The MCP surface keeps working exactly as before, including full-document `fetch` output and its chunking | MCP is a separate consumer with its own contract; the shared reader must not alter a single byte of its output |
| IS-8 | The assistant stays read-only and bounded: server-owned tools only, body size capped, archived documents excluded, documents the member cannot read refused | Document bodies are untrusted input that can carry injected instructions; a read-only, capped, authorized surface is the containment |

| Row | Statement | Reason |
| --- | --- | --- |
| GAP-1 | No tool can read a document body - the frozen allowlist contains exactly one tool, `search_workspace` | Closes IS-1; without a body read, "summary of a document" is unreachable and answers stay snippet-thin |
| GAP-2 | `search_workspace` accepts only a free-text query: no collection scope, no caller-chosen limit | Closes IS-2; also the reason a "recommend" capability has nothing to rank or scope with |
| GAP-3 | No citation contract exists: the `chat()` call passes no system prompt, and the grounding code states no citation check exists | Closes IS-3; unsupported claims are invisible today |
| GAP-4 | The persistence middleware accumulates only `TEXT_MESSAGE_CONTENT`, so tool calls are dropped from stored conversations | Closes IS-4; follow-up turns are blind today |
| GAP-5 | AI retrievals are never recorded as search queries - `SearchQuerySource` has no `ai` value and the AI path calls the provider directly | Closes IS-5; refusal rate and hit rate are unmeasurable |
| GAP-6 | There is no repo-side assistant instruction layer; the persona is upstream only | Closes IS-6 |
| GAP-7 | Full-document body reading exists only as module-private MCP helpers (`chunkText`, `extractSection`, the 20000/60000 caps), so an AI body tool would either duplicate it or bypass it | Closes IS-7; one reader, two consumers, identical output |
| GAP-8 | The read-only containment is expressed only as a frozen allowlist; there is no body-size bound and no explicit refusal record for a document the member cannot read | Closes IS-8 |

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

| id | Outcome | Status | Evidence path |
| --- | --- | --- | --- |
| C1 | Assistant receives a repo-side instruction layer (KB boundary, cite-or-say-nothing, fetch-before-summarizing) that the operator can switch off | active | `server/routes/api/ai/ai.ts:603-636` (chat options), `node_modules/@tanstack/ai/dist/esm/types.d.ts:1064` (`systemPrompts`) |
| C2 | One shared, authorized, capped document-body reader serves both the AI panel and the MCP `fetch` tool | active | `server/mcp/tools/fetch.ts:32-35,71,99,232-307`, `server/commands/documentLoader.ts:12-34` |
| C3 | The AI tool surface can read a document body, scope a search to a collection, and return reason-bearing ranked candidates | active | `server/routes/api/ai/tools.ts:23,43-88`, `server/utils/BaseSearchProvider.ts:11-22,24-40` |
| C4 | Grounding is measurable: AI retrievals are auditable, refusals are counted, and an uncited answer is visible to the member | active | `server/models/SearchQuery.ts:23-29`, `server/routes/api/ai/scope.ts:238-281`, `app/components/AIChat/AIChatPanel.tsx:971-1006` |
| C5 | Stored conversations remember what the assistant retrieved, so follow-up turns build on the earlier turn | active | `server/routes/api/ai/middleware.ts:158,183-186`, `server/models/AIChatMessage.ts`, `app/models/AIChatMessage.ts` |
| C6 | A member can start a scoped ask from a document and sees whether an answer is sourced | active | `app/components/AIChat/AIChatContext.tsx:56-58`, `app/actions/definitions/documents.tsx`, `app/actions/definitions/navigation.tsx:192-201` |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| Citation enforcement strength | Measure server-side and warn client-side; no hard refusal | Hard refusal requires buffering the whole answer before any token is flushed, which destroys the streaming the panel exists for; the repo itself names the post-hoc citation check as the upgrade path (`server/routes/api/ai/scope.ts:219-221`) | yes - a single operator flag |
| `recommend_documents` ranking source | Relevance-ranked hits only, each with an explicit reason string; no popularity blending | Search's `SortFilter` cannot express `popularityScore` (`shared/types/filters.ts:12-16`); blending needs a second, non-provider query path | yes - additive later |
| New runtime dependencies | None | Repo mandate is to use already-installed dependencies; pgvector plus an embedding client would add an extension, a column, a backfill task and a write-path hook | yes - deferred to a later wave with measured data |
| Client-side tool execution / approval UI | Not added | `server/routes/api/ai/ai.ts:569-572` deliberately closes the client-tool surface, and the tools are read-only with no side effects | yes |
| Repo-side prompt default state | Off unless the operator enables it | The persona currently lives in the upstream gateway (`docs/AI-CHAT.md:177-181`); an always-on repo prompt would silently change production behaviour | yes - one env flag |
| Documentation handling | Update `docs/AI-CHAT.md` and `docs/AI-CHAT-DESIGN.md` in place; create no new markdown file | Root `AGENTS.md`: "Critical - Do not create new markdown (.md) files." | n/a |
| Migration mechanism | `yarn db:create-migration` style committed plain `.js` migration under `server/migrations/` | Repo convention: 43 committed plain `.js` migrations, no build step | n/a |

## Findings (cited - path:lines)

**Server AI surface**
- `server/routes/api/ai/ai.ts:317-677` - `ai.chat` route; `auth({ type: [AuthenticationType.APP] })` :319, `rateLimiter(TenPerMinute)` :320, `validate(T.AiChatSchema)` :321, `assertAiChatEnabled` :324, ownership `AIChatSession.findOwned` :348-354, Redis in-flight lock TTL 900s :235/:367-403, question row appended :452-469, grounding gate call :504-506, `chat()` :603-636, `RUN_ERROR` sanitized :640-652, SSE response :653-670.
- `server/routes/api/ai/tools.ts:23` - `MaxToolResults = 5`; :29 `ArchivedFilter`; :43-86 the single frozen tool `search_workspace`; :69-75 `searchForUser(user, { query, filter, offset: 0, limit: 5 })`; :79-84 maps to `{ documentId, title, url, context }`; :88 `Object.freeze`; :94-108 cached promise.
- `server/routes/api/ai/scope.ts:97-104` - `promptText` uses **user messages only**; :122-140 `buildProbeQuery` (OR-joined, max 8 terms, whitespace-split); :150-188 whitespace-free-script classifier; :238-281 `findUngroundedReason` (probe `limit: 1`, `total > 0` decides, fail-closed); :212-231 the two `ponytail:` blocks naming the ceiling and the upgrade path.
- `server/routes/api/ai/middleware.ts:158,183-186` - only `TEXT_MESSAGE_CONTENT` is accumulated; :167-179 `persistAndRelease`; :188-210 status mapping.
- `server/routes/api/ai/enabled.ts:25-33` - 404 unless `TeamPreference.AIChat` on AND `AI_CHAT_BASE_URL` AND `AI_CHAT_MODEL` set.
- `server/routes/api/ai/schema.ts:41-42` - client `system` role rejected in both message shapes; :37-39 the comment claims a "server-side instructions" layer that does not exist.
- `server/routes/api/ai/aiSessions.ts:28-162` - `ai.sessions.create/list/delete`, `ai.messages.list`.
- `server/routes/api/ai/adapter.ts:51-68` - OpenAI-compatible adapter, `api: "chat-completions"`.

**Retrieval primitives**
- `server/utils/BaseSearchProvider.ts:11-22` `SearchResponse { results: { ranking, context?, document }[], total }`; :24-40 `SearchOptions { limit, offset, query, filter, share, snippetMinWords, snippetMaxWords, sort, direction, usePopularityBoost }`; abstract methods `searchForUser` :66, `searchForTeam` :78, `searchTitlesForUser` :90, `searchCollectionsForUser` :102, `index` :114, `remove` :126, `updateMetadata` :140 - no full-text and no similarity method.
- `plugins/search-postgres/server/PostgresSearchProvider.ts:650-651` `ts_rank` x popularity boost; :661-662 order `searchRanking DESC, updatedAt DESC`; :388 `Document.withMembershipScope(user.id, { includeDrafts: true })` - scope `withoutStateOrText`, so search results carry **no body**; :76 `maxQueryLength = 1000`; :684-732 the ~250-char snippet window.
- `server/models/helpers/Filters.ts:140` `combineFilters`; :460 `authorizeFilterFields` - the authorization step for collection filters.
- `server/routes/api/documents/documents.ts:1350-1366` - the canonical filter-authorize-then-search call shape to copy.
- `server/commands/documentLoader.ts:12-34` - `loadDocument({ id, user, includeState })` -> `Document.findByPk` (accepts a urlId slug) + `authorize(user, "read" | "restore", document)`.
- `server/models/helpers/DocumentHelper.tsx:240` `toPlainText`; :254 `getAnchorContent`; :326 `toMarkdown`.
- `server/models/Document.ts` `findByPk` override resolves uuid **or** urlId; `withMembershipScope` drops `content`/`text`.
- `server/mcp/tools/fetch.ts:32-35` `DEFAULT_CHUNK_LIMIT = 20000` / `MAX_CHUNK_LIMIT = 60000`; :43 `findHeadings`; :71 `extractSection`; :99 `chunkText`; :232-307 the full-document read path; all module-private, inside the `registerTool` closure.

**No vector infrastructure, one lexical ranker**
- No `pgvector` extension, no vector column, no HNSW/IVFFlat index, no embedding client in `package.json`; `pg_trgm` is installed but never used for ranking (zero `similarity()` calls).
- `server/models/Relationship.ts:13-16` `RelationshipType.Similar = "similar"` exists in the model and the DB enum, but **no server code writes it** - a vestigial slot, not a capability.
- `server/queues/tasks/UpdateDocumentsPopularityScoreTask.ts` - the `popularityScore` producer; sortable only through `documents.list` (`server/routes/api/documents/schema.ts:60`).
- `server/models/SearchQuery.ts:23-29` `SearchQuerySource { Slack, App, API, OAuth, MCP }` - no `ai` value; `OAuth` is declared but never written.

**Client**
- `app/components/AIChat/AIChatPanel.tsx` - free-text composer only (placeholder "Ask a question...", empty state "Ask anything about your workspace"), no summary/search/recommend mode, no starter chips, tool cards rendered read-only (:971-1006), error copy :211-248.
- `app/components/AIChat/AIChatContext.tsx:56-58` `openAIChatPanel()` - **no-arg** module bridge; :40-47 `registerAIChatOpenHandler`.
- `app/utils/aiChat.test.ts:329-356` - the wire body carries the question and thread id only; no documentId, no client tools.
- `app/actions/definitions/navigation.tsx:192-201` `openAIChat` action; `app/actions/definitions/documents.tsx` is where document-scoped actions live.
- `app/scenes/Settings/AI.tsx:170-179` - the "AI answers" search switch is disabled.
- `shared/constants.ts:110` `TeamPreference.AIChat` defaults to false.

**Library capability (verified)**
- `node_modules/@tanstack/ai/dist/esm/types.d.ts:1064` - `systemPrompts?: Array<SystemPrompt>` on `TextOptions`; `node_modules/@tanstack/ai/dist/esm/utilities/chat-params.d.ts:18-37` - the request-body parser returns `messages/threadId/runId/tools/forwardedProps/state/resume/context` and **no** `systemPrompts`, so a client cannot set it; `mergeAgentTools` (same file :102-107) exists and the route correctly never calls it.
- `package.json:119-122` `@tanstack/ai 0.69.0`, `@tanstack/ai-client 0.39.3`, `@tanstack/ai-openai 0.30.0`, `@tanstack/ai-react 0.30.4`.

**Documentation drift found (closed by the docs todo)**
- `docs/AI-CHAT.md:51-53` claims the route "never injects document content into the prompt" while tool results carry document snippets into the model context (`server/routes/api/ai/tools.ts:79-84`).
- `docs/AI-CHAT.md:69-74` gate snippet checks only `AI_CHAT_BASE_URL`; the code checks BASE_URL **and** MODEL (`server/routes/api/ai/enabled.ts:26-31`).
- `docs/AI-CHAT.md` cites `app/scenes/Settings/Features.tsx`, which does not exist (real file: `app/scenes/Settings/AI.tsx`).
- `docs/DEPLOYMENT.md:220-222` "308 migrations" - actual 43.
- `docs/FRONTMATTER-PLAN.md:76` cites `shared/types.ts` - now `shared/types/`.
- `AI_CHAT_REASONING` exists in `server/env.ts` but is missing from `.env.sample`.
- `server/routes/api/ai/schema.ts:37-39` and `server/routes/api/ai/ai.ts:49-53` both refer to a server-side persona/instruction layer that does not exist.

**Verification wave 1 - server-side system prompt reaches the wire (VERIFIED)**
- `node_modules/@tanstack/ai/dist/esm/activities/chat/index.d.ts:95` - `TextActivityOptions.systemPrompts?: Array<SystemPrompt<TAdapter['~types']['systemPromptMetadata']>>`; `:54-61` `TextActivityOptionsWithContext` only omits `tools|middleware|context|interrupts|toolChoice`, so `systemPrompts` survives; `chat()` declared at `:379`.
- `node_modules/@tanstack/ai/dist/esm/types.d.ts:1041,1064` - the adapter-facing `TextOptions` also carries `systemPrompts`; `:1050-1060` documents that provider-foreign `metadata` is silently dropped.
- `node_modules/@tanstack/ai/src/system-prompts.ts:39-44` - `SystemPrompt<TMetadata> = string | { content: string; metadata?: TMetadata }`; `:86-95` the runtime normalizer throws on a non-string `content`.
- `node_modules/@tanstack/ai/src/activities/chat/adapter.ts:82` - `TSystemPromptMetadata` defaults to `never`; `node_modules/@tanstack/openai-base/src/adapters/chat-completions-text.ts:75-84` passes `never` explicitly, and `node_modules/@tanstack/ai-openai/src/compatible/adapter.ts:16-27` supplies no metadata generic - therefore **plain strings only** for this repo's adapter.
- `node_modules/@tanstack/openai-base/src/adapters/chat-completions-text.ts:1384-1407` - `mapOptionsToRequest` pushes ONE `role: "system"` message (all prompts joined with `\n`) **before** the conversation messages; `:143-159` spreads the result into `client.chat.completions.create({ ...requestParams, stream: true })`, so the prompt reaches `POST {baseURL}/chat/completions`.
- `node_modules/@tanstack/ai-openai/src/compatible/index.ts:96-119` - `openaiCompatibleText` lives in `@tanstack/ai-openai` (subpath `@tanstack/ai-openai/compatible`), **not** in `@tanstack/ai`; `:107-118` is the branch the repo takes (`api !== "responses"` -> `OpenAICompatibleChatAdapter` -> the chat-completions base). The Responses path instead maps prompts to a top-level `instructions` string (`node_modules/@tanstack/openai-base/src/adapters/responses-text.ts:2613-2623`).
- `node_modules/@tanstack/ai/src/activities/chat/messages.ts:718` - a `system` role in the messages array is skipped by the engine ("handled via systemPrompts, not ModelMessages").
- Repo status: `server/routes/api/ai/ai.ts:603-636` passes **no** `systemPrompts`; `server/routes/api/ai/schema.ts:42` restricts the client to `z.enum(["user","assistant"])`; `server/models/AIChatMessage.ts:16-19` stores only those two roles - so a client cannot inject or override a system role today.
- **Consequence: no dependency change and no adapter change is needed. A plain `systemPrompts: [string]` on the existing `chat()` call is sufficient, and it lands as the first message of the upstream body.**

**Verification wave 2 - tool-call persistence and audit surface (VERIFIED)**
- `server/models/AIChatMessage.ts` - extends `IdModel` (no soft delete); columns `role` ENUM(user|assistant) :50-51, `seq` :57-58, `content` TEXT NOT NULL :64-65, `status` ENUM(completed|aborted|error|truncated) :70-72, `runId` UUID nullable :77-78, `sessionId` :85-87. No tool-call column.
- `server/migrations/20261014000000-create-ai-chat-sessions.js` - the `ai_chat_messages` table at :55-104; role enum :73-76; content TEXT NOT NULL :81-84; the migration opens its own explicit `queryInterface.sequelize.transaction(...)` at :5. **A new column needs a NEW migration file** - the create migration is already applied to existing databases.
- `server/migrations/20260714000000-add-mcp-to-search-queries-source.js` (whole file, verified) - the pattern to copy for the new enum value: a raw `ALTER TYPE enum_search_queries_source ADD VALUE '<value>'` and a `down` that throws. **No migration in this repository sets `transaction: false`** (zero matches repo-wide), so the new migration must not rely on one; PostgreSQL 12+ permits `ALTER TYPE ... ADD VALUE` inside the migration transaction, but the new value must not be used in the same transaction.
- `server/commands/aiChatMessageCreator.ts` - the row is created at :98-105 via `AIChatMessage.createWithCtx(txCtx, { sessionId, role, seq, content, status, runId })`; the write is bound to its own short-lived context at :68-73 (the caller's `ctx.state.transaction` is deliberately neither read nor replaced).
- `server/presenters/aiChatSession.ts:31-41` - `presentAIChatMessage` returns `{ id, seq, role, content, status, runId, createdAt }`; the API shape of a message comes from here alone.
- `server/routes/api/ai/aiSessions.ts:110-162` - the `ai.messages.list` handler; the response is `page.map(presentAIChatMessage)` at :149-160, so a presenter change alone carries the field to the client.
- `server/routes/api/ai/middleware.ts:78-111` - `appendTurn` **skips an assistant row whose content is empty** (:92-94). Consequence: a run that made a tool call but produced no text would persist nothing, so the tool-call record would be lost unless that guard is relaxed for turns that carry tool calls.
- `server/routes/api/ai/middleware.ts:183-187` - `onChunk` accumulates only `TEXT_MESSAGE_CONTENT`; tool-call chunks are not captured today.
- `app/models/AIChatMessage.ts` - `@Field` + `@observable` on `seq` :32-34, `role` :37-39, `content` :42-44, `status` :47-49, `runId` :52-54; `sessionId` is deliberately not a `@Field` (:61).
- `app/models/decorators/Field.ts:35-38` - the decorator only records the key. Existing precedents: a `string[]` field at `app/models/oauth/OAuthClient.ts:63-66` (`redirectUris: string[]`) and `app/models/Integration.ts:28-30` (`events: string[]`); a JSON object field at `app/models/Document.ts:180-182` (`preferences: DocumentPreferences | null`) backed by `@Column(DataType.JSONB)` on the server.
- `app/stores/AIChatMessagesStore.ts:74-77` - `this.add({ ...message, sessionId })`; the payload flows into the model, so **no store change is required** once the client model declares the field.
- `app/components/AIChat/AIChatPanel.tsx` - the live path extracts `part.type === "tool-call"` into `{ id, name, input, output }` at :112-155 and renders `ToolCallCard` at :801-803 / :971-1006; but the **stored** mapping at :385-395 rebuilds turns from `{ seq, role, content, status }` only, so a persisted tool call is currently not re-renderable. The `ToolCallView` type is module-local.
- `server/models/SearchQuery.ts:23-29` - `SearchQuerySource { Slack, App, API, OAuth, MCP }`; the column is `@Column(DataType.ENUM(...Object.values(SearchQuerySource)))` at :119-120; `record()` at :57-105 uses `source` in both the recency-collapse `where` and the insert.
- `server/presenters/searchQuery.ts:7` passes `source` through unchanged, so a new value reaches the client automatically; `server/routes/api/searches/schema.ts:25-31` types `source` as `z.string().optional()` (no enum constraint, so no zod change is required); `app/models/SearchQuery.ts:20` carries the union `"api" | "app" | "slack" | "oauth"` - which is **already missing `"mcp"`**, a pre-existing gap.
- `server/routes/api/documents/documents.ts:1386-1397` and `server/mcp/tools/documents.ts:189-197` are the existing `SearchQuery.record` call sites; `plugins/slack/server/api/hooks.ts:258-264` writes `SearchQuery` directly.

**Verification wave 3 - which existing assertions break when a system message is prepended**
- BREAKS (exact upstream body): `server/routes/api/ai/ai.test.ts:267-273` (`toMatchObject` on the `messages` array) and `server/routes/api/ai/upstreamMessages.test.ts:557-561`, `:589-592`, `:651-653` (`toEqual` on the upstream `messages` array).
- BREAKS only if the message is prepended INSIDE `resolveUpstreamMessages`/`toUpstreamMessages`: `upstreamMessages.test.ts:193-197`, `:215-220`, `:233`, `:258-261`, `:327-334` (including the `Object.keys(message).sort()` check at :331-333) and the further `toEqual` blocks at :397-401, :408-412, :427, :435, :455, :467, :479.
- SURVIVES a prepend: `server/routes/api/ai/aiStreaming.test.ts:533-542` and `:585-596` (they filter by content and assert on `.at(-1)`), and `server/routes/api/ai/tools.test.ts:196-206` (`toContain` on the stringified body).
- BREAKS when the message presenter changes: `server/routes/api/ai/upstreamMessages.test.ts:666-674` (`expect(presentAIChatMessage(stored)).toEqual({...})`).
- SURVIVES a new client field: `app/components/AIChat/AIChatPanel.test.tsx` uses `not.toContain` for assistant bubbles; `app/stores/AIChatMessagesStore.test.ts` uses `toMatchObject`.

**Verification wave 4 - Metis gap analysis (findings folded into the plan)**
- **BLOCKER, contradiction** - the draft decision to reuse `DocumentHelper.getAnchorContent` for section reads contradicts the Must-NOT-have "MCP output bytes unchanged". `getAnchorContent` matches by heading **anchor** (`server/models/helpers/DocumentHelper.tsx:254-266`, a slug with an optional leading `#`), while the external tool's section match is by heading **text**, case-insensitively (`server/mcp/tools/fetch.ts:71`). Different semantics - the shared reader must keep the external tool's behaviour and expose the anchor-based lookup as a separate, explicitly named path for the new AI tool. Folded into todo 4.
- **BLOCKER, unvalidated assumption (premise 5 was WRONG)** - search results **do** carry the body. The `withoutStateOrText` scope excludes `state` and `text` but **includes** `content` (`server/models/Document.ts:179-182`, the content column is excluded only by `withoutContent` at :185), and the conditional aliases `stateIfContentEmpty` (:94-99) and `textIfContentAndStateEmpty` (:103-108) keep one of them present. So no re-fetch is needed for the search path, and a direct body read must go through the loader. Also relevant: `sequelize-strict-attributes` is enabled, so reading an unselected attribute **throws** - the new tool must read `content`, never `text`. Folded into todos 4 and 5.
- **BLOCKER, unvalidated assumption (premise 1)** - every capability depended on the model *choosing* a tool, and tool choice is probabilistic. The library does support a named forced tool choice (`toolChoice` in the installed types, mapped onto the wire field), and the request body already passes through a permissive schema, so an explicit document reference can be resolved server-side and the first tool call forced. This is now todo 6, and it is the difference between a capability that works and one that works sometimes.
- **MAJOR, unvalidated assumption (premise 2)** - the prefill mitigation alone does not make "summarise this document" work: the probe reads the user's own text only (`server/routes/api/ai/scope.ts:97-104`), a title that does not lexically match, a whitespace-free script, a member who edits the prefill away, or a follow-up turn can all still be refused. The gate therefore gains a **second grounding source** - an explicitly resolved, authorized, non-archived document - and only for requests that carry one. The lexical path is untouched otherwise. Folded into todo 6.
- **MAJOR, missing constraint** - the external tool's body text comes from the document presenter with the include-text option, not from a direct markdown conversion, and its two paging shapes differ (the section branch carries only the section key). A shared reader that "returns the body" is not enough for byte-identical parity. Folded into todo 4.
- **MAJOR, missing constraint** - `ALTER TYPE ... ADD VALUE` and any statement that *uses* the new value must not be in the same query call: PostgreSQL rejects a new enum value used inside the transaction that added it. The repository's own majority pattern wraps a migration in an explicit transaction, which would trip this. The `ADD VALUE` and the usage must be two separate query calls, and no migration in this repository sets `transaction: false`. Folded into todos 2 and 9.
- **MAJOR, missed exposure** - the message list route uses an unrestricted authentication call, and a persisted tool-call digest would therefore be readable by any credential for that member. Resolved by storing a **body-free digest** (tool name, arguments, result identifiers, character count) - never the retrieved document text - and by leaving the route's authentication type untouched. Folded into todos 9, 10, 11.
- **MAJOR, upstream reality** - the model provider in this deployment is a separate agent that injects its own persona and its own read-only tool set against this product's own external interface, and one prior model configuration is documented as having overridden the injected persona so the workspace instructions had no effect. A repository-side instruction can therefore be discarded upstream. This is why the instruction layer ships **switched off** and why the plan measures rather than assumes the upstream honours what it is sent. Folded into todos 1 and 16.
- **MAJOR, verification limit** - this host has no reachable model gateway and this fork runs no CI, so **no end-to-end proof against a live model is possible**. Every acceptance criterion is a mocked-provider server test or a jsdom client test, and the plan and the documentation say so instead of implying live verification. Folded into todo 16 and into the verification strategy.
- **MINOR, tool-loop bound** - the library's default agent-loop strategy caps the tool loop at five model turns, and a "length" finish reason ends a run. The route configures no loop strategy of its own, so the existing lock-lifetime estimate already assumes five rounds. Recorded in todos 5 and 6.
- **MINOR, missed drift** - the persisted digest is written by the message creator through a short-lived context (`server/commands/aiChatMessageCreator.ts:64-105`), and the message presenter has two exact-shape assertions that break when it gains a field (`server/presenters/aiChatSession.test.ts:68-76,95-103` and `server/routes/api/ai/upstreamMessages.test.ts:666-674`). Folded into todo 11.
- **MINOR, action shape** - the action type has no document-context field; a document-scoped action resolves the document through the action context's active-model accessor and its policy. Folded into todo 13.
- **MINOR, draft conflict** - the panel restores a per-session draft on mount and on session change, so a prefill seeded at open time can be clobbered by that effect. Folded into todo 13.

## Decisions (with rationale)
| decision | rationale |
| --- | --- |
| Reuse the existing `searchForUser` provider call for every new tool instead of writing new query logic | The provider already applies membership scoping, archived filtering and `ts_rank` ordering; a new query path would duplicate authorization |
| Authorize a body read through `loadDocument`, not through the search provider's scoping | Provider scoping is a convenience for search; a direct id read must go through `authorize(user, "read", document)` |
| One shared reader in `server/commands/` consumed by both the AI tool and the MCP `fetch` tool | `server/commands/documentLoader.ts` already places a document read helper in `commands/`; duplicating the MCP chunk/section helpers would guarantee drift |
| Add `fetch_document` to the existing frozen allowlist rather than creating a new tool registry | `tools.ts:88,94-108` already enforces one server-owned, cached, frozen list; a second registry would be a second source of truth |
| Reuse `DocumentHelper.getAnchorContent` for section reads instead of the MCP's fuzzy heading matcher | The anchor helper is exported, stable, and already present; the MCP matcher is module-private |
| Prepend the document title to the client prefill text | The grounding gate probes **user text only** (`scope.ts:97-104`), so "summarize this document" alone would be refused before the provider is contacted; the title supplies real probe terms |
| Keep the client free of tool declarations | `ai.ts:569-572` states the security contract; `mergeAgentTools` must stay unused |
| Measure grounding instead of enforcing citations by default | Enforcement needs full-answer buffering, which removes streaming; the repo names the post-hoc check as the upgrade path |
| Persist tool calls in a dedicated column rather than inside the assistant text | The client renders stored assistant text verbatim; a digest inside `content` would be shown to the member as garbage |
| Keep the repo-side prompt operator-gated and off by default | The persona lives in the upstream gateway; flipping it on unconditionally would change production behaviour silently |
| Do not add pgvector/embeddings | No embedding infrastructure exists and none is needed for the four capabilities; the measured data from C4 decides later |
| Prepend the system prompt in the route (`ai.ts`), not inside `resolveUpstreamMessages` | The mapper's unit semantics stay pure (a stored window is still user/assistant only) and the blast radius of the change is 4 upstream-body assertions instead of every `toEqual` array assertion in `upstreamMessages.test.ts` |
| Store tool calls in a dedicated column on the assistant row, and relax the empty-assistant guard for turns that carry tool calls | `appendTurn` currently drops an assistant row with empty content (`middleware.ts:92-94`), so a tool-call-only turn would be lost; the digest must not be smuggled into `content` because the client renders that text verbatim |
| Copy the existing enum-migration pattern exactly (raw `ALTER TYPE ... ADD VALUE`, throwing `down`, no `transaction: false`) | No migration in this repository sets `transaction: false`; the `mcp` migration at `server/migrations/20260714000000-add-mcp-to-search-queries-source.js` is the proven precedent and PostgreSQL 12+ accepts `ADD VALUE` inside the migration transaction |
| Do not touch `server/routes/api/searches/schema.ts` | `source` is typed `z.string().optional()` there, so a new enum value needs no schema change; hardening it to an enum is a separate concern |
| Widen the client `SearchQuery.source` union to include `"mcp"` and the new value | `app/models/SearchQuery.ts:20` already omits `"mcp"`, so the client type is already drifting from the server enum |
| Update the client `SearchQuery` model and the `SearchesStore.recent` filter only if the new source is ever written | `app/stores/SearchesStore.ts:14-19` filters `source === "app"`; a new value must not appear in that list |
| The shared reader keeps the external tool's heading-TEXT section match; the anchor-based lookup is a separate, explicitly named path used only by the new AI tool | `getAnchorContent` matches by slug (`DocumentHelper.tsx:254-266`) while the external tool matches heading text case-insensitively (`fetch.ts:71`); reusing one for the other changes the external tool's contract, which the scope forbids |
| The grounding gate gains a SECOND grounding source - an explicitly resolved, authorized, non-archived document - and only for requests that carry one | The prefill mitigation alone is insufficient: the probe reads the user's own text only, so a non-matching title, a whitespace-free script, an edited prefill or a follow-up turn can still be refused. The second source is still fully authorized, so the knowledge-base boundary is not weakened |
| The first tool call is forced (named tool choice) only when a document reference resolved | Tool choice is probabilistic; without a forced first call "summarise this document" works only when the model picks the right tool |
| The persisted tool-call digest stores no document text - tool name, arguments, result identifiers, character count, truncation flag only | The message list route uses an unrestricted authentication call, so a stored body would be readable by any credential for that member, and document text must not sit at rest in a chat table |
| The enum migration issues the value change and any statement using it as SEPARATE query calls | PostgreSQL rejects a new enum value used inside the transaction that added it; the repository's majority pattern wraps a migration in an explicit transaction |
| The instruction layer ships switched off, and the upstream-override risk is documented rather than assumed away | The model provider in this deployment is a separate agent that injects its own persona and its own tool set, and a prior configuration is documented as having overridden the injected persona |
| The search provider's relevance score is the only ranking signal | Search's sort options cannot express the popularity score (`shared/types/filters.ts:12-16`); blending needs a second, non-provider query path, which is a later wave with its own measurement |
| Update the two existing AI docs in place, create no new markdown file | Root `AGENTS.md`: "Critical - Do not create new markdown (.md) files." |


## Scope IN
- A repo-side assistant instruction layer wired into the existing `chat()` call, operator-gated by an env flag, plus the env var in `server/env.ts` and `.env.sample`.
- A shared, authorized, capped document-body reader in `server/commands/`, with the MCP `fetch` tool refactored onto it and its output preserved exactly.
- A new `fetch_document` server tool in the existing frozen allowlist.
- `search_workspace` gains an optional, authorized collection scope and a bounded result count.
- A new `recommend_documents` server tool returning relevance-ranked candidates with an explicit reason.
- Grounding observability: `SearchQuerySource.Ai` plus a committed migration, AI retrievals recorded as search queries, refusal reasons counted, and a client-visible "no citation" marker.
- Tool-call persistence: a column on `ai_chat_messages`, the model/presenter/API/client-model/client-rendering changes it forces, and the message list shape.
- Client affordances: a prefill-capable `openAIChatPanel` bridge, a document-scoped "Ask AI about this document" action, optional starter chips in the empty state.
- Tests in the existing colocated suites (`server/routes/api/ai/*.test.ts`, `app/components/AIChat/*.test.tsx`, `app/utils/aiChat.test.ts`) and the shared reader's own test.
- In-place updates to `docs/AI-CHAT.md` and `docs/AI-CHAT-DESIGN.md`, including the seven drift items already identified.

## Scope OUT (Must NOT have)
- MUST NOT add any runtime dependency (no pgvector, no embedding client, no retrieval framework, no new npm package).
- MUST NOT add client-supplied tools, client-declared tool stubs, `forwardedProps` merging, or any other route behavior the current security comment at `server/routes/api/ai/ai.ts:569-572` forbids.
- MUST NOT add a write-capable tool, a document mutation, or any side effect to the AI chat path.
- MUST NOT create a new markdown documentation file; no `.md` outside `docs/AI-CHAT.md` and `docs/AI-CHAT-DESIGN.md` edits.
- MUST NOT change the MCP `POST /mcp` contract, its tool list, or its output bytes; the `fetch` result must be identical after the refactor.
- MUST NOT change the `ai.sessions.*` / `ai.messages.list` public route names, and MUST NOT break the `documents.*` RPC surface.
- MUST NOT relax, widen, or bypass the existing authorization path (`authorize`, `loadDocument`, `authorizeFilterFields`, provider membership scoping).
- MUST NOT remove or weaken the grounding gate, the archived-document filter, the in-flight lock, the rate limiter, the `AuthenticationType.APP` restriction, or the `RUN_ERROR` sanitization.
- MUST NOT hand-edit `shared/i18n/locales/`; translation strings are extracted automatically.
- MUST NOT run repo-wide `yarn format` or rewrite unrelated files; the repository has a large pre-existing format/lint baseline.

## Open questions
All five owner-decisions were put to the user and answered on 2026-10-22; each resolved to the recommended default. Recorded as decisions below, so the plan carries them as settled.

| # | question | answer | recorded as |
| --- | --- | --- | --- |
| Q1 | Persona ownership - who owns the assistant's instructions | **Repo-side layer present but OFF by default**; the operator opts in per deployment | New env flag + `server/routes/api/ai/prompt.ts`, off by default, documented in `.env.sample` |
| Q2 | Citation strength | **Measure + warn, no hard refusal**; server counts citation misses, the client shows a visible marker | `ponytail:` ceiling on the prompt module + a client-side marker; no answer buffering |
| Q3 | Data egress cap | **MCP parity: 20000 default, 60000 max, `truncated` flag** | Shared reader owns the caps; the AI tool returns `truncated: true` and can request a section |
| Q4 | Tool-call storage shape | **Dedicated jsonb column on `ai_chat_messages`** | New migration + `AIChatMessage` model + presenter + client model + client rendering |
| Q5 | Test strategy | **Tests-after, extending the existing colocated suites**, plus one new test file for the shared reader | Every todo carries its own test work; no new test directories |

## Approval gate
status: approved - plan v5 written - round 5 complete; both lanes approved, zero blockers
review_required: false
plan_path: .omo/plans/ai-chat-grounded-tools.md
plan_sha256: oracle echo becb1770b6e7baf1008f965b78d515e1cb33ad10278ad9c22… (momus excerpt becb1770b6eba7f1008f… differs by one transposed triplet — cryptographically impossible for identical frozen bytes; momus output mirrors the prep-draft structure, so its digest is treated as non-independent artifact; oracle echo taken as the genuine recompute; file frozen since lane launch)
review_round_id: rar-2026-10-22-05
round_status: complete
pending-action: handoff to $ulw-execute ai-chat-grounded-tools
rounds:
  - id: rar-2026-10-22-01
    artifact: v1
    momus: changes_requested (M1, M2, M3 + 3 notes)
    independent: superseded - the lane had not emitted a verdict when the v1 fix pass started; its v1 findings cannot bind a v2 artifact
    fixes_applied: v1 -> v2 fix pass accepted all three blockers and all three notes
  - id: rar-2026-10-22-02
    artifact: v2
    momus: changes_requested (M4) + 5 notes; digest 1e582681f7791602f3f25dd050d3c147f219f9d75df2b69fbb047b666e4ef5fb
    independent: changes_requested (B1-B7); digest matches momus (same bytes)
    fixes_applied: v2 -> v3 fix pass accepted every blocker from both lanes and the actionable notes
  - id: rar-2026-10-22-03
    artifact: v3
    momus: changes_requested (R3-1, R3-2, R3-3); digest 9907864540747790B89286785D464AF5D4C374AF7619BBCAEA1C2BCABAF5260C
    independent: changes_requested (N1, N2, N3); digest matches momus
    fixes_applied: v3 -> v4 fix pass accepted every blocker from both lanes plus the actionable notes
  - id: rar-2026-10-22-04
    artifact: v4
    momus: changes_requested (B1 schema requires an identifier vs "no id" acceptance; B2 no client wire path for documentId; B3 evidence incomplete for IS-3/IS-4/IS-8); digest 686F82BEF329356C16BF1DE63FE8CD71ADF84C9AD1B41AAA521A88AAC3E9CE49
    independent: changes_requested (B1 same wire-body defect; B2 tools.test.ts name lists + todo 8 length); digest matches momus (same bytes)
    fixes_applied: v4 -> v5 fix pass accepted every blocker from both lanes plus the actionable notes
  - id: rar-2026-10-22-05
    artifact: v5
    momus: approved (bg_38031971, ses_e992ef506ffev76JG2R6LkXJUT); digest excerpt becb1770b6eba7f1008f… (non-independent — echoes prep-draft hash; see plan_sha256 note)
    independent: approved (bg_a7ef0cbe, ses_e992ecd57ffeF7IjeMkWsc7tp2); digest echo becb1770b6e7baf1008f965b78d515e1cb33ad10278ad9c22…
    verdicts: approved / approved; blockers: none / none
review:
  momus:
    status: changes_requested
    workspace_root: D:\Work-Project\Outline-YGPKB\outline-ygpkb
    runtime_home: null
    target: .omo/plans/ai-chat-grounded-tools.md
    round_id: rar-2026-10-22-01
    launch_id: launch-momus-01
    session: ses_e9d5e09a9ffemlv3D0OC26VKOz
    result: artifact_sha256=bc14f6cd1219dcb03d51408a5ccc4d58917662ae5bd9b61521ed5348d7489ec6 verdict=changes_requested blockers=M1,M2,M3 citation_sweep=~90 refs all exist
    triage:
      M1: accepted - X-AI-Chat-Kind is set before the body is assigned and the client reads it the instant fetch resolves, so a post-answer value cannot travel in a header; fix = carry the flag on the persisted turn (the plumbing todos 9-12 already build) and read it back on the client, with an explicit ceiling that no in-stream frame is used
      M2: accepted - the upstream window is rebuilt from seq/role/content only, so a display-only digest cannot make a follow-up turn "use" the earlier read; fix = restate IS-4 and its proving scenario to what is delivered (the turn is stored, exposed and re-rendered), and drop the "a later turn can use it" claim
      M3: accepted - the manifold loader throws NotFoundError and, with paranoid:false, resolves trashed documents into a restore-authorization error, which diverges from the external tool's findByPk rejectOnEmpty message; fix = the external wrapper keeps its own existence lookup and hands the loaded document to the reader
      note-1: accepted - the four pinned upstream-body assertions must stay the flag-off case, not become unconditional system-message expectations
      note-2: accepted - todo 6 gains an archived-reference refusal case
      note-3: accepted - two citation imprecisions corrected (scope.ts ungated branch, popularity sort location)
  independent:
    status: superseded (round 1)
    workspace_root: D:\Work-Project\Outline-YGPKB\outline-ygpkb
    runtime_home: null
    target: .omo/plans/ai-chat-grounded-tools.md
    round_id: rar-2026-10-22-01
    launch_id: launch-oracle-01
    session: ses_e9d5de051ffe7tA54akP7zxFm7
    result: no verdict emitted; the lane was still running when v1 was frozen into v2 (last activity 09:07, 85 messages). Replaced by launch-oracle-02 on v2.
plan-v2-ledger:
  - todo 3 now forbids a response header for the citation flag and cites ai.ts:281-282 + app/utils/aiChat.ts:253 as the proof; the flag is computed at the terminal hook and threaded out of the middleware
  - todo 10 stores the flag alongside the digest; todo 11 exposes it through the presenter and the client model; todo 14 renders the marker from the stored turn and re-reads the session on run finish (AIChatMessagesStore:61-72)
  - dependency matrix updated: 3 blocks 10, 10 depends on 3
  - IS-4, its Success-criteria row, the TL;DR line, the deliverables bullet, F3 and F4 restated: the digest is display/audit data and is deliberately not fed back to the model (ForwardableRoles excludes system)
  - todo 4: the MCP wrapper keeps its own findByPk rejectOnEmpty lookup and hands the loaded document to the reader; missing-document assertion and QA case added
  - todo 1: the four pinned-body assertions stay the flag-off case; flag-on gets separate assertions
  - todo 6: archived-reference refusal test and QA case added; scope.ts citation corrected to 254-256
  - todo 8: popularity citation corrected (documents/schema.ts:60 is the sort option, documents.ts:415-427 the order builder)
plan-v3-ledger:
  - B1: the document reference no longer skips the lexical probe; it only binds the body tool and drives the first tool call, so the gate stays a gate and todo 13's title rationale is now consistent
  - B2: first-call-only forcing via a middleware onConfig (named choice for call 1, "auto" after); chat()-level toolChoice is documented as applying to every call (dist js:686,2687); the body tool is bound to the resolved document so the model's arguments cannot pick a different document
  - B3: archived refusal is explicit (archivedAt check after the load) for both the reference path and the body tool; the loader and the read policy do not exclude archived documents
  - B4: both tool calls pass usePopularityBoost:false; the false "provider cannot express popularity" claim is replaced by the real option and its default
  - B5: IS-5 reworded to what ships, and todo 3 now logs every gate refusal with its reason, so the refusal rate is countable without new storage
  - M4/B6: IS-8 and todo 5 QA name the three server-owned tools instead of "the two server tools"; the machine TL;DR says two new tools plus one extension
  - B7: F3 downgraded to an agent-executed wiring harness (no browser, no live model) and the verification strategy records the ceiling
  - notes: todo 9 down is DROP COLUMN IF EXISTS with a rollback+re-migrate QA; todo 14 rides the existing post-stream re-read (AIChatPanel:590-602) instead of adding a second fetch; digest arguments are limited to declared scalar fields; the reader exposes two explicit entry points (loaded document vs id+user); IS-4 evidence points at task-12; wave prose now matches the matrix
plan-v4-ledger:
  - R3-1/N2: the refusal half of IS-5 is stated as already shipped (busy log ai.ts:384-387, grounding log with reason :508-511); the duplicate "emit one log per refusal" instruction is deleted and the acceptance now asserts the existing line plus no second line; GAP-5 says only the hit rate and the unsourced-answer rate were unmeasurable
  - R3-2/N1: the binding moved off the tool array and onto the existing tool context ({ user, boundDocumentId } at ai.ts:614); the frozen allowlist, cached promise and schema stay untouched; the plan cites assertUniqueToolNames (dist js:2678) as the reason a duplicate per-request tool cannot be appended; the Must-NOT guardrail now carves out a server-side binding and keeps every client-supplied path forbidden
  - R3-3: todo 13 now sends the reference as the `documentId` field todo 6 reads and clears it after the first send; the wire-body assertion (app/utils/aiChat.test.ts:329-356) is named as the proof
  - N3: IS-3 reworded to the shipped guarantee (unsourced answers are marked and counted; the instruction layer asks for citations only when enabled), and F4 matches
  - notes folded: todo 1 no longer says to rewrite the four pinned assertions; todo 5 names the tools.test.ts:157-161 length assertion, calls the archived refusal a tool error, puts the archived rule in one helper, and corrects the Document scope citation (150-167, 179-185); todo 6 cites the real per-call onConfig locations (index.d.ts:156-167, middleware/types.d.ts:556, index.js:446,478,2410-2430) and keys the choice on the hook phase; todo 13 acknowledges activeDocumentId; matrix row 9 no longer claims parallelization with 12; wave-4 prose notes 14 also needs 3; F2 audits only the ceilings the todos call for; IS-5 evidence cites task-2 + task-3; the CI and browser-harness ceilings were reworded to what is observable
plan-v5-ledger:
  - "B1 (momus): todo 5's static schema now makes the document identifier optional and refuses at execution when neither an identifier nor a context binding is present, so the todo 6 acceptance 'even when the model supplies no id' is reachable; todo 6 keeps the schema unchanged as it claimed"
  - "B1/B2 (wire body): todo 13 names the actual seam - createAiChatConnection (app/utils/aiChat.ts:248-281) gains a per-request documentId and observeFetch parses init.body, adds the top-level key and re-serializes it before calling fetch; forwardedProps stays empty; both wire tests (281-293 and 329-356) are named, and the busy path restores the binding with the composer text"
  - "B2 (oracle): todo 5 updates the two tool-name list assertions (tools.test.ts:201-205, :262-266) to two tools; todo 8 updates the frozen length (:157-161) to three and both name lists to include recommend_documents"
  - "B3 (momus): evidence now spans the delivering todos - IS-3 task-3 + task-10 + task-14, IS-4 task-10 + task-11 + task-12, IS-8 task-5 + task-8"
  - "notes folded: ServerToolContext (tools.ts:17-20) is named as the type to extend; archived and soft-deleted documents are both refused in the shared helper and in the reference path (the loader authorizes restore for a trashed row); todo 4 names the third paging emitter (fetch.ts:280-289); todo 2 drops the contradictory 'follow exactly' + IF NOT EXISTS + second-query instruction; F2 audits only todo 8's ceiling; todo 16 names docs/DEPLOYMENT.md and docs/FRONTMATTER-PLAN.md and the four-document scope; the TL;DR pointer now names Scope; IS-5 and GAP-5 say count, not rate"
  - "review round 5 (rar-2026-10-22-05): momus approved (zero blockers), independent approved (zero blockers); convergence achieved on v5"
approach: Four waves, no new runtime dependency. (1) Foundations: a repo-side assistant instruction layer (TanStack `systemPrompts`, operator-gated, off by default), AI retrievals recorded under a new search-audit source, a citation-miss measurement, and one shared authorized capped document-body reader that the external agent interface keeps using byte-identically. (2) Tool surface: a read-only body tool in the frozen allowlist, a deterministic server-resolved document reference that grounds the request and forces the first tool call, an authorized collection scope on the search tool, and a relevance-ranked recommendation tool. (3) Persistence: a jsonb column holding a body-free tool-call digest, the write path that fills it, the API and client model that expose it, and the panel that re-renders it. (4) Client and documentation: a prefill bridge plus a document-scoped action, starter prompts plus a no-source marker, the client tests, and the in-place documentation pass.
next workflow action: review complete (rar-2026-10-22-05, both lanes approved, zero blockers); hand off to a worker session via `$ulw-execute ai-chat-grounded-tools`.
extrinsic constraint sweep: budget/spend - no new paid service, the provider is the operator's existing gateway; only a marginal token increase per turn, so defaulted (no new service, no new dependency). Mandated stack - yarn, oxlint/oxfmt, no new npm package, no new markdown file; explored and fixed by repo mandate. Scale - the route is already rate limited at 10/min with a 900s in-flight lock; the library caps the tool loop at five model turns; one extra tool round per turn is bounded by the existing lock; defaulted (no capacity fork). Target audience / compliance - internal workspace content, no regulated data path identified in the repo; the two real axes are content egress (surfaced as owner-decision Q3, answered with MCP parity) and what the model provider does with instructions and tools sent to it (documented as a ceiling in todo 16, not assumed).
test strategy: CONFIRMED by the user on 2026-10-22 - tests-after, extending the existing colocated suites, plus one new test file for the shared reader. Agent-executed QA is included in every todo.

