# app/scenes/ — route-level pages

One folder per screen. A scene folder holds the page component(s) plus its own
`components/` (and sometimes `hooks/`). Routes map to scenes in
`app/routes/{index,authenticated,settings}.tsx` and `routes/scenes.ts` (lazy).

## Structure

Folders: `ApiKeyNew/` · `Collection/` · `Developer/` · `Document/` · `Errors/` ·
`Login/` · `Search/` · `Settings/` · `Shared/` · `Trash/`
Loose pages: `Home.tsx`, `Drafts.tsx`, `Archive.tsx`, `Invite.tsx`,
`KeyboardShortcuts.tsx`, `Logout.tsx`, `DocumentNew/Publish/Delete/
PermanentDelete.tsx`, `TeamNew/Delete.tsx`, `UserDelete.tsx`, `DesktopRedirect.tsx`.

## Where to look

| Task | Location |
|------|----------|
| Document view | `scenes/Document/` (page at `components/Document.tsx`, 560) |
| Settings pages | `scenes/Settings/*.tsx` (Profile, Security, Groups, Templates…) |
| Collection view | `scenes/Collection/` |
| Search | `scenes/Search/` |
| Public share render | `scenes/Shared/` |

## Conventions

- Route slugs are regex-constrained (`name-<10..15 alnum>`) — build paths with
  `~/utils/routeHelpers`, never string-concatenate `/doc/...`.
- Scenes compose from `app/components/` + `app/stores/`; keep page-local pieces in
  the scene's `components/`.
- Lazy-load heavy scenes via routes (`routes/scenes.ts` preloads the editor chunk).

## Anti-patterns

- Do not duplicate shared UI here — promote to `app/components/`.
- Do not fetch inline; go through stores → `ApiClient`.

## Hot files

`Developer/components/ExampleData.ts` (2654, generated example data — not logic) ·
`Document/components/Document.tsx` (560) · `KeyboardShortcuts.tsx` (508)
