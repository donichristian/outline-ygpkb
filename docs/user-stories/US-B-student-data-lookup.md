# US-B — Student data lookup & periodic progress updates

**Status:** documented (not yet implemented)
**Primary systems:** Hermes (agent + cron + email) · Baserow (student records) · Outline (KB)

## Summary

A coordinator asks the agent to trace existing student data. The agent searches
the structured records (Baserow, cross-referenced with the Outline KB), notifies
the office admin of the finding, and then sends **periodic progress updates** to
the Head of Unit (with related parties cc'd) on a schedule.

## Actors

- **Coordinator** — asks the agent; receives the immediate result.
- **Office admin** — notified of the lookup/finding.
- **Head of Unit** — receives periodic progress updates.
- **Hermes** — performs the trace, sends notifications, runs the schedule.
- **Baserow** — student records (structured, queryable).
- **Outline** — SOPs/policies that give the lookup its rules/context.

## Preconditions

- A Baserow table (e.g. `students`) with typed fields (name, student id, school,
  program, status, advisor, contacts).
- Hermes has: the Baserow API reachable (HTTP tool / MCP), the Outline MCP
  connection (live), an email account, and the office-admin / Head-of-Unit
  addresses.
- (For periodic updates) a Hermes **cron job** defined.

## Data model sketch (Baserow table: `students`)

| Field | Type | Notes |
|-------|------|-------|
| `student_id` | text | unique |
| `name` | text | |
| `school` | single select | multi-school |
| `program` | text | |
| `status` | single select | active / on-leave / graduated / withdrawn |
| `advisor` | text | |
| `guardian_email` | email | |
| `updated_at` | date | for freshness |

## Main flow — lookup & immediate notify

```
1. Coordinator → Hermes chat: "Find student <id/name> and report status"
2. Hermes → queries Baserow (students table) for the record
         → optionally reads Outline KB for the governing policy/context
3. Hermes → composes a result summary
4. Hermes → notifies office admin (email; Teams/Slack optional)
5. Hermes → replies to the coordinator with the traced data + what was sent
```

## Main flow — periodic progress updates

```
1. Hermes cron job (e.g. schedule "every monday 9am")
2. Each run → queries Baserow for the tracked cohort / open cases
           → summarizes progress/status
3. Hermes → sends update to Head of Unit, cc related parties
4. Hermes → logs the run (cron output + Kanban/event record)
```

## Traceability requirements

- **Provenance:** the agent must state which record(s) and fields a result came
  from (Baserow row id + `updated_at`), so a coordinator can audit the trace.
- **Freshness:** if `updated_at` is stale beyond a threshold, flag it in the
  summary rather than presenting it as current.
- **No silent writes:** the lookup flow is read-only; any write to Baserow is a
  separate, explicitly requested action (and approved if consequential).

## Notifications & cc

- Immediate: office admin (to), coordinator (cc).
- Periodic: Head of Unit (to), related coordinator/admins (cc).
- Delivery via Hermes email gateway (send + receive) or a messaging platform.

## Postconditions

- Office admin has the notification; coordinator has the traced result.
- Periodic updates are delivered on schedule with a run record.

## Edge cases & failures

| Case | Handling |
|------|----------|
| No matching student | Report "not found" explicitly; do not guess. |
| Multiple matches | Present the list; ask coordinator to disambiguate (clarify). |
| Baserow API down | Report the failure; retry; do not fabricate data. |
| Sensitive fields | Redact unless the requester is authorized (see Open questions). |
| Missed cron run | `cron.catch_up_missed: true` (Hermes) replays missed runs. |

## Privacy & access (important for student data)

- Student PII is sensitive. Since this is a **shared instance**, ensure the
  Baserow API token used by Hermes is least-privilege (read where possible), and
  that notification recipients are authorized.
- Consider field-level redaction for broad cc lists.

## Open questions

1. What defines the **tracked set** for periodic updates (cohort, open cases, a
   filter)? Who adds/removes students from it?
2. Update **cadence** and channel (email vs Teams/Slack)?
3. What is the **authorization rule** for who may request/see which fields?
4. Does the lookup ever **write** (e.g. log a note), and if so with approval?
5. Exact addresses: office admin, Head of Unit, and the cc list.
