# Outline YGPKB — Developer / IT Guide (Technical)

Local development on **Windows without Docker and without WSL**, plus a
production deployment summary. See `docs/ARCHITECTURE.md` and `AGENTS.md` for
upstream architecture and code conventions.

## Repository

- Fork: <https://github.com/donichristian/outline-ygpkb>
- Branches: `main` → `development` → `feature/*`
- Local checkout: `D:\Work-Project\Outline-YGPKB\outline-ygpkb`

## Prerequisites

| Tool | Version | Notes |
| ---- | ------- | ----- |
| Node.js | 22.x | `engines` also allows 20.19+, 24<24.17, 26<26.3.1 |
| Yarn | 4.18.0 | via `corepack` |
| PostgreSQL | 17+ | Windows service, installed via winget |
| Redis | 8.x | `redis-windows` MSYS2 build, installed as a Windows service |
| Git | any | only needed for repository operations |

### Why not Docker or WSL

- **WSL2** is not installed, and enabling it needs a Windows restart.
- **Docker Desktop requires WSL2 or Hyper-V**, so it is not an alternative to
  WSL here.
- This machine also reports `Virtualization Enabled In Firmware: No`, which
  would block WSL2/Hyper-V until VT-x is enabled in the BIOS.
- The `Makefile` targets (`make up`, `make test`) assume Docker, so use the
  `yarn` equivalents below.

## One-time setup

### 1. Node and dependencies

```powershell
corepack enable
cd D:\Work-Project\Outline-YGPKB\outline-ygpkb
yarn install --immutable
```

### 2. PostgreSQL

```powershell
winget install --id PostgreSQL.PostgreSQL.17
```

This registers the `postgresql-x64-17` service (auto-start). The unattended
installer leaves the superuser password as `postgres`. Create the role and
databases:

```powershell
$env:PGPASSWORD = 'postgres'
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'

& $psql -U postgres -h 127.0.0.1 -c "CREATE ROLE ""user"" WITH LOGIN PASSWORD 'pass' SUPERUSER CREATEDB;"
& $psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE outline OWNER ""user"";"
& $psql -U postgres -h 127.0.0.1 -c 'CREATE DATABASE "outline-test" OWNER "user";'
Remove-Item Env:\PGPASSWORD
```

The role **must be SUPERUSER** — migrations run `CREATE EXTENSION` for
`uuid-ossp`, `unaccent`, `pg_trgm` and `btree_gin`.

### 3. Redis

Redis has no official native Windows build; this uses the community
`redis-windows` project, which compiles unmodified upstream Redis source via
MSYS2.

```powershell
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest `
  'https://github.com/redis-windows/redis-windows/releases/download/8.10.2/Redis-8.10.2-Windows-x64-msys2-with-Service.zip' `
  -OutFile "$env:TEMP\redis.zip"
Expand-Archive "$env:TEMP\redis.zip" -DestinationPath C:\redis -Force
```

Edit `C:\redis\Redis-8.10.2-Windows-x64-msys2-with-Service\redis-dev.conf`:

```
bind 127.0.0.1
port 6379
daemonize no
logfile /cygdrive/c/redis/data/redis.log
dir /cygdrive/c/redis/data
```

Two MSYS2 quirks to keep in mind:

- The config path is resolved **relative to the working directory**, so run
  `redis-server.exe redis-dev.conf` from inside the extracted folder.
- Paths *inside* the config must use the `/cygdrive/c/...` form. `C:/redis/...`
  and `/c/redis/...` are both rejected with `No such file or directory`.

Install it as an auto-starting Windows service (requires an **elevated**
PowerShell — service registration is a privileged operation):

```powershell
cd C:\redis\Redis-8.10.2-Windows-x64-msys2-with-Service
.\RedisService.exe install -c "$PWD\redis-dev.conf" --service-name Redis --start-mode auto
```

This is already done on this machine. Confirm with:

```powershell
Get-Service Redis     # Name: Redis, Status: Running, StartMode: Automatic
```

The service name is `Redis` (display name "Redis Server (Redis)"). It starts
at boot, so Redis and PostgreSQL are both available without running anything
manually. Note that `Stop-Service`/`Restart-Service` need an elevated shell.

If you prefer not to use a service, run `.\scripts\dev-start.ps1` instead —
it launches `redis-server.exe` directly and skips that if the service is
already running.

> Avoid `Redis.Redis` in winget — it is the archived Microsoft port at
> **Redis 3.0**. Also avoid the old `tporadowski` builds: Outline calls
> `GETDEL`, which requires Redis 6.2+.

### 4. Environment files

Both files are gitignored (`.gitignore:4-5`).

`.env` — needed because `.sequelizerc:2` loads `.env` (not
`.env.development`) for non-test runs, so without it `yarn db:migrate` has no
`DATABASE_URL`:

```
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/outline
REDIS_URL=redis://127.0.0.1:6379
```

`.env.local` — overrides `.env.development`, holds the secrets and ports:

```
URL=http://localhost:3050
PORT=3050
VITE_DEV_PORT=3051
SECRET_KEY=<64 hex chars>
UTILS_SECRET=<random>
FILE_STORAGE=local
FILE_STORAGE_LOCAL_ROOT_DIR=D:\Work-Project\Outline-YGPKB\outline-ygpkb\data
```

Generate a key with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`URL` is plain HTTP because no local SSL certificate is generated. To use
HTTPS, install `mkcert`, run `yarn install-local-ssl`, drop the `URL` override,
and browse to `https://local.outline.dev:3050` (a hosts entry for
`local.outline.dev` already points at `127.0.0.1`).

### Local ports

Both development ports sit inside the reserved **3050-3100** range:

| Port | Variable | Purpose |
| ---- | -------- | ------- |
| 3050 | `PORT` | API, web service, websocket and collaboration server |
| 3051 | `VITE_DEV_PORT` | Vite dev server, serves assets with hot module reloading |

Browse to **http://localhost:3050** — that is the app. Port 3051 serves the
compiled assets only, because Vite is mounted at `/static/`. Browsing it
directly redirects to port 3050, so either port lands you on the application.

`VITE_DEV_PORT` defaults to 3001 upstream and must differ from `PORT`, since
`server/routes/app.ts` and `server/middlewares/csp.ts` rewrite the backend
port in `URL` to reach the Vite server.

### 5. Build and migrate

`yarn build:server` runs on Windows — `build.js` uses `node:fs` rather than
shell commands:

```powershell
yarn build:server
```

Then migrate. `NODE_ENV` **must** be set, because several data-migration
scripts boot the app's env validator, which only reads `.env.development` when
`NODE_ENV=development`:

```powershell
$env:NODE_ENV = 'development'
yarn db:migrate
```

Expected result: 306 migrations, 42 tables in `public`, and the four required
extensions present.

## Daily development

```powershell
cd D:\Work-Project\Outline-YGPKB\outline-ygpkb
.\scripts\dev-start.ps1
```

Or directly:

```powershell
yarn dev:watch
```

`yarn dev:watch` runs the API server (port 3050) and the Vite dev server
(port 3051) together with hot module reloading. The first run compiles the
server, which takes roughly two minutes; later starts are much faster.

Browse to **http://localhost:3050**.

Verify the stack at any time with `.\scripts\dev-check.ps1`.

### Useful commands

| Task | Command |
| ---- | ------- |
| Lint | `yarn lint` |
| Format | `yarn format` |
| Type check | `yarn tsc` |
| All tests | `yarn test` |
| Server tests | `yarn test:server` |
| Frontend tests | `yarn test:app` |
| New migration | `yarn db:create-migration --name my-migration` |
| Reset dev DB | `yarn db:reset` |

### Makefile equivalents

The `Makefile` assumes Docker. On this machine use:

| Makefile | Windows equivalent |
| -------- | ------------------ |
| `make up` | start Redis, then `yarn dev:watch` |
| `make test` | `yarn db:reset` (with `NODE_ENV=test`), then `yarn test` |
| `make build` | `node build.js` then `yarn vite:build` |

## Testing

Backend tests expect PostgreSQL and Redis on `127.0.0.1`, using the
`outline-test` database (`.env.test`). Set `NODE_ENV=test` before migrating
that database.

Server tests share a module registry; any test using `vi.mock` or
`vi.resetModules` must start with `// @vitest-isolate true`.

## Project layout

- `app/` — React frontend (MobX stores in `app/stores/`)
- `server/` — Koa API, Sequelize models, workers, cron
- `server/migrations/` — Sequelize migrations (306 files)
- `shared/` — shared types, editor, utilities
- `plugins/` — integrations (google, slack, azure, email, oidc, ...)
- `scripts/` — local Windows helper scripts
- `docs/` — project documentation

## Authentication in development

At least one provider must be configured, otherwise there is no way to sign
in. Options: Google, Microsoft Entra (`AZURE_*`), Slack, GitHub, generic OIDC
(`OIDC_*`), Discord, passkeys, or email magic links via the `email` plugin plus
SMTP.

For a working local sign-in, configure your organisation's provider (Azure
Entra is the usual choice) in `.env.local`, and set `SMTP_*` values if you want
email notifications or magic-link sign-in.

## Production deployment

Use the `Dockerfile` and `docker-compose.yml`. Key variables are documented in
`.env.sample`: `URL`, `SECRET_KEY`, `UTILS_SECRET`, `DATABASE_URL`,
`REDIS_URL`, `FILE_STORAGE`, one auth provider, and SMTP.

Checklist:

1. Provision PostgreSQL 16+ and Redis 7+ (managed service or VM).
2. Run the container with `URL=https://kb.your-domain`.
3. Configure the organisation's SSO provider.
4. Back up PostgreSQL plus the storage directory (or S3 bucket).
5. Set `ENABLE_UPDATES=false` to disable anonymous update checks.
6. Do not reuse the development `SECRET_KEY` — it encrypts database columns.

## Troubleshooting

**`yarn db:migrate` fails with "Environment configuration is invalid"**
Set `$env:NODE_ENV = 'development'` first; the validator only loads
`.env.development` in that mode.

**`yarn db:migrate` cannot find a compiled migration script**
Run `yarn build:server` first — some migrations are TypeScript that must be
compiled into `build/server` before the CLI can execute them.

**Redis exits immediately with "can't open config file"**
Run it from inside the extracted folder using the bare filename
`redis-dev.conf`. MSYS2 resolves the argument against the working directory.

**Redis exits with `No such file or directory` on `dir` or `logfile`**
Those paths must use the `/cygdrive/c/redis/data` form.

**`Cannot connect to Redis at 127.0.0.1:6379`**
Redis is not running. Check `Get-Service Redis`; if it is stopped, start it with
`Start-Service Redis` from an elevated shell, or run `.\scripts\dev-start.ps1`.

**Redis works but the app reports connection errors**
Check `REDIS_URL` in `.env`; the migration CLI reads `.env`, not
`.env.local`.

**`yarn dev:watch` does nothing on Windows**
Run `yarn dev:watch` from PowerShell rather than `cmd.exe`, and expect the
first compile to take about two minutes before port 3050 accepts requests.

**Port 3050 refuses connections**
The server has not finished booting. Watch for
`[lifecycle] Listening on http://localhost:3050` in the output.

**Hot reload does not work**
`PORT` and `VITE_DEV_PORT` must differ, and the browser must be on port 3050.
The backend rewrites the `PORT` portion of `URL` to reach Vite, so a mismatch
between the two breaks the injected HMR client.