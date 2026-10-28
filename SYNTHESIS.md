# Synthesis: Expose AI chat + KB via API for internal apps

## KB (Knowledge Base)
- **Storage**: Documents in Postgres (`documents` table). `searchVector` (tsvector) maintained by triggers; content indexed for full-text search.
- **Search**: `SearchProviderManager.getProvider()` → default `PostgresSearchProvider` (plugin/search-postgres). `searchForUser/team` methods handle permission scoping.
- **API**: `POST /api/documents.search`, `documents.info`, `documents.list`, etc. Auth via `auth()` middleware; API keys supported if route allowed and scopes match (`methodToScope` maps actions like `search`→`Read`, `list`→`Read`). Scopes enforced via `apiKey.canAccess()` and policy checks.

## AI Chat
- **Route**: `POST /api/ai.chat` in `server/routes/api/ai/ai.ts` - requires `auth({ type: [AuthenticationType.APP] })` only (session/JWT). No API key support.
- **Models**: `AIChatSession`, `AIChatMessage` (see `server/models/AI*`). 
- **Tools**: `search_workspace` etc use `SearchProviderManager` to search documents (respects permissions).
- **Storage**: Sessions/messages persisted; collaboration features separate.

## API Key Auth Details
- API keys parsed by `ApiKey.match()` in auth middleware; must come via header/query/body (not cookie). `type = AuthenticationType.API`. Scopes from `apiKey.scope ?? ["*"]`. Expiration/checks enforced.
- Route permissions depend on `AuthenticationType` allowed by route's auth options and scope mapping.

## Feasibility for Internal Apps
**KB only (easy)**: Use existing `documents.search/info/list` with API keys. Create API key with appropriate scopes for internal app; works as-is.

**AI chat (needs changes)**: Not directly exposable to API keys currently.
Options:
1. **Extend auth**: Allow `AuthenticationType.API` on `ai.chat` route (and related). Need to ensure API keys can be used in AI context (user identity, team scoping, rate limits). May need to map API key to user/team properly.
2. **Service token**: Create service-to-service auth mechanism (separate from user API keys) with explicit permissions.
3. **Internal endpoint**: Add new route under different auth (e.g., service auth) that proxies/wraps AI chat.
4. **MCP**: Expose via MCP server if internal apps can use MCP protocol (MCP has its own auth model).

## Recommendation
- **For KB consumption**: Use `documents.search` API with API key auth - ready now.
- **For AI chat**: Requires auth extension. Simplest path depends on security requirements; recommend extending auth to allow API keys for `ai.chat` if internal apps need it, with appropriate scope controls and user/team resolution.
