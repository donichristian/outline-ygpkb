# US-A — Academic SOP: intern intake & approval

**Status:** documented (not yet implemented)
**Primary systems:** Outline (KB) · Baserow (form + record) · Hermes (orchestration + email)

## Summary

A coordinator directs an intern to the Academic SOP in Outline. With no Outline
account, the intern reads the SOP and completes a **Baserow public form**
(fields + file uploads). On submit, a **record is stored in Baserow**, which
triggers an **approval email** to the Academic department with the coordinator
cc'd. The approver's decision is recorded and both parties are notified.

## Actors

- **Coordinator** — assigns the SOP; is cc'd on approval.
- **Intern** — anonymous; public link only.
- **Academic department** — approver.
- **Hermes** — route submission → email → record decision.
- **Baserow** — hosts the form, stores the record, emits the submit webhook.
- **Outline** — hosts the SOP text.

## Preconditions

- The Academic SOP exists as a published document in the Outline **Academic**
  collection, reachable by a **public share link** (`/s/:shareId`).
- A Baserow **form view** exists for the intake table, its public link enabled,
  with the fields below.
- Hermes has: an inbound webhook route (or watches Baserow), a configured email
  account (SMTP/IMAP), and the Academic department + coordinator addresses.

## Form schema (Baserow table: `intern_intake`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `intern_name` | text | yes | |
| `intern_email` | email | yes | for notifications |
| `school` | single select | yes | multi-school foundation |
| `sop_version` | text/link | yes | which SOP revision they worked from |
| `acknowledged_read` | checkbox | yes | "I have read the SOP" |
| `documents` | file (multiple) | yes | uploaded evidence |
| `notes` | long text | no | |
| `status` | single select | auto | `submitted` → `approved` / `rejected` |
| `submitted_at` | date | auto | |
| `decided_at` | date | auto | |
| `decided_by` | text | auto | approver identity |
| `decision_note` | long text | auto | reason on reject |

## Main flow

```
1. Coordinator → sends intern: Outline SOP share link + Baserow form link
2. Intern (anonymous) → reads SOP in Outline
3. Intern → opens Baserow form, fills fields, uploads documents, submits
4. Baserow → writes row (status = submitted) + fires submit webhook
5. Hermes → receives webhook (inbound trigger)
         → sends approval email to Academic dept, cc Coordinator
           (body: intern, school, SOP version, uploaded-file links,
            [Approve] / [Reject] actions)
6. Approver → clicks Approve or Reject
7. Hermes → records decision:
         → updates Baserow row (status, decided_at, decided_by, decision_note)
         → notifies Coordinator (and intern, if email captured) of outcome
```

## Approve/reject mechanism (options)

- **Preferred:** signed action links in the email that call back into Hermes
  (`/v1/runs/{id}/approval` or a webhook), so the decision is recorded
  automatically.
- **Simplest start:** "reply `APPROVE <id>` / `REJECT <id>` to this email";
  Hermes's email gateway reads the reply (IMAP) and acts.

## Postconditions

- A Baserow row exists with the intern's data, files, and final `status`.
- The Academic department and coordinator have an email trail.
- (Optional) a mirrored Outline doc per submission as a KB audit trail.

## Edge cases & failures

| Case | Handling |
|------|----------|
| Intern submits without file | Baserow `required` blocks submit; no record. |
| Duplicate submit | Baserow view dedupe by `intern_email` + `sop_version`, or Hermes idempotency key. |
| Approver never responds | Hermes cron reminder (e.g. after 2 days) re-notifies. |
| Rejection | `decision_note` required; coordinator notified; intern may resubmit. |
| Webhook delivery fails | Baserow/webhook retry; Hermes idempotent on row id. |

## Explicit non-goals

- No intern Outline account.
- No content adjudication of the SOP itself (approval is of the **submission**).
- No multi-level approval chain (single Academic-dept decision) in v1.

## Open questions

1. Where is the *record of truth* — Baserow row only, or also a mirrored Outline doc?
2. Approve/reject by signed link or by email reply (first version)?
3. Which mailbox does Hermes use for approval send/receive?
4. What are the actual Academic-department + coordinator addresses?
