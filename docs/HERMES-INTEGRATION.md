# Hermes ⇄ Outline — API-key dry-run runbook

## Status: EXECUTED — working (2026-10-08)

The dry run was completed and verified end-to-end:

- Team `YGPKB` MCP preference **enabled** (`preferences.mcp = true`) and
  `guidanceMCP` set (now returned inside the MCP `instructions`).
- API key `hermes-local` created (scope `["*"]`, user `DC`), token
  `ol_api_…` stored as `OUTLINE_MCP_TOKEN` in the Hermes `.env`.
- `mcp_servers.outline` added to `C:\Users\Media\AppData\Local\hermes\config.yaml`.
- `hermes mcp list` → `outline  http://localhost:3050/mcp  enabled`.
- `hermes mcp test outline` → **✓ Connected (1568ms), ✓ Tools discovered: 19**.

Re-run the steps below for a fresh machine or to rotate the key.

---

Verified against the running dev stack on **2026-10-08**:
`POST http://localhost:3050/mcp` → `401` with
`WWW-Authenticate: Bearer resource_metadata="http://localhost:3050/.well-known/oauth-protected-resource/mcp", scope="read write"`,
and `GET /.well-known/oauth-protected-resource/mcp` →
`{"resource":"http://localhost:3050/mcp","authorization_servers":["http://localhost:3050"],"scopes_supported":["read","write"],"bearer_methods_supported":["header"]}`.
So the endpoint is live and its issuer already matches `http://localhost:3050`.

> Auth model (from code): Outline's MCP route accepts `AuthenticationType.API`.
> `ApiKey.canAccess("/mcp")` passes when the key has any valid scope; a key with
> `["*"]` gets all tools. Token format is `ol_api_` + 38 word chars
> (`server/models/ApiKey.ts`). Bearer header only — never a cookie.

---

## Step 0 — Preconditions

- [ ] Outline dev stack running: `.\scripts\dev-start.ps1` (or `yarn dev:watch`).
      Confirm: `curl http://localhost:3050/mcp` returns 401 (not connection refused).
- [ ] PostgreSQL + Redis services running (dev-start warns if not).
- [ ] Hermes installed and working: `hermes --version`.

## Step 1 — Create an Outline API key

1. In the Outline UI go to **Settings → API & Access** (route `app/scenes/Settings/APIAndAccess.tsx`, page `ApiKeys.tsx`).
2. **Create API key**. Give it a name like `hermes-local`.
3. Scope: choose the wildcard `*` for the dry run (all 19 MCP tools), or
   `["read"]` for read-only-first testing.
4. Copy the secret immediately — it is shown once. Format: `ol_api_<38 chars>`.

> API: `POST /api/apiKeys.create` with `{ name, scope: ["*"] }`
> (`server/routes/api/apiKeys/{apiKeys,schema}.ts`; tests confirm `["*"]` is allowed).

## Step 2 — Configure Hermes

Add to the **active profile** config `C:\Users\Media\.hermes\config.yaml`
(this is the file Hermes actually reads; the seeded copy under
`AppData\Local\hermes\config.yaml` is the defaults reference):

> **Config-path gotcha (verified):** Hermes reads
> `C:\Users\Media\AppData\Local\hermes\config.yaml` — confirmed with
> `hermes config path`. The `C:\Users\Media\.hermes\config.yaml` copy is **not**
> read (editing it has no effect). Put the block in the AppData file.
> Likewise the active secrets file is `C:\Users\Media\AppData\Local\hermes\.env`.

Append to `C:\Users\Media\AppData\Local\hermes\config.yaml` (top-level key):

```yaml
mcp_servers:
  outline:
    url: "http://localhost:3050/mcp"
    headers:
      Authorization: "Bearer ${OUTLINE_MCP_TOKEN}"
    enabled: true
    timeout: 120
    connect_timeout: 60
```

Add the secret to `C:\Users\Media\AppData\Local\hermes\.env` (Hermes resolves
`${VAR}` from this file):

```
OUTLINE_MCP_TOKEN=ol_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> Hermes interpolates `${VAR}` / `${env:VAR}` from `url`/`headers`. If a remote
> `url`/`headers` still contains an unresolved `${VAR}`, Hermes **fails closed**
> (`_require_rendered_remote`) — so the `.env` entry must exist.

Equivalent CLI form:
```
hermes mcp add outline --url "http://localhost:3050/mcp"
```

## Step 3 — Enable MCP for the team

- **Settings → Features → MCP server** → toggle **on**.
- Without this, `/mcp` returns **404** (`server/routes/mcp/index.ts` checks
  `team.getPreference(TeamPreference.MCP)`).
- Optional: fill **Additional guidance** (`guidanceMCP`) with your KB conventions.
  It is appended to the MCP server instructions the agent receives.

## Step 4 — Reload and test

```
hermes mcp list
hermes mcp test outline
```

Expected: connection succeeds and `tools/list` returns the Outline tools
(`create_document`, `update_document`, `fetch`, `list_documents`, …).

Then a real round-trip, e.g. ask Hermes: *"List my recent Outline documents"*,
then *"Create an Outline document titled 'Hermes dry run' in collection X with a
one-line body"*, then confirm it appears in the UI.

## Step 5 — Verify from the shell (optional, no Hermes)

```powershell
$h = @{ Authorization = "Bearer ol_api_<...>"; Accept = "application/json, text/event-stream" }
$body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
Invoke-WebRequest -Uri "http://localhost:3050/mcp" -Method POST -Headers $h -ContentType "application/json" -Body $body -UseBasicParsing
```
A JSON-RPC `initialize` result (not 401) means the API key path works.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401` after adding key | Token not sent in header, or wrong format | Must be `Authorization: Bearer ol_api_...` (not cookie, not query). |
| `404` on `/mcp` | Team MCP preference off | Settings → Features → MCP server → on. |
| Hermes "unresolved variable" error | `${OUTLINE_MCP_TOKEN}` not in `.env` | Add it to `~/.hermes/.env`; reload. |
| Connection refused | Dev stack down | `.\scripts\dev-start.ps1`; wait ~2 min first compile. |
| `AuthorizationError: Invalid authentication type` | Used a session JWT | Use the API key, not a browser session token. |
| Tools list is short | Key scope limited | Use `["*"]`, or grant `read` + `write`. |

## Known caveats (fork-specific)

- **URL/issuer** is currently correct (`http://localhost:3050`). If you switch to
  the mkcert HTTPS dev profile, re-check `.env.development` (`URL=...`) vs the
  origin Hermes connects to — the OAuth issuer derives from `env.URL`, and a
  mismatch breaks *OAuth*; the API-key path bypasses issuer discovery entirely.
- **CORS** is absent on `/mcp`; irrelevant for Hermes (native client).
- This is a **local, plain-HTTP** dry run. For production use OAuth
  (`auth: oauth` in Hermes) against a TLS-terminated deployment.

## What "done" looks like

Hermes can `list_documents`, `fetch` a doc (gets metadata + markdown body),
and `create_document` / `update_document` round-trips. That is the baseline for
workstream 2 (frontmatter).
