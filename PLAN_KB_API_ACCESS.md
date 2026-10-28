# Plan: Expose KB data to internal apps (detailed)

*Plan derived from hyperplan adversarial review (5 members, 3 rounds) and formalized manually (ulw-plan unavailable in this environment).*

## Goal
Make KB data (documents/collections) accessible to other internal apps via API.

## Hard constraints (must respect)
- Use existing `documents.*` API - no new service/gateway layer
- API keys must be sent via headers only (auth middleware blocks cookies for API keys)
- KB and AI chat are separate concerns - don't bundle
- API key scope mapping must be correct (methodToScope + apiKey.canAccess())

## Open questions (user input gates)
1. **Should AI chat also be exposed?** If yes, need separate plan (higher blast radius). Current goal is KB only.
2. **Is MCP preferred over REST?** Assess internal app needs; REST is simplest for KB access.

## Implementation plan

### Phase 1: Verify API key auth for documents endpoints
**Tasks:**
1. Trace `methodToScope` for documents actions (search/info/list/update/create/delete/export). Verify scopes needed.
2. Verify `apiKey.canAccess()` and how API keys resolve user/team context.
3. Check `documents.search` uses SearchProviderManager with proper scoping.

**Success criteria:**
- [ ] Documented which scopes needed for read-only KB access (search/info/list)
- [ ] Confirmed API key resolves to correct user/team
- [ ] Identified any gaps

### Phase 2: Create/test API key for internal app
**Tasks:**
1. Create API key in team with appropriate scopes (read-only)
2. Test `POST /api/documents.search` with header auth (e.g., `Authorization: Bearer <key>` or API key header per auth middleware)
3. Test `documents.info/list` as needed

**Success criteria:**
- [ ] Can search documents via API key
- [ ] Can fetch document details
- [ ] Auth works with headers only (no cookies)

### Phase 3: Document usage for internal apps
**Tasks:**
1. Write docs: endpoints, required headers, scopes, example requests
2. Note transport constraint (headers only)
3. Note team scoping behavior

**Success criteria:**
- [ ] Internal apps have clear integration guide

## Risks & mitigations
- **Scope mapping unclear** → Phase 1 verification first
- **Team/user context wrong** → Test with real API key, verify results scoped correctly
- **Header auth assumption** → Explicitly test header-based auth

## Notes
- AI chat remains APP-auth only; if needed later, separate plan required
- MCP not necessary now; consider if REST insufficient
