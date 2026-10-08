# plugins/ — third-party integrations

Each plugin is self-contained with a `plugin.json` manifest and `server/` and/or
`client/` entry (`server/index.ts`, `client/index.tsx`). Plugins use relative
imports internally plus `@server`, `@shared`, `~` — **not** the `plugins/*` alias.

## Registration

- **Server**: `server/utils/PluginManager.ts` globs and `require()`s
  `plugins/*/server/index.[jt]s`; a broken plugin is logged, not fatal.
  Hooks: `API`, `AuthProvider`, `EmailTemplate`, `IssueProvider`, `Processor`,
  `SearchProvider`, `MentionProvider`, `Task`, `UnfurlProvider`, `Uninstall`,
  `GroupSyncProvider`. Priority `PluginPriority` (VeryHigh=0 … VeryLow=500).
- **Client**: `app/utils/PluginManager.ts` loads `plugins/*/client/index.{ts,tsx}`
  via `import.meta.glob`. Hooks: `Settings`, `Imports`, `Icon`.
- `plugin.json`: `{ id, name, priority?, after?, deployments?: ["community"|"enterprise"|"cloud"] }`.
- Plugins gate themselves on env vars (e.g. `slack` needs `SLACK_CLIENT_ID`).

## Plugins

| Dir | Integrates | Hooks |
|-----|-----------|-------|
| `azure` | Microsoft Entra/Azure AD auth | AuthProvider |
| `diagrams` | Custom Diagrams.net URL | Settings (client) |
| `discord` | Discord auth | AuthProvider |
| `email` | Magic-link email auth (SMTP) | AuthProvider |
| `figma` | Figma unfurl + mentions | API, UnfurlProvider |
| `github` | GitHub unfurl/issues/webhooks | API, Task, IssueProvider, UnfurlProvider, MentionProvider, Uninstall |
| `gitlab` | GitLab unfurl/issues | API, IssueProvider, UnfurlProvider, MentionProvider, Task |
| `google` | Google auth | AuthProvider |
| `googleanalytics` | GA4 | Settings |
| `iframely` | 3rd-party link previews | UnfurlProvider (VeryLow — runs last) |
| `linear` | Linear issues | API, Task, UnfurlProvider, MentionProvider, Uninstall |
| `matomo` | Matomo analytics | Settings (admin) |
| `notion` | Notion import | API, Processor, Task + client Imports |
| `oidc` | OpenID Connect auth | AuthProvider |
| `passkeys` | WebAuthn passkeys | AuthProvider, API, Processor, EmailTemplate |
| `search-postgres` | PG tsvector search | SearchProvider |
| `slab` | Slab zip import | Processor, Task + client Imports |
| `slack` | Slack auth/`/outline` command/notifications | AuthProvider, API, Processor |
| `storage` | Local file-storage API | API |
| `umami` | Umami analytics | Settings (admin) |
| `webhooks` | HTTP webhooks for events | API, Processor, 2× Task |
| `zapier` | Zapier connect (cloud only) | Settings |

## Gotchas

- Plugin **server** tests run under the server vitest projects (need PG+Redis);
  there is no separate client-plugin test project.
- `plugins/enterprise/client/translations.tsx` is translations-only (no manifest/entry).
- `build.js` copies each `plugin.json` into `build/plugins/<name>/`.
- Hook consumers to know: `server/models/helpers/AuthenticationHelper.ts`,
  `server/routes/api/urls/urls.ts`, `server/queue{s}/…/index.ts`,
  `app/hooks/useSettingsConfig.ts`, `app/components/PluginIcon.tsx`.
