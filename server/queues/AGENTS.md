# server/queues/ — Bull queues (tasks + processors)

Two entry types share the Bull queue infrastructure:

- **tasks/** — async jobs (one class per job). `base/BaseTask.ts` and
  `base/CronTask.ts` are the base classes; each task `.ts` has a colocated test.
- **processors/** — event-bus reactors. `BaseProcessor.ts` is the base; each
  processor reacts to domain events emitted by model hooks.

## Structure

```
queues/
├── index.ts        queue setup + registration
├── queue.ts        Bull queue definitions
├── HealthMonitor.ts  queue health checks
├── tasks/          ~93 jobs (+ base/{BaseTask,CronTask}.ts)
├── tasks/base/     BaseTask, CronTask
└── processors/     ~40 event reactors (+ BaseProcessor.ts)
```

## How jobs run

`services/worker.ts` initializes the Bull processors:
`globalEventQueue`, `processorEventQueue`, `websocketQueue`, `taskQueue`.
`services/cron.ts` schedules `CronTask`s (Hour/Day intervals, ~5s warmup).
Worker-only processes run with a single throng worker.

## Conventions & gotchas

- New async job → a `tasks/XxxTask.ts` class extending `BaseTask`, plus a
  colocated `XxxTask.test.ts`.
- New reaction to a domain event → a `processors/XxxProcessor.ts` extending
  `BaseProcessor`, registered in `processors/index.ts`.
- Events originate from the audit hooks in `server/models/base/Model.ts`
  (`insertEvent`) — a write that skips `*WithCtx` helpers emits no event and
  therefore triggers no processor.
- Worker processes don't load the web/collaboration service trees (lazy service
  imports) — don't import web-only modules from a task.

## Hot files

`processors/WebsocketsProcessor.ts` (983) · `processors/ImportsProcessor.ts` (827) ·
`tasks/MarkdownAPIImportTask.ts` (673)
