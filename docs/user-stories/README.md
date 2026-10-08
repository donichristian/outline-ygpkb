# User Stories — Index

Reference docs for **Knowledge Management System SKI** — the KB (Outline)
+ **Hermes** (AI agent) + **Baserow** (forms + structured records). The KB must
be **consumable by other systems** (LMS, HRIS, future tools); see
`docs/KB-INTEGRATION-CONTRACT.md`.

Read this alongside `docs/FOUNDATION-ARCHITECTURE.md` (component design) and
`docs/HERMES-INTEGRATION.md` (the live Outline ⇄ Hermes MCP connection).

## Role glossary

| Role | Description |
|------|-------------|
| **Intern** | Not an Outline user. Reaches specific docs + a form via public links. |
| **Coordinator** | Staff member. Assigns SOPs to interns; asks the agent to trace data. |
| **Academic department** | Approver for SOP intake submissions. |
| **Office admin** | Recipient of student-data notifications. |
| **Head of Unit** | Recipient of periodic progress updates. |

## Stories

| ID | Title | Primary flow |
|----|-------|--------------|
| [US-A](./US-A-sop-intern-intake.md) | Academic SOP — intern intake & approval | SOP doc → intern fills form + uploads → record stored → approval email (cc coordinator) |
| [US-B](./US-B-student-data-lookup.md) | Student data lookup & progress updates | Coordinator asks agent → trace records → notify office admin → periodic updates to Head of Unit |

## Foundation decisions (locked)

1. **Interns are NOT Outline users** — intake is a **public Baserow form link**.
2. **Records live in Baserow** (external structured DB); Outline holds the SOP text.
3. **Approval is by email** (approve/reject), coordinator cc'd.
4. **One shared instance** is acceptable (no hard per-school tenant isolation required now).
5. **Open-source / self-hosted only.**

## Capability footing (verified 2026-10-08)

- **Outline**: KB + SOP docs + MCP read/write + audit events + signed webhooks.
  Has **no** forms, **no** typed records, **no** anonymous write path, and email
  is single-recipient (no cc). → Outline is the **KB only**.
- **Hermes**: orchestration, **email send+receive (cc supported)**, cron/periodic
  jobs, inbound webhooks + HTTP API triggers, human-in-the-loop approvals,
  durable **Kanban** work states, and the Outline MCP client.
- **Baserow** *(chosen)*: public anonymous forms, typed fields, file uploads,
  REST API, and submit webhooks — fills the two gaps (intake + records).

## Hosting reality (must resolve before build)

This dev box has **Postgres (5432)** and **Redis (6379)** running, but **no
Docker and no WSL** (virtualization disabled in firmware; see the repo's
`AGENTS.md`). Baserow normally ships as a Docker Compose stack. So Baserow must
be deployed **either** natively/from source on Windows **or** on a separate
self-hosted Linux host/VM, then pointed at shared Postgres + Redis. This is a
deployment task, not an architecture change — but it gates the build.
