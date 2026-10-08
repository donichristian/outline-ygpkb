# app/stores/ — MobX stores

**Business logic lives here, not in components.** One store per model plus a
few UI stores. Components are `observer()` function components that read stores
via `useStores()`.

## Root

- `index.ts` → `const stores = new RootStore()` (default export; `window.stores` in dev).
- `RootStore.ts` registers every store as a public field. Registration uses
  `modelName` + `pluralize(lowerFirst(...))` or an explicit name; **AuthStore is
  registered last** (depends on others). Non-model stores: `DocumentPresenceStore`
  → `presence`, `DialogsStore` → `dialogs`, `UiStore` → `ui`. Calls
  `enablePersistence()` (IndexedDB per team) on construction. Helpers:
  `getStoreForModelName`, `clear`, `enable/disablePersistence`.
- `base/Store.ts` (667) — generic `Store<T extends Model>`: `data: Map`,
  `isFetching/isSaving/isLoaded` observables, RPC actions via `RPCAction` enum,
  pagination via `PAGINATION_SYMBOL`, `apiEndpoint`/`responseKey`, `persistable`.
- `base/IndexedStore.ts` — fractional-index ordering. `base/StorePersistence.ts`
  — IndexedDB cache.

## Key stores

| Store | Responsibility |
|-------|----------------|
| `AuthStore` | session, current user/team, login/logout |
| `DocumentsStore` (794) | document collection, tree, publish/move, templates |
| `CollectionsStore` | collections (hierarchical) |
| `UsersStore` / `GroupsStore` / `MembershipsStore` / `User*`/`Group*` | org + permissions |
| `PoliciesStore` | cached `Policy` cancan checks |
| `UiStore` / `DialogsStore` | UI + modal state |
| `DocumentPresenceStore` | Y.js/WebSocket presence |
| `CommentsStore`/`RevisionsStore`/`SharesStore`/`StarsStore`/`PinsStore`/`ViewsStore`/`TemplatesStore`/`NotificationsStore`/`SearchesStore` | domain data |

## Conventions

- Stores talk to the server through `~/utils/ApiClient` (RPC) — build models
  from payloads, populate related stores from mixed responses.
- Mutations are `@action`; derived values are `computed` (prefer over
  recalculating in render).
- Tests colocated `*.test.ts` (project `app`, jsdom; e.g. `DocumentsStore.test.ts`).
