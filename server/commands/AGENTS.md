# server/commands/ — cross-model write workflows

## Overview

Write layer between RPC routes and the model graph. A command owns a write
spanning several rows or models and returns the mutated model(s) for the route
to present. Parent `server/AGENTS.md` covers request flow, middleware,
policies, presenters. Callers: `server/routes/api/<resource>/<resource>.ts`,
`server/mcp/tools/`, `server/queues/tasks/`. No `server/commands/index.ts` —
import the file directly.

## Where to look

| Family | Files |
|---|---|
| Document lifecycle | `documentCreator` `documentUpdater` `documentMover` `documentDuplicator` `documentImporter` `documentCollaborativeUpdater` `documentRestorer` `documentPermanentDeleter` `collectionDuplicator` |
| Users & teams | `accountProvisioner` `userProvisioner` `userInviter` `userPermanentDeleter` `teamCreator` `teamProvisioner` `teamUpdater` `teamPermanentDeleter` |
| Loaders & UX rows | `documentLoader` `personalCollectionLoader` `shareLoader` `starCreator` `pinCreator` `subscriptionCreator` `attachmentCreator` |
| Group sync | `groupsSyncer` |
| AI chat (fork) | `aiChatSessionCreator` `aiChatMessageCreator` `aiChatSessionDestroyer` |

Publishing is not a command file: `document.publish(ctx, { collectionId, data })` is a Document model method.

## Conventions

**Shape.** Default export, dominant signature
`async function <name>(ctx: APIContext, props)`; minority variant puts `ctx`
inside `Props` (`starCreator`, `attachmentCreator`, `documentImporter`).
`Props` lives in the command file, but the route owns the zod schema
(`server/routes/api/documents/schema.ts` → `DocumentsCreateSchema`) and passes `ctx.input.body` field by field — keep both field lists in sync.

**Writes.** `ctx.state.transaction` comes from the `transaction()` middleware
(`server/middlewares/transaction.ts`); pass it to every query. Write through
`saveWithCtx` / `createWithCtx` / `destroyWithCtx` / `findOrCreateWithCtx`
(`server/models/base/Model.ts`): they set `event.publish = true`, so model
hooks write an `Event` row and `Event`'s `@AfterSave` hook pushes it to
`globalEventQueue` after commit — `SearchIndexProcessor`,
`NotificationsProcessor`, `RevisionsProcessor`, `BacklinksProcessor` and
`WebsocketsProcessor` react to it. Raw `.save()` / `.create()` writes the row
but emits no `Event`: search, notifications, revisions and websocket updates never fire.

**Authorization helpers.** `authorizeDocumentCreate` and `authorizeDocumentPublish`
(both in `documentCreator.ts`) are reused by `server/routes/api/documents/documents.ts`
and `server/mcp/tools/documents.ts`. The loaders that other layers import live
beside them, not in `documentCreator.ts`: `documentsDuplicator` is also exported
from `documentDuplicator.ts`, `provisionFirstCollection` from
`accountProvisioner.ts`, `resolvePersonalCollectionId` from
`personalCollectionLoader.ts`, and `loadPublicShare` from `shareLoader.ts`.

**Naming and tests.** File name `<entity><Verb>.ts` camelCase, one command
per file, colocated `<name>.test.ts`. Server tests share a module registry
per worker: a test using `vi.mock` or `vi.resetModules` must start with
`// @vitest-isolate true` as its first line.

**Command vs model method.** Model method when one row and its own invariants
are involved (`document.publish`, `document.restoreTo`,
`collection.addDocumentToStructure`). Command when the workflow spans models
and each row needs its own audit event — `documentMover` also touches collection
structure and pins, `documentDuplicator` calls `documentCreator` per copy,
`groupsSyncer` writes `ExternalGroup`, `Group`, `GroupUser`.

## Anti-patterns

- Raw `.save()` inside a command, or a query without `transaction` — events
  are lost silently; `insertEvent` logs "No transaction provided to insertEvent".
- Setting `document.collectionId` without touching the collection structure —
  `documentMover` is the sanctioned path (maintains collection structure, removes stale pins).
- Reading `document.collection` after a save — structure hooks replace the
  loaded association, so policies see stale membership; reload with `Document.findByPk(id, { userId })`.
- Re-implementing a permission check in a route instead of calling the
  exported `authorize*` helper — route and MCP tool drift apart.
- Comparing revisions outside a lock — `documentUpdater` locks the row
  (`lock: transaction.LOCK.UPDATE`) and throws `DocumentConflictError` when `lastRevision` no longer matches.
