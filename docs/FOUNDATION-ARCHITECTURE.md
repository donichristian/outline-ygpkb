# Foundation Architecture — Knowledge Management System SKI

**KB:** the knowledge base is officially the **Knowledge Management System SKI**
(Outline). It must be **consumable by other systems** (LMS, HRIS, and future
tools) — see `docs/KB-INTEGRATION-CONTRACT.md`.

**Status:** draft / design (not yet built)
**Stories:** `docs/user-stories/README.md`, `docs/user-stories/US-A-sop-intern-intake.md`, `docs/user-stories/US-B-student-data-lookup.md`
**Related:** `docs/KB-INTEGRATION-CONTRACT.md`, `docs/HERMES-INTEGRATION.md`, `docs/FRONTMATTER-PLAN.md`

> ## ⚠️ REMINDER — production deployment is OPEN
> This document designs the foundation, not its hosting. **Production deployment
> (where each component runs, TLS, domains, backups, secrets, HA) is deliberately
> out of scope for now and must be resolved before go-live.** The dev box cannot
> run Baserow's normal Docker stack (no Docker, no WSL — see §8). Treat all
> "running it" details below as **local/dev** and revisit for production.

---

## 1. Purpose & scope

Support multi-school operations where:
- **Outline** is the knowledge base (SOPs, policies, guides).
- **Baserow** is the intake + structured-record store (forms, uploads, rows).
- **Hermes** is the orchestration brain (lookup, email send/receive + cc,
  scheduling, approvals, human-in-the-loop).

Delivered stories: **US-A** (SOP intern intake & approval) and **US-B** (student
data lookup & periodic updates). See `docs/user-stories/`.

## 2. Locked decisions

1. Interns are **not** Outline users → intake is a **public Baserow form**.
2. Records live in **Baserow**; Outline holds SOP text only.
3. Approval is by **email** (approve/reject), coordinator cc'd.
4. **One shared instance**; no hard per-school tenant isolation (v1).
5. **Open-source / self-hosted only.**

## 3. Component responsibilities (from verified capabilities)

| Component | Owns | Verified footing |
|-----------|------|------------------|
| **Outline** | KB: SOP docs, policies; public **read** share links; audit `Event` stream; signed **webhooks**; MCP read/write for the agent | `server/models/Event.ts`, `plugins/webhooks/`, `server/mcp/` (19 tools). **No forms, no typed records, no anonymous write, email `to`-only.** |
| **Baserow** | Public **forms** (anonymous), **file uploads**, typed **records** (rows), REST API, **submit webhook** | Chosen tool; fills Outline's two gaps. |
| **Hermes** | Inbound **webhook/HTTP trigger**, **email send+receive (+cc)**, **cron** scheduling, HITL **approval**, durable **Kanban** states, Outline MCP client | `gateway/platforms/{webhook,email,api_server_*}`, `cron/`, `tools/send_message_tool.py`, `tools/kanban_tools.py`, `tools/approval.py` |

**Rule of thumb:** Outline = *read/reference*; Baserow = *capture/records*;
Hermes = *glue, notify, schedule, approve*.

## 4. Component diagram

```
                         ┌────────────────────────────┐
   Coordinator ────────► │  Outline (KB)               │  published SOPs
   (Outline user)        │  • Academic collection      │  /s/:shareId share links
                         │  • MCP server (read/write)  │◄──────┐
                         │  • Event stream → webhooks  │       │ MCP
                         └────────────────────────────┘       │
                                                              │
   Intern (anonymous) ──► ┌────────────────────────────┐      │
   public form link       │  Baserow                    │      │
                         │  • Public form view         │      │
                         │  • intern_intake table      │      │
                         │  • students table           │      │
                         │  • REST API + submit hook   │      │
                         └───────────────┬────────────┘      │
                                         │ webhook (submit)  │
                                         ▼                   │
                         ┌────────────────────────────┐      │
                         │  Hermes (agent)             │──────┘
                         │  • inbound webhook / /v1/runs│
                         │  • email send+receive (+cc)  │──► Academic dept (approve)
                         │  • cron (periodic updates)   │──► Office admin
                         │  • Kanban (approval states)  │──► Head of Unit (+cc)
                         └────────────────────────────┘
```

## 5. Integration contracts

### 5.1 Outline → Hermes (agent reads/writes KB)
- **Transport:** MCP, `POST /mcp`, `StreamableHTTP`, bearer API key. Already live
  (`docs/HERMES-INTEGRATION.md`).
- **Tools available (19):** documents `create/list/list_collection/update/move/
  delete/restore`, collections CRUD, comments CRUD, `fetch`, `list_templates`,
  `list_users`, `create_attachment`.
- **Use:** read SOP/policy context; optionally mirror records into the KB.

### 5.2 Baserow → Hermes (form submit)
- **Trigger:** Baserow **submit webhook** (or a polling/manual fallback).
- **Payload:** the new row (fields + file URLs) + row id.
- **Hermes ingress options (verified):**
  - generic HMAC-signed **inbound webhook** adapter (`gateway/platforms/webhook.py`), or
  - **HTTP run API** `POST /v1/runs` (`gateway/platforms/api_server_runs.py`).
- **Idempotency:** key on Baserow `row id` (Hermes runs support idempotency keys).
- **Security:** signed payloads; webhook-triggered runs are restricted to a safe
  toolset by default.

### 5.3 Hermes → Baserow (read/write records)
- **Transport:** Baserow REST API via Hermes **HTTP tool** (or an MCP wrapper).
- **Auth:** least-privilege Baserow database token; store as a Hermes `.env` var
  (never in prompts).
- **Operations:** read rows (student lookup); update row status/decision fields
  (US-A approval outcome).

### 5.4 Hermes → email (approve + notify + cc)
- **Transport:** Hermes **email gateway** (SMTP send, IMAP receive) — verified
  send+receive with cc.
- **Approval:** either signed action links back into Hermes
  (`POST /v1/runs/{id}/approval`) or "reply APPROVE/REJECT" parsed from IMAP.

## 6. Data model (Baserow)

### 6.1 `intern_intake` (US-A)
`intern_name`(text) · `intern_email`(email) · `school`(select) · `sop_version`(text)
· `acknowledged_read`(bool) · `documents`(file, multi) · `notes`(long text)
· `status`(select: submitted→approved/rejected) · `submitted_at`(date)
· `decided_at`(date) · `decided_by`(text) · `decision_note`(long text)

### 6.2 `students` (US-B)
`student_id`(text, unique) · `name`(text) · `school`(select) · `program`(text)
· `status`(select: active/on-leave/graduated/withdrawn) · `advisor`(text)
· `guardian_email`(email) · `updated_at`(date)

### 6.3 `update_recipients` (US-B, optional)
`scope`(select) · `role`(text) · `email`(email) · `kind`(to/cc) — so recipient
lists are data, not hard-coded.

## 7. Flow sequences

### 7.1 US-A — SOP intake & approval
```
Coordinator  → sends intern: Outline SOP /s/:shareId + Baserow form link
Intern       → reads SOP (Outline, anonymous)
Intern       → fills Baserow form + uploads docs → submit
Baserow      → writes row (submitted) → fires submit webhook
Hermes       → (webhook) validates + dedupes (idempotent on row id)
             → emails Academic dept (Approve/Reject links), cc Coordinator
Approver     → acts (link callback or email reply)
Hermes       → updates Baserow row: status, decided_at, decided_by, decision_note
             → emails outcome to Coordinator (+ intern if captured)
```

### 7.2 US-B — lookup & periodic updates
```
Coordinator  → asks Hermes: "trace student <id/name>"
Hermes       → queries Baserow students (+ Outline KB context)
             → summarizes WITH provenance (row id + updated_at, freshness flag)
             → notifies Office admin (to), cc Coordinator
Hermes(cron) → e.g. "every monday 9am"
             → queries tracked set → summarizes progress
             → emails Head of Unit (to), cc related parties
             → logs run (cron output + Kanban/event)
```

## 8. Environments & deployment — ⚠️ OPEN (reminder)

| Aspect | Dev (this machine) | Production |
|--------|--------------------|------------|
| Outline | runs at `http://localhost:3050` (confirmed live) | TBD — TLS, domain, `env.URL` |
| Hermes | installed; MCP to Outline live | TBD — host, email mailbox |
| Baserow | **not installed**; needs Docker **or** native/source install | TBD |
| Postgres/Redis | running (5432/6379) | TBD — HA, backups |
| Docker/WSL | **unavailable** (firmware virtualization disabled) | may differ |

**Blockers to resolve before production** (not now): where Baserow runs; a real
email account for Hermes; TLS/domain for Outline; secrets management; backups;
who administers each component. **Revisit this section at go-live.**

## 9. Failure & idempotency

| Failure | Handling |
|---------|----------|
| Baserow submit webhook lost | Baserow/webhook retry; Hermes dedupes on row id |
| Hermes down on submit | Queue + replay; reconcile rows with `status=submitted` lacking a decision |
| Approval email not answered | Hermes cron reminder after N days |
| Baserow API down (US-B) | Report failure honestly; retry; never fabricate |
| Missed cron run | `cron.catch_up_missed: true` |

## 10. Security & privacy

- **Intern PII + student PII is sensitive.** Use least-privilege Baserow tokens;
  redact fields beyond the requester's need.
- **Anonymous form** is the only public write surface — keep it to one form view
  with strict required fields; no broad table exposure.
- **HMAC** on webhooks (both directions); verify signatures.
- **Secrets** live in `.env` (Hermes) / Baserow tokens — never in prompts or docs.
- **No silent writes**: US-B lookups are read-only; writes are explicit/approved.

## 11. Observability & audit

- **Outline** `Event` stream (append-only) + optional webhook subscription.
- **Hermes** cron output ledger, Kanban `task_events`, `state.db` sessions.
- **Baserow** row audit (created/modified by/time).
- Recommend a per-submission correlation id (Baserow row id) threaded through all
  notifications for end-to-end traceability.

## 12. Build order (thin slices)

1. **US-A happy path:** Baserow form → webhook → Hermes → approval email (cc).
2. **US-A decision write-back:** approve/reject → Baserow row update + outcome email.
3. **US-B lookup:** agent queries Baserow + KB → notify office admin.
4. **US-B periodic:** Hermes cron → tracked set → scheduled updates + cc.
5. **Hardening:** idempotency, reminders, correlation ids, redaction rules.

*(Each slice is independently demoable; none requires production hosting to prove.)*

## 13. Rejected / deferred alternatives

- **Forms inside Outline** — impossible: no anonymous write path (verified).
- **Records inside Outline** — impossible: no typed-record/table feature.
- **Hermes as record store** — no DB tool; Baserow is the correct store.
- **n8n workflow engine** — deferred: Hermes already covers cron, webhooks,
  email, approvals, and HITL; revisit only if non-technical staff need a visual
  editor.
- **Per-school tenant isolation** — deferred (decision #4: one shared instance).

## 14. Open questions

1. US-A: record of truth — Baserow only, or also an Outline mirror doc?
2. US-A: approve/reject by signed link (preferred) or email reply (v1)?
3. US-A: dept + coordinator addresses; which Hermes mailbox?
4. US-B: definition of the tracked set; cadence; channel (email vs chat).
5. US-B: authorization rule for who may request/see which PII fields.
6. Baserow hosting model (gates build, not design).
