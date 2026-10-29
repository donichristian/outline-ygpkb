# KB API Feasibility - Final Materials

## Summary
Feasible via existing Outline RPC API + API keys. External system can fetch KB data by authenticating as a service user with scoped API key and calling documents endpoints.

## API surface
| Endpoint | Auth | Purpose | Notes |
|----------|------|---------|-------|
| POST /api/apiKeys.create | APP user session/JWT | Create API key | Returns value once (ol_api_...). Scope limited. |
| POST /api/documents.list | API key (or session) | List docs | Paginated, team+policy filtered. Use offset/limit. |
| POST /api/documents.search | API key (or session) | Search docs | Full-text via provider, filters, pagination, snippets. |
| POST /api/documents.info | API key (or session/optional) | Get single doc | Full content (ProseMirror JSON). shareId for public shares. |

## Auth details
- Header: Authorization: Bearer <ol_api_...> (never cookie)
- Scopes: * , read/write/create , <namespace>:(read|write|create) , /api/<namespace>.<method>
- Validation: expiry check, canAccess(path), user/team load, scope attached to ctx.state.auth
- MCP: allowed if key has valid scope

## Minimal integration
```bash
# 1) Create key (as admin/service user)
curl -X POST https://<outline>/api/apiKeys.create \
  -H "Authorization: Bearer <session>" \
  -H "Content-Type: application/json" \
  -d '{"name":"kb-export","scope":["/api/documents.list","/api/documents.info","/api/documents.search"]}'

# 2) List docs
curl -X POST https://<outline>/api/documents.list \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"limit":100,"offset":0}'

# 3) Get doc
curl -X POST https://<outline>/api/documents.info \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"id":"<doc-id>"}'
```

## Recommendations
- Use dedicated service user with least privilege collection access.
- Prefer route-scoped keys over *.
- Paginate all listings.
- Treat document data as ProseMirror JSON (parse as needed).
- Respect rate limits.

## Evidence (code)
- server/middlewares/authentication.ts (API key auth)
- server/models/ApiKey.ts (canAccess, scope)
- shared/helpers/AuthenticationHelper.ts (scope grammar/matching)
- server/routes/api/apiKeys/apiKeys.ts
- server/routes/api/documents/documents.ts
- server/routes/api/documents/schema.ts
- server/presenters/document.ts
- server/utils/SearchProviderManager.ts
