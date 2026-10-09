# Hermes ⇄ Outline — Design Architecture

**Status:** implemented (local dev, verified 2026-10-08)
**Audience:** engineers designing/extending the agent ↔ KB integration
**Companion docs:** `docs/HERMES-INTEGRATION.md` (setup runbook),
`docs/KB-INTEGRATION-CONTRACT.md` (external contract),
`docs/FOUNDATION-ARCHITECTURE.md` (system-of-systems design)

This document describes **how** Hermes and Outline are wired together:
components, protocol stack, data flow, trust boundaries, and failure modes.
It complements — and does not repeat — the step-by-step runbook.

---

## 1. Roles

| System | Role in the integration |
|--------|-------------------------|
| **Hermes** | MCP **client**. Reads/writes the KB by calling Outline's MCP tools. Also the orchestration brain (email, cron, approvals). |
| **Outline (KB)** | MCP **server** (`/mcp`). Exposes KB operations as scoped tools; enforces auth and authorization. |

The deployed bot persona is **Matius** — a Bahasa Indonesia, KB-only assistant
whose capabilities are **allow-listed to the registered KB tools** (see §8b for
the gate and §8c for the persona layer).

One direction of agent interface: **Hermes → Outline MCP**. (Hermes can also be
an MCP server itself — `hermes mcp serve` — but that is out of scope here.)

## 2. Protocol stack

```
Hermes agent loop
  └─ MCP client            (@modelcontextprotocol/sdk in Hermes: tools/mcp_tool*.py)
       └─ Streamable HTTP  POST /mcp
            └─ Outline MCP route    server/routes/mcp/index.ts
                 └─ StreamableHTTPServerTransport (stateless)
                      └─ createMcpServer(issuer, scopes, guidance)  server/mcp/index.ts
                           └─ tools/*  (19 tools, scope-gated)
                                └─ commands/ · models/ · policies/ · presenters/
```

- **Transport:** Streamable HTTP, **stateless** (`sessionIdGenerator: undefined`);
  a fresh `McpServer` is built **per request** — no session affinity, horizontally scalable.
- **Methods:** `POST /mcp` only. `GET`/`DELETE` → `405`; legacy SSE paths → `404`.
- **SDK:** Outline and Hermes both build on the official `@modelcontextprotocol/sdk`.

## 3. Authentication & authorization

### 3.1 Credential
An **Outline API key** (`ol_api_…`) sent as `Authorization: Bearer …`. The MCP
route accepts `AuthenticationType.MCP | OAUTH | API`; in practice Hermes
authenticates as **API** (bearer header; cookies rejected).

### 3.2 Least-privilege scopes (as deployed)
Hermes's key `hermes-local-scoped` carries namespaced scopes matching exactly the
namespaces the tools use — **no `*`**:

```
documents:{read,create,write}   collections:{read,create,write}
comments:{read,create,write}    attachments:create
templates:read                  users:read
```
Expiry: 90 days. Scope grammar: `shared/helpers/AuthenticationHelper.ts`.

> The key retains write-capable scopes as a **defense-in-depth** layer, but the
> Matius bot never exercises them: its tool allowlist (§8b) exposes only the read
> tools, so no write tool is even registered for the agent. The scopes exist so
> the *same* credential would still work if a write tool were deliberately
> re-enabled later.

### 3.3 Two-layer enforcement
1. **Tool registration** — `createMcpServer` receives the token's scopes and only
   registers tools the scopes permit (`canAccess("<resource>.<method>", scopes)`).
   A read-only key never sees write tools in `tools/list`.
2. **Policy** — inside each handler, `authorize(user, action, model)` from
   `server/policies/` enforces object-level abilities. Tools always authorize
   before data access.

### 3.4 Workspace gate
`/mcp` returns **404** unless the team has `TeamPreference.MCP` enabled. This is
independent of the key — a valid key to a non-MCP workspace sees nothing.

## 4. Server identity & instructions

`createMcpServer(origin, scopes, guidance)` composes the handshake:
- **identity:** name `outline`, title, `version` (from `package.json`), website, icons;
- **capabilities:** `tools`, `resources`, `extensions` (skills, SEP-2640);
- **instructions:** `defaultInstructions` (markdown rules, mention syntax,
  attachment/base64 handling, template use) **+** the team's `guidanceMCP`,
  appended verbatim. This is the workspace's prompt-injection point for KB conventions.

## 5. Tool catalog (19 tools)

> The full server exposes 19 tools, but the **Matius bot only sees the 7 read
> tools** (`list_collections`, `list_collection_documents`, `list_documents`,
> `list_comments`, `list_templates`, `list_users`, `fetch`) due to the tool
> allowlist in §8b. The write tools below exist on the server for other,
> non-Matius consumers.

| Group | Tools | Write? |
|-------|-------|:------:|
| documents | `list_documents`, `list_collection_documents`, `create_document`, `update_document`, `move_document`, `delete_document`, `restore_document` | mixed |
| collections | `list_collections`, `create_collection`, `update_collection`, `delete_collection` | mixed |
| comments | `list_comments`, `create_comment`, `update_comment`, `delete_comment` | mixed |
| attachments | `create_attachment` | write |
| templates | `list_templates` | read |
| users | `list_users` | read |
| generic | `fetch` (document/collection/user/attachment/template) | read |

- Return shape: one text block per array element (compact JSON); document/template
  fetches hand-build a metadata block **+** a raw markdown body.
- Skills (`capture-conversation`, `collection-digest`, `find-and-cite`,
  `meeting-notes`) are served as `skill://` resources + `skills/list|get` methods —
  **methodology, not executable tools**; they orchestrate the tools above.

## 6. Data flow

**Read path (what Matius actually does):**

```
Hermes tool call: fetch {resource: "document", id}
  → POST /mcp (Bearer <api key>)
    → Outline: auth() resolves user + scopes
      → MCP route builds server with scopes + team guidance
        → tool handler gated by canAccess("documents.info", scopes)
          → authorize(user, "read", document)
            → presenter builds metadata + markdown body
  ← two content blocks: JSON metadata, then raw markdown
  ← Hermes cites title + URL in its answer
```

**Write path (exists on the server; NOT exposed to Matius — see §8b):**

```
Hermes tool call: create_document {title, text, collectionId}
  → POST /mcp (Bearer <api key>)
    → Outline: auth() resolves user + scopes
      → MCP route builds server with scopes + team guidance
        → tool handler gates on canAccess("documents.create", scopes)
          → authorize(user, "createDocument", collection)
            → commands/documentCreator()  (saveWithCtx → audit Event row)
              → presentDocument() → tool returns metadata + markdown
  ← Hermes receives the result; optionally re-fetches to verify
```
Every write threads a transaction/context and emits an audit `Event` — the same
events that feed Outline's webhook plugin (out of scope here, see KB contract).

## 7. Trust boundaries

```
Trusted: Hermes host (config.yaml, .env, mcp-tokens/)
  │  bearer token (per-workspace, scoped, expiring)
  ▼
Semi-trusted: Outline /mcp (auth + scope + policy enforced)
  │  workspace gate (TeamPreference.MCP)
  ▼
KB data (membership-scoped; soft-delete; audit)
```

- The **token is the whole trust**: possession grants the key's scopes. Store
  only in `.env` (never in prompts/docs); rotate on schedule.
- Outline treats tool calls like any API caller: membership scoping, policies,
  rate limiting, and audit apply uniformly.
- Webhook-triggered agent runs (inbound) are a distinct boundary, covered in the
  KB integration contract.

## 8. Deployment topology & config (local dev, verified)

- **Outline:** `http://localhost:3050` (`web` service mounts `/mcp`).
- **Hermes config:** `C:\Users\Media\AppData\Local\hermes\config.yaml` →
  `mcp_servers.outline` = `{ url, headers.Authorization: "Bearer ${OUTLINE_MCP_TOKEN}" }`.
  **Hermes reads this path**, not `~/.hermes/config.yaml` (verified via `hermes config path`).
- **Secret:** `OUTLINE_MCP_TOKEN` in `C:\Users\Media\AppData\Local\hermes\.env`.
- **Issuer:** Outline derives the MCP issuer from `env.URL`; dev uses
  `http://localhost:3050` (`.env.local`). An API key bypasses OAuth issuer
  discovery, so mismatches only affect the OAuth flow, not API-key auth.

## 8b. Matius capability gating (tool / domain allow-listing)

The bot — **Matius** — is deliberately limited to **registered tools/domains** so
non-KB requests are *structurally* unanswerable, not merely discouraged by
prompting. This is enforced in Hermes' config (not in the repo), in two layers.

### Layer 1 — Toolset allowlist (`platform_toolsets`)

The Matius surfaces (`cli` and `telegram`) are pinned to only the KB toolset plus
`clarify`:

```yaml
platform_toolsets:
  cli:      [mcp-outline, clarify]
  telegram: [mcp-outline, clarify]
```

This removes every other capability — web search, browser, terminal, files, code
execution, memory, cron, computer-use, process tools — so the agent has **no tool
path** to answer an off-topic question. Verified with `hermes tools --summary`:
`CLI (3/28)` · `Telegram (3/28)` (only `mcp-outline` + Clarifying Questions).

> Add a future system by appending its MCP server, e.g. `[mcp-outline, mcp-lms, clarify]`.
> Each registered system gets its own tool allowlist in Layer 2.

### Layer 2 — Per-MCP read-only allowlist (`mcp_servers.<name>.tools.include`)

Even within the KB toolset, only the **read** tools are exposed to Matius:

```yaml
mcp_servers:
  outline:
    # … url / headers / enabled / timeouts …
    tools:
      include:
        - list_collections
        - list_collection_documents
        - list_documents
        - list_comments
        - list_templates
        - list_users
        - fetch
```

At runtime this drops the tool count from **21 → 9** (7 allowlisted + 2 MCP
resource helpers). Every write path — `create_*`, `update_*`, `delete_*`,
`move_*`, `restore_*`, `create_attachment` — is **absent**, so the KB cannot be
written to via the bot at all.

### What each layer buys

| Layer | Mechanism | Effect |
|---|---|---|
| Toolset allowlist | `platform_toolsets.<surface>` | Only `mcp-outline` + `clarify` reachable; no non-KB tools exist to answer off-topic questions |
| MCP tool include | `mcp_servers.outline.tools.include` | Read-only within the KB; writes structurally impossible |

Prompt rules (SOUL.md, `guidanceMCP`) are **defense in depth** on top of this
structural gate — they shape tone and citations, but correctness of scope is
enforced here, not by the model.

### Verifying the gate

```bash
hermes tools --summary                 # CLI / Telegram show 3/28
hermes tools list                      # web/browser/terminal/file disabled; outline include-only
# runtime truth (agent.log / gateway.log):
#   "MCP server 'outline' (HTTP): registered 9 tool(s): list_collections, …"
```

The gateway must be restarted to pick up config changes:
`hermes gateway restart`.

### Known nuance — `tool_search activated` log line

`agent.log`/`gateway.log` may show `tool_search activated (tier 1): 23
core/visible tools kept, N deferred`. This is `tool_search`'s **internal
schema-budget accounting** (how many tool schemas are shown immediately vs.
deferred for context economy) — **not** the granted toolset. The authoritative
signals are `hermes tools list` / `--summary` and the MCP `registered N tool(s)`
line.

> **Production deployment is OPEN** (see `docs/FOUNDATION-ARCHITECTURE.md`):
> TLS/domain, secret management, and rotation are unresolved.

## 8c. Persona & prompt layer (defense in depth)

Above the structural gate (§8b), two prompt sources shape behavior. Neither is
load-bearing for scope — that is enforced structurally — but they govern tone,
language, and citation style.

| Layer | Location | Controls |
|-------|----------|----------|
| **SOUL.md** (agent identity) | `~/AppData/Local/hermes/SOUL.md` | Persona ("Matius"), Bahasa Indonesia + sopan/formal/baku tone, KB-only scope, refuse malicious / PII / off-scope requests |
| **guidanceMCP** (workspace instructions) | Outline team settings → surfaced in the MCP handshake `instructions` | Read-only stance, retrieve-before-answer, cite the source, never invent facts |

> **Model matters.** The persona/guardrails are only honoured reliably by models
> that respect the injected system prompt. On this setup the model is `ski-bot`
> (an agent-router at `localhost:20127`); an earlier `zen-combo` configuration
> overrode the system prompt with its own persona, so SOUL.md had no effect.
> If the bot starts ignoring SOUL.md, check the active model first.

## 9. Failure modes

| Symptom | Likely cause | Design response |
|---------|--------------|-----------------|
| `401` | missing/invalid/expired bearer | rotate key; check `.env` resolution |
| `404` on `/mcp` | `TeamPreference.MCP` off | enable in workspace settings |
| Short tool list | key scope too narrow | widen scopes (still least-privilege) |
| Bot ignores SOUL.md / scope | wrong model (agent-router overriding system prompt) | switch to a compliant model (e.g. `ski-bot`) |
| Bot answers off-topic questions | toolset allowlist not applied | check `hermes tools --summary`; restart gateway |
| `AuthorizationError` inside a tool | object-level policy denial | expected; membership-scoped |
| Connection refused | Outline web service down | start dev stack; health `/_health` |
| `${VAR}` unresolved | token missing in Hermes `.env` | Hermes **fails closed** for remote servers |

Idempotency: Outline writes are not idempotent per se; callers should treat
create/update as state changes and reconcile on retry (e.g., idempotency by row
or document id at the caller).

## 10. Extension points

- **New Outline tool:** add a module under `server/mcp/tools/`, gate with
  `canAccess`, authorize with policies — it appears automatically, scope-filtered.
- **Expose a new tool to Matius:** add it to `mcp_servers.outline.tools.include`.
- **Add a whole new system (LMS/HRIS):** register its MCP server, then append it
  to `platform_toolsets.cli`/`telegram` and give it its own `tools.include`
  allowlist — no other change.
- **New KB convention:** set `guidanceMCP` (settings) — no code change.
- **New skill:** add `SKILL.md` under `server/mcp/skills/` (YAML frontmatter).
- **Richer agent behavior:** Hermes skills/plugins/cron wrap the same MCP surface.
- **Other consumers:** the same MCP server + the REST API + signed webhooks serve
  LMS/HRIS — see `docs/KB-INTEGRATION-CONTRACT.md`.

## 11. Design decisions & rationale

| Decision | Why |
|----------|-----|
| MCP over ad-hoc REST for the agent | Typed, discoverable tools; scope-filtered per token; standard SDK both ends |
| Stateless `/mcp` | No session state; scales horizontally; simple retries |
| API key (not OAuth) for Hermes local | Fewest moving parts; no browser flow; least-privilege scopes still apply |
| Scoped, expiring credential | Limited blast radius; fits contract's per-consumer credential model |
| Team-gated MCP | Admin control over whether a workspace is agent-accessible at all |
| **Toolset allowlist over prompt-only scope** | Prompt rules are probabilistic (they leaked ~50% of off-topic answers); removing the tools makes off-scope questions structurally unanswerable |
| **Read-only `tools.include` for Matius** | Enforces the "no writes" requirement at the tool layer; writes are impossible rather than discouraged |
| Model choice pinned to a compliant model | An agent-router model can override the system prompt, silently defeating SOUL.md |

## 12. Open questions

1. Rotate key on the contract's cadence — who owns rotation?
2. Should inbound (webhook/run-API) auth be standardized alongside this outbound path?
3. Versioning the MCP tool surface (KB contract G5) — when tool names change.
4. Which additional systems (LMS/HRIS) get added to the allowlist, and in what order?
