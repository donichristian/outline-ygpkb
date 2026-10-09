# server/models/ — Sequelize models

Sequelize via `sequelize-typescript`. Models carry schema, row-level domain
logic, scopes, lifecycle hooks, and audit-event emission.

## Base hierarchy (`base/`)

- `Model.ts` (543) — extends `sequelize-typescript` `Model`. Adds
  `saveWithCtx/updateWithCtx/destroyWithCtx/restoreWithCtx/createWithCtx/
  findOrCreateWithCtx`, `findAllInBatches`, and a `changeset` getter. Its
  `@AfterCreate/@AfterUpdate/@AfterDestroy` hooks call `insertEvent` → writes an
  `Event` row (needs `context.transaction` + `context.ip`).
- `IdModel.ts` — UUID v4 PK `id` + `createdAt`/`updatedAt`.
- `ParanoidModel.ts` — adds `deletedAt` + `deletedById` (soft delete is the norm).
- `ArchivableModel.ts` — adds `archivedAt` + `isArchived`.

## Registration

`models/index.ts` re-exports every concrete model (NOT `base/`).
`storage/database.ts` does `import * as models` and passes `Object.values(models)`
to `new Sequelize({...})`, so `sequelize-typescript` registers them; access via
`sequelize.models.document` inside hooks. `sequelizeReadOnly` (read replica) is
skipped in tests.

## Structure

```
models/
├── base/         Model / IdModel / ParanoidModel / ArchivableModel
├── helpers/      Domain logic (DocumentHelper, ProsemirrorHelper, TextHelper,
│                 AttachmentHelper, Filters, NotificationHelper, SubscriptionHelper…)
├── decorators/   @Changeset etc.
├── validators/
├── oauth/
└── <Model>.ts    One file per model (Document, Collection, User, Team, …)
```

## Conventions

- **Always use the `*WithCtx` helpers for writes** — raw `.save()/.create()`
  skips the audit `Event` row. Set `ctx.state.transaction` (via `transaction()`
  middleware) and `ctx.ip`.
- **Soft delete** via `deletedAt`/`deletedById`; permanent purge only in
  dedicated commands/tasks.
- Multi-table writes need a Sequelize transaction threaded through every call.
- Model rows are shaped for the API by `../presenters/`, not in the model.

## Hot files

`Document.ts` (1521) · `helpers/ProsemirrorHelper.tsx` (1532) ·
`helpers/DocumentHelper.tsx` (1292) · `Collection.ts` (1045) · `User.ts` (941) ·
`helpers/Filters.ts` (563)

## Tests

Colocated `*.test.ts`. Server tests share a module registry — add
`// @vitest-isolate true` as the first line if the test uses `vi.mock` /
`vi.resetModules`.
