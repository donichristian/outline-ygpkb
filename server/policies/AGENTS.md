# server/policies/ — authorization layer

## Overview

Vendored fork of npm `cancan` (MIT credit block at bottom of `cancan.ts`). One file per model.
Ability = performer class + action + target class + optional condition.

| Export | Behaviour |
|---|---|
| `allow(model, actions, targets, condition?)` | Registers ability. `actions`/`targets` accept string, array, or `"all"`. `condition` is a function or a plain object (partial field equality against the target). |
| `can(performer, action, target, options?)` | `boolean \| string[]`. |
| `cannot(...)` | `!can(...)`. |
| `authorize(...)` | Throws `AuthorizationError` when denied. Exported separately from the class instance (TS issue 36931). |
| `serialize(performer, target)` | `Record<string, boolean \| string[]>` for every applicable action. |

`getMatchingAbilities` keeps abilities where the performer is `instanceof` the model, the action matches or is `manage` (matches every action), and the target is `instanceof` the registered class or `"all"`. All matches are OR-ed in `computeCan`. There is no deny rule: one matching `allow` grants.

Fork deltas vs upstream: `AsyncLocalStorage` memo scope, membership IDs as result values, `actionsByClass` index, `unscopedClass` walking past `Model.scope()` subclasses. The outermost `can` opens a scope; nested checks reuse a cache keyed on (performer, target, action), skipped when `options` are passed, dead when the outermost call ends.

## Where to look

| File | Contents |
|---|---|
| `cancan.ts` | `class CanCan` and the five exported helpers. |
| `utils.ts` | Condition helpers: `and`, `or`, `isTeamModel`, `isOwner`, `isTeamAdmin`, `isTeamMember`, `isTeamMutable`, `isCollectionOwner`, `isCollectionWritable`, `isGroupAdmin`, `teamHasEntitlement`, `isCloudHosted`. |
| `index.ts` | `export * from "./cancan"` plus one side-effect `import "./<model>"` per policy file. |
| `<model>.ts` | The abilities for that model. |
| `server/presenters/policy.ts` | `presentPolicies(user, models)` returns `[{ id, abilities }]`. |
| `server/commands/` | Call `authorize` / `can` imported from `@server/policies`. |

## Conventions

**Registration.** Abilities are declared at module top level with `allow(...)`. A new policy file is inert until `import "./<file>"` is added to `index.ts`; there is no directory scan. Importing anything from `@server/policies` runs every registration as a side effect.

**Conditions.** Signature `(performer, target, options?) => boolean | string | (boolean | string)[]`. `and(...args)` returns `false` when any arg is falsy, else the args array. `or(...args)` returns the first truthy arg, else `false`.
Both return operands, not booleans: a condition returning membership IDs grants access *and* records which membership granted it, so `can` returns those IDs and `serialize` ships them to the client. `target` may be `null` (class level actions such as `createDocument` on `Team`), so conditions must null check.

**Action names.** camelCase verbs. A model's own file uses bare verbs (`read`, `update`, `delete`); cross-model actions live on the target file (`readDocument`, `updateDocument`, `shareDocument` on `Collection`).

**Example** (`team.ts`):

```ts
allow(User, "read", Team, isTeamModel);

allow(User, "audit", Team, (actor, team) =>
  and(
    //
    isTeamAdmin(actor, team),
    teamHasEntitlement(team, PlanFeature.AuditLog)
  )
);
```

Some `and(...)` calls in `team.ts` open with a bare `//` line — existing shape, keep it when editing.

**Reuse.** Compose with `can(actor, "read", target)` instead of re-deriving permission logic. Conditions must read preloaded relations: `document.memberships` and `document.groupMemberships` need the `withMembership` scope, and `includesMembership` throws an `invariant` when they are missing.

**To the client.** Routes respond with `policies: presentPolicies(user, [model])` beside the model payload; `presentPolicies` calls `serialize`, so the response holds `{ id, abilities }` per model.
The SPA stores it via `addPolicies(res.policies)`, `Policy.flattenedAbilities` flattens membership-ID arrays to booleans, and `usePolicy(entity)` reads `policies.abilities(id)`. `removeForMembership(id)` strips a revoked membership and flips the ability to `false`.

## Anti-patterns

- Authorize after data access. A condition needs the model loaded, so scope the query to what the actor may see, then authorize the loaded rows, and re-run the check on any auth-bearing filter field (see `authorizeFilterFields`).
- Do not hand-roll permission checks in a route. Add an ability, then call `can` or `authorize`.
- Abilities are per-model and additive, no deny wins. A broad `allow(User, "read", "all", ...)` grants for every target and a narrower ability will not override it.
- Conditions must not leak. Membership IDs returned by a condition reach the client, and a condition that passes for a model the user may not see leaks that model's existence through `serialize`.
- Keep conditions pure: no writes, no network, no audit. They run repeatedly, once per action during `serialize`.
- `serialize` swallows a throwing condition into `false` while `authorize` propagates the throw, so a missing preload looks like a denial in the API but crashes the route.
- `isTeamMutable` returns `true` unconditionally in this fork. Placeholder, not a real check.
