# Hyperplan Insight Bundle: Expose KB data to internal apps

## Original User Request
create the detailed implementation plan based on the evidence. the goal is the KB data need to be accessible by our other internal app as well

## Hard Constraints (Survived Adversarial Review)
- **Use existing API** (skeptic) — documents.* endpoints already exist with API key support; adding new service layer is over-engineering.
- **API keys via headers only** (validator) — auth middleware blocks cookies for API keys; internal apps must use Authorization header or API key header.
- **KB and AI chat separate** (skeptic/architect) — don't bundle concerns; handle independently.
- **API key scope mapping critical** (validator/researcher) — must verify documents.* actions map correctly via methodToScope and apiKey.canAccess().

## Decisions (Converged Through Debate)
- **KB-first approach** (skeptic) — Focus on making KB data accessible first via existing documents.search/info/list. AI chat is separate concern.
- **Minimal extension over new service** (architect/creative conceded) — Extend auth minimally if needed, don't create new gateway/service.
- **MCP not necessary for basic KB access** (skeptic/creative conceded) — Can be considered later if needed, not required now.

## Risks & Mitigations
- **API key scope mapping unverified** (researcher/validator) — Mitigate: trace methodToScope for documents.* actions, verify apiKey.canAccess() logic, test with actual API key.
- **API key context for team/user scoping** (validator/architect) — Mitigate: Ensure API keys resolve to correct user/team in SearchProviderManager calls; documents.search uses team/user scoping.
- **AI chat auth change has blast radius** (validator/architect) — Mitigate: If pursuing AI chat later, change auth minimally, test all AI routes, consider service auth alternative.
- **Transport/auth assumptions** (validator) — Mitigate: Document header-based auth requirement clearly for internal apps.

## Open Questions (Unresolved Debate)
- **Should AI chat also be exposed?** (skeptic says separate, creative suggests alternatives) — User wants KB data accessible; AI chat unclear. Need clarification if both needed.
- **Is MCP better for internal apps?** (creative) — REST API might suffice for KB; MCP could be cleaner for some use cases. Need to assess internal app needs.

## Adversarial Provenance
- skeptic findings that survived: 2/3
- validator findings that survived: 3/3
- researcher findings that survived: 3/3
- architect findings that survived: 3/3
- creative findings that survived: 1/3
- Total findings filtered out (conceded/destroyed): 5
