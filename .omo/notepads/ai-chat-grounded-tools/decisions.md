# Decisions — ai-chat-grounded-tools

Architectural choices and rationales discovered during work on this plan.

_Auto-scaffolded by /ulw-execute. Append new entries below - never overwrite._

---

## 2026-10-29 - Merge development into the feature branch instead of rebasing

`development` moved 161 commits past the feature branch and shipped its own
body tool (`read_document`) while the branch shipped `recommend_documents`,
collection-scoped search and the tool-call digest. Rebasing eight commits would
have re-resolved the same four files eight times. Chose
`git merge development` (merge commit c666be655d): keep both tool surfaces and
both middleware behaviours, so the allowlist temporarily holds three tools and
the branch tests stay coherent until todo 5.

## 2026-10-29 - Todo 5 folds the body reader into `fetch_document`

`read_document` (uuid only, offset paging, 24000 characters, no
archived/soft-deleted refusal) and the plan's `fetch_document` (uuid or slug,
optional section by heading, 20000/60000 caps, `truncated` flag, archived and
soft-deleted refusal) are the same capability. Shipping both would give the
model two overlapping read tools and break the frozen three-tool allowlist
(`search_workspace`, `fetch_document`, `recommend_documents`).

Decision: todo 5 upgrades the reader in place, renames it to `fetch_document`
and routes it through `server/commands/documentReader.ts` so the MCP fetch tool
and the AI tool share one reader. `read_document` is retired; no test is
deleted, the read-scrolling test is retargeted to `fetch_document`. Capability
strictly grows (sections, slug, refusal semantics); nothing that worked stops
working.

