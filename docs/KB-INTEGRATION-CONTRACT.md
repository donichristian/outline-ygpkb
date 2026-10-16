# KB Integration Contract — Knowledge Management System SKI

**Status:** draft / design (not yet enforced)
**Systems:** Knowledge Management System SKI (Outline KB) · Hermes (agent/broker) · external consumers (LMS, HRIS, future)
**Related:** `docs/HERMES-OUTLINE-ARCHITECTURE.md` (how the agent↔KB path is built)

> **Goal:** define the *stable interface* by which other systems consume the KB,
> so consumers are not coupled to internals. This is a contract to adopt and
> then enforce, not a description of guaranteed behavior yet.

---

## 1. What this contract covers

How an external system (LMS, HRIS, automation, or an AI agent) can, with a
least-privilege credential:
- **read** the KB (search, list, fetch, export),
- **be notified** of KB changes (webhooks or polling),
- **write** into the KB (documents + attachments),
- via one of two supported integration **patterns** (§6).

Non-goals: UI embedding, unauthenticated public consumption, per-school tenant
isolation (one shared instance per decision #4).

## 2. Canonical interfaces (verified today)

| Interface | Direction | Maturity | Notes |
|-----------|-----------|----------|-------|
| RPC API `POST /api/<resource>.<action>` | in | strong | ~120 endpoints; RPC, not REST |
| API keys (`ol_api_…`, hashed, `scope[]`, `expiresAt`) | in | strong | least-privilege scopes |
| OAuth2 auth-code + PKCE + refresh + DCR | in | strong | for interactive/3rd-party |
| MCP server `POST /mcp` (19 tools) | bi | strong | stable SDK; tool names Outline-specific |
| Webhooks (HMAC-SHA256, `Outline-Signature`) | out | strong | reactive change feed |
| Exports (json / markdown / okf / html / textbundle / pdf) | out | strong | via `collections.export` (async) |
| Full-text search API | in | strong | Postgres tsvector, membership-scoped |

## 3. Authentication & scopes

**Credential per consumer** (one API key or OAuth client per external system).

Scope grammar (`shared/helpers/AuthenticationHelper.ts`):
`*` · `read|write|create` · `<namespace>:(read|write|create)` · `/api/<namespace>.<method>`.

**Recommended grants:**

| Consumer | Grant | Effect |
|----------|-------|--------|
| LMS (course/module catalogue sync) | `documents:read` + `/api/collections.*` | read KB, no writes |
| HRIS (staff/onboarding SOP lookup) | `documents:read` | read-only |
| Automation (owns a collection) | `/api/documents.*` | scoped write |
| AI agent (Hermes) | `read` + `write` (MCP) | tool-level gating |

Rules:
- **Never grant `*` to external consumers.** Use route/namespace scopes.
- Set `expiresAt` on API keys; rotate via re-issue.
- Write access is **never anonymous** (enforced: all write routes require auth).

## 3b. Large documents (retrieval granularity)

Documents can be large (the YGPKB regulation PDFs are ~167 KB of text each). A
single MCP `fetch` that returns the whole body overflows a consumer's tool-output
budget, so the `fetch` tool supports **granular reads** of a document:

| Param | Effect |
|-------|--------|
| `section: "<heading text>"` | Returns only the section whose heading contains the text, down to the next heading of the same/higher level. Best for structured documents. |
| `offset` + `limit` | Page through the body by character range. |
| *(neither)* | Bodies over `limit` (default 20000, max 60000 chars) are auto-chunked. |

The metadata block reports `paging: { start, end, total, hasMore }` so a consumer
knows there is more and how to fetch it. Consumers should **search first**
(`list_documents` returns focused snippets), then read only the needed
section/chunk — never pull a whole large document in one call.

> This is deliberately **granularity**, not RAG/graph. Outline search is keyword
> (`tsvector`) and already returns snippets; the fix for large-document questions
> is reading the right region, not adding a vector store.

## 4. Read surface (contract-level)

Canonical read actions an external consumer may rely on:
`documents.search`, `documents.list`, `documents.info`, `documents.export`,
`collections.list`, `collections.info`, `collections.documents`,
`collections.export`, `collections.export_all`, `events.list`, `revisions.*`,
`attachments.*`, `users.info`, `shares.info`.

- **Envelope:** `{ data, policies, pagination, ok, status }` (list routes).
- **Filters:** typed expression list on `documents.list`/`search`.
- **Pagination:** `offset`/`limit` where present; **absent** on
  `events.list`, `revisions.list`, `collections.documents` (see §7 G2).
- **Rate limits:** per credential+IP; expect `429` with `Retry-After`,
  `RateLimit-Limit/Remaining/Reset`. Defaults up to 1000/window; hot routes
  lower (25–100/min). Consumers MUST implement backoff.

## 5. Change feed (contract-level)

Preferred: **webhooks**.
- Subscribe via `webhookSubscriptions.create` (**admin role required**).
- Payload signed: header `Outline-Signature: t=<ts>,s=<hmac>`.
- Verify HMAC-SHA256 over `<ts>.<body>`; reject stale timestamps.
- Auto-disabled on sustained failure; deliveries are logged.

Fallback: **poll `events.list`** by `createdAt` cursor (no offset/limit).

## 6. Supported integration patterns

```
Pattern A — Direct consumer (system speaks REST or MCP)
  External ──(scoped key/OAuth)──► KB API (/api/*, /mcp)
           ◄──(signed webhook)─── KB events
  Use: systems with developers; catalogue/document sync; read-first.

Pattern B — Brokered consumer (system can't speak KB protocols, or needs AI)
  External ──(HMAC webhook / OpenAI-compat)──► Hermes
  Hermes ──(MCP / API / code HTTP)──► KB (+ other systems)
  Use: legacy systems, AI-mediated lookup, the US-A / US-B workflows.
```

Neither pattern requires modifying Outline or Hermes core.

## 7. Gap-closure backlog (what to build to make this contract real)

| ID | Gap | Recommended action | Priority |
|----|-----|--------------------|----------|
| G1 | No OpenAPI spec / no API version | Generate OpenAPI from zod schemas; introduce `/api/v1` prefix | **High** |
| G2 | No cursor pagination (and none on `events.list`/`revisions.list`/`collections.documents`) | Add cursor tokens; bound list responses | High |
| G3 | Change feed needs admin webhook or coarse polling | Add a per-credential delta feed / non-admin webhook scope | Medium |
| G4 | No unauthenticated JSON read (`/s/:shareId` is HTML) | Add a token/scope-limited JSON share read | Medium |
| G5 | MCP stateless + tool-name-coupled | Document tool contract; version tool set | Medium |
| G6 | Hermes has no built-in HTTP tool | Provide an `http_request` tool or MCP connector per consumer | Medium |
| G7 | No native LMS/HRIS protocols (LTI/SCIM/xAPI) | Build adapters (Hermes plugin/code or thin service) only when a concrete system is named | Deferred |
| G8 | Production deployment undecided | Resolve hosting/TLS/secrets before go-live | **Blocker (go-live)** |

## 8. Compatibility rules (once adopted)

- Action strings (`POST /api/x.y`) are the contract key: **renaming is breaking**.
- Additive changes are safe; removals/renames require a version bump.
- Webhook payload shape changes are breaking; version the event envelope.
- Publish breaking changes with a deprecation window.

## 9. Open questions

1. Do we adopt an `/api/v1` prefix (G1) — and is that acceptable to upstream-fork constraints?
2. Is a non-admin webhook scope acceptable (G3), or keep webhook admin-only for security?
3. Which external system (if any) is first, to drive G6/G7 concretely?
4. Secret governance: who owns credential issuance/rotation per consumer?
