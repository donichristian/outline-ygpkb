# app/models/ — client-side models

Client-side projections of server entities: MobX observables plus decorators. Server side is Sequelize rows (`server/models/AGENTS.md`); these are the SPA copy.

## Overview

**Base.** `app/models/base/Model.ts` is abstract; `static modelName` is the key the store layer matches on (`RootStore.getStoreForModelName`). `ParanoidModel` (soft delete: `deletedAt`, `isDeleted`) and `ArchivableModel` (archive: `archivedAt`) both extend `Model`, and `Document` extends `ArchivableModel`. `NavigableModel` (tree navigation: `node`, `pathToDocument()`) extends `Model` directly — it is not part of that chain. `Collection`, `User`, `OAuthClient` extend `ParanoidModel`; `OAuthAuthentication` extends `Model`. Base members: `fetch`, `refresh`, `delete`, `loadRelations()`, `toAPI`, `toPersisted`, `fromPersisted`, `isDirty`.

**Constructor contract.** `super(fields, store)`, then `this.initialize(fields)` in the most-derived class. `initialize` pre-defines each declared field as an own property (`Object.defineProperty`, value `undefined`), applies the payload through `updateData`, sets `isNew = !id`, then calls `makeObservable(this)`.

**Field to API payload.** `@Field` (`decorators/Field.ts`) records the key in a WeakMap keyed by the class; `toAPI()` = `pick(this, fields)`, so only `@Field` keys reach the server. `fromPersisted()` / `toPersisted()` round-trip that subset. `updateData(data)` is a MobX `action(...)` wrapper (not an `@action` decorator): skips `initialized` and unchanged values, sets the rest, re-runs `makeObservable(this)` when the payload added a key, rewrites `persistedAttributes`. `isDirty()` diffs `persistedAttributes` against `toAPI()`.

**Save path.** `save(params?, options?)`: `params ?? toAPI()` -> `beforeCreate` / `beforeUpdate` hook -> `store.save({...params, id}, {isNew})` -> `Store.save` picks `create` / `update` -> `client.post("/<apiEndpoint>.create" | ".update")` -> `updateData(response)` -> `afterCreate` / `afterUpdate` hook. `isSaving` brackets the call.

**Decorators.**

- `@Field` (`decorators/Field.ts`): key is serializable, so it joins the API payload.
- `@Relation(classResolver, options?)` (`decorators/Relation.ts`): related-model accessor; options `required`, `multiple`, `onDelete`, `onArchive`.
- `@BeforeCreate`, `@AfterCreate`, `@BeforeUpdate`, `@AfterUpdate`, `@BeforeChange`, `@AfterChange`, `@BeforeRemove`, `@AfterRemove`, `@BeforeDelete`, `@AfterDelete` (`decorators/Lifecycle.ts`): static method registered as a hook, run by `LifecycleManager` around save, change and delete.

**Relations.** The getter reads the id key (`<property>Id`, or `<singular>Ids` when `multiple`), then resolves through `store.rootStore.getStoreForModelName(related.modelName).get(id)`. An unregistered model throws `No store found for model name` (invariant); a missing related record gives `undefined` for a single relation, `[]` for `multiple`. The setter writes the id back and `store.add(...)` the value. `onDelete` / `onArchive` drive cascade in `Store.remove` / `Store.addToArchive`.

**MobX initializer rule.** `.oxlintrc.json` loads `./.oxlint/mobx.mjs` through `jsPlugins` and enables `mobx/observable-needs-initializer: "error"`. The plugin (`meta.name = "mobx"`) flags any `@observable` field without an initializer in a class whose constructor calls `makeObservable(this)`, unless the constructor assigns `this.<field>` first. Cause: with `useDefineForClassFields` off (`target: es2020`) an uninitialized field never becomes an own property, so `makeObservable` skips it. `Model.initialize` pre-defines declared fields with value `undefined`; `updateData` re-runs `makeObservable` for keys the payload introduced.

## Where to look

| Task | File |
|------|------|
| Base model, field and relation plumbing | `app/models/base/Model.ts` |
| Soft delete, archive and navigation bases | `app/models/base/ParanoidModel.ts`, `ArchivableModel.ts`, `NavigableModel.ts` |
| Mark a field API-serializable | `app/models/decorators/Field.ts` |
| Relation accessor and cascade options | `app/models/decorators/Relation.ts` |
| Lifecycle hook registration | `app/models/decorators/Lifecycle.ts` |
| Search contract, ProseMirror conversion | `app/models/interfaces/Searchable.ts`, `app/models/helpers/ProsemirrorHelper.ts` |
| OAuth app and token models | `app/models/oauth/OAuthClient.ts`, `OAuthAuthentication.ts` |
| Worked examples | `app/models/Document.ts`, `Collection.ts`, `User.ts` |

## Conventions

- `static modelName` on every model; store registration and relation lookup key off it.
- One model per file, `export default class`, file name matches the model.
- `this.initialize(fields)` last in the constructor.
- `@Field` on every field that must reach the API; local-only state omits it.
- `@Field` and `@observable` together; relation properties are plain accessors.
- Declare the relation id key under the derived name (`createdById`, `collaboratorIds`).
- Derived values are `@computed` getters; mutations are `@action`, or `runInAction` after await.

## Anti-patterns

- Don't fetch from a model: `save`, `delete` and `fetch` delegate to the store; call `client.post` only for endpoints with no store (`documents.export`, `oauthClients.rotate_secret`).
- Don't add an `@observable` field without an initializer: lint errors, MobX skips it.
- Don't assume a relation target is loaded: single may be `undefined`, multiple `[]`.
- Don't hand-build the API payload when `toAPI()` covers it; `@Field` decides the shape.
- Don't mutate a relation from its getter; it resolves through the store.
