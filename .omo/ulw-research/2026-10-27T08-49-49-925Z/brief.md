# ULW-RESEARCH BRIEF
Core question: Investigate, identify, verify and gather evidence for the AI Knowledge Base api feasibility. The goal is our other internal system need to be able to fetch the knowledge base data.

## Analysis
Axes (3+ orthogonal):
- Axis 1 (codebase): Find existing KB/AI/knowledge endpoints, models, commands, policies. Where: server/routes/api/ai, server/routes/api/documents, server/models, server/commands. Why: see what exists vs need.
- Axis 2 (data model): Understand how knowledge is stored (documents/collections/shares/embeddings/attachments). Where: server/models/Document*, Collection*, Attachment*, Search*. Why: can external system fetch it?
- Axis 3 (API surface/auth): Auth, rate limits, permissions, API keys, RPC style. Where: server/routes/api/*, server/policies, middlewares/auth. Why: feasibility of allowing another internal system to fetch KB data.
- Axis 4 (external/internal patterns): Look for existing internal API patterns (API keys, service tokens), how other systems integrate. Where: server/routes/api/apiKeys, authentication, plugins. Why: practical path.
- Axis 5 (gaps/verification): Find blockers (soft delete, permissions, indexing, realtime). Where: models, commands, queues. Why: verify claims by code.

Codebase relevant: yes. External: minimal (maybe docs). Collection: search-only mostly, browser if need external docs. Verification likely: yes (code inspection + maybe test patterns). X/social: no.
Scale: medium. Precision demand: medium (feasibility - need concrete evidence). Lifecycle: single team.
Debate need: permissions/auth model, whether existing APIs suffice vs need new API.

## Expected truths (seed intent-diff)
- There is some API surface to access documents/knowledge
- Auth can be extended for internal service access (API keys/service tokens)
- Permissions model allows controlled access
- Existing endpoints may need extension or new ones
