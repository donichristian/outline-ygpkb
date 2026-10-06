# Outline YGPKB — Developer / IT Guide (Technical)

This document covers local development on Windows without Docker, and a
summary of production deployment. For the upstream architecture and
conventions, see `docs/ARCHITECTURE.md` and `AGENTS.md`.

## Repository

- Fork: <https://github.com/donichristian/outline-ygpkb>
- Default branch: `main`
- Local checkout: `D:\Work-Project\Outline-YGPKB\outline-ygpkb`

## Prerequisites

| Tool | Version | Notes |
| ---- | ------- | ----- |
| Node.js | 22.x (engines also allow 20.19+, 24<24.17, 26<26.3.1) | Installed at `C:\Program Files\nodejs` |
| Yarn | 4.18.0 | Enabled via `corepack` |
| PostgreSQL | 16+ | Runs in WSL2 Ubuntu |
| Redis | 7+ | Runs in WSL2 Ubuntu |
| Git | any | |

Docker Desktop is **not** required and is intentionally avoided in this
setup. The provided `Makefile` targets (`make up`, `make test`, ...) use
Docker, so use the `yarn` equivalents below instead.

## One-time environment setup (Windows)

### 1. Enable WSL2 (requires one restart)

```powershell
wsl --install -d Ubuntu
```

If the install fails with `HCS_E_HYPERV_NOT_INSTALLED`, enable the required
Windows features and restart:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart -All
Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart -All
```

Then reboot, and run `wsl --install -d Ubuntu` again.

### 2. Start PostgreSQL and Redis in WSL2

Inside the Ubuntu shell:

```bash
sudo apt update
sudo apt install -y postgresql redis-server
sudo service postgresql start
sudo service redis-server start
sudo -u postgres psql -c "CREATE USER \"user\" WITH PASSWORD 'pass' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE outline OWNER \"user\";"
sudo -u postgres psql -c "CREATE DATABASE \"outline-test\" OWNER \"user\";"
```

Redis listens on `127.0.0.1:6379` and PostgreSQL on `127.0.0.1:5432`; both
are reachable from Windows via localhost forwarding (WSL2 default).

To start them again after a reboot:

```bash
sudo service postgresql start && sudo service redis-server start
```

### 3. Node + dependencies

```powershell
corepack enable
cd D:\Work-Project\Outline-YGPKB\outline-ygpkb
yarn install --immutable
```

### 4. Local environment file

`.env.local` is already created (gitignored) with:

- `URL=http://localhost:3000` (overrides `.env.development` HTTPS URL)
- Generated `SECRET_KEY` and `UTILS_SECRET`
- Local file storage under `./data`

To enable HTTPS locally instead, install `mkcert`, run
`yarn install-local-ssl`, remove the `URL` override from `.env.local`, and
use `https://local.outline.dev:3000` (a hosts entry
`127.0.0.1 local.outline.dev` was already added to
`C:\Windows\System32\drivers\etc\hosts`).

### 5. Database migrations

```powershell
yarn db:migrate
```

For the test database (run once, and after pulling new migrations):

```powershell
$env:NODE_ENV='test'; yarn db:migrate; Remove-Item Env:NODE_ENV
```

## Daily development

```powershell
cd D:\Work-Project\Outline-YGPKB\outline-ygpkb
yarn dev:watch
```

- API + websockets + worker: `http://localhost:3000`
- Frontend (Vite, HMR): `http://localhost:3000` (served through the same port
  in dev via the proxy — check the console output for the Vite port)

### Useful commands

| Task | Command |
| ---- | ------- |
| Lint | `yarn lint` |
| Format | `yarn format` |
| Type check | `yarn tsc` |
| Run all tests | `yarn test` |
| Server tests | `yarn test:server` |
| Frontend tests | `yarn test:app` |
| New migration | `yarn db:create-migration --name my-migration` |
| Reset dev DB | `yarn db:reset` |

## Testing

Tests use Vitest. Backend tests expect PostgreSQL + Redis at `127.0.0.1`
using `DATABASE_URL=postgres://user:pass@127.0.0.1:5432/outline-test`
(from `.env.test`). Create the `outline-test` database once as shown above.

Server tests share a module registry; any server test that uses `vi.mock` or
`vi.resetModules` must start with `// @vitest-isolate true`.

## Project layout

- `app/` — React frontend (MobX stores in `app/stores/`)
- `server/` — Koa API, Sequelize models, workers, cron
- `server/migrations/` — Sequelize migrations
- `shared/` — shared types, editor, utilities
- `plugins/` — optional integrations (google, slack, azure, email, ...)
- `docs/` — project documentation

## Authentication in dev

At least one auth provider must be configured. Options:

- OAuth providers: Google, Microsoft Entra (`AZURE_*`), Slack, GitHub, OIDC
  (`OIDC_*`), Discord
- Email magic links via the `email` plugin + SMTP settings
- Passkeys plugin

For a local test instance you can set placeholder OAuth credentials; the
sign-in button is still shown. For a working sign-in flow, configure a real
provider (e.g. your organization's Azure Entra app registration) and set the
corresponding env vars in `.env.local`.

## Production deployment

See `Dockerfile`, `docker-compose.yml`, and the repo `README.md` for the
upstream production configuration. Key env vars are documented in
`.env.sample`: `URL`, `SECRET_KEY`, `UTILS_SECRET`, `DATABASE_URL`,
`REDIS_URL`, `FILE_STORAGE`, one auth provider, and SMTP for outgoing email.

Internal deployment checklist:

1. Provision PostgreSQL 16+ and Redis 7+ (managed service or VM).
2. Run the container image with `URL=https://kb.your-domain`.
3. Configure the org's SSO provider (Azure Entra recommended).
4. Back up PostgreSQL and the local file-storage directory (`FILE_STORAGE_LOCAL_ROOT_DIR`) or S3 bucket.
5. Enable `ENABLE_UPDATES=false` if you do not want anonymous update checks.

## Troubleshooting

- **`NODE_ENV=development yarn ...` fails on Windows PowerShell** — use yarn
  scripts (they run through Yarn's cross-platform shell); prefix with
  `$env:NODE_ENV='development';` in PowerShell if invoking tools directly.
- **Cannot connect to Postgres/Redis** — make sure the WSL2 services are
  running: `wsl -d Ubuntu -e sudo service postgresql start`.
- **HTTPS cert errors** — you removed the local CA; use the plain HTTP
  `URL` override in `.env.local`.
- **Port 5432/6379 already in use** — stop any other local Postgres/Redis
  service (e.g. the MySQL install here does not conflict, but a native
  Postgres would).
