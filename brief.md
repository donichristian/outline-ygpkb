# Brief: Expose AI chat + KB via API for internal apps

## Goal
Determine if/how AI chat feature and knowledge base (KB) can be exposed via API so other internal apps can consume KB data.

## Axes
1. **KB storage** - Where stored, schema, indexing (documents table, searchVector tsvector, SearchProviderManager/PostgresSearchProvider). How accessed.
2. **KB API exposure** - Existing endpoints (documents.search/info/list/export), auth (API keys with scopes), MCP tools. Feasibility for internal consumption.
3. **AI chat feature** - Implementation (ai.chat route, TanStack AI, server tools like search_workspace), auth model (APP only), session storage (AIChatSession/AIChatMessage). Exposability to internal apps.
4. **Auth/scope/gaps** - API key support per route, scope mapping, limitations (AI requires APP). What would need to change.
5. **Integration paths** - Options: use existing documents.* API (KB only), extend AI routes for API keys/service tokens, use MCP, create new internal API.

## Roster
- **KB-storage-investigator**: Examine Document model, migrations, SearchProviderManager/PostgresSearchProvider
- **API-mapper**: Map documents.* routes, auth middleware, API key scopes/canAccess
- **AI-investigator**: Examine ai.chat, tools.ts (search_workspace), AI models, auth requirements
- **Auth-gate-analyzer**: Analyze AuthenticationHelper/methodToScope, API key flow vs APP auth
- **Integration-synthesizer**: Propose concrete options with feasibility/risks

## Constraints
- Follow existing patterns (RPC API style, policies, auth middleware)
- Don't modify without evidence
- Focus on internal app consumption (API keys/common auth patterns)
