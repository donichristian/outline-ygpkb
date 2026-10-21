# Outline YGPKB: Production Deployment Guide

Step-by-step runbook for deploying this Outline fork (`outline-ygpkb`) to a
Linux server or any Docker host. For local Windows development see
`docs/TECHNICAL-GUIDE.md`; for the service model see `docs/SERVICES.md` and
`server/AGENTS.md`.

## Overview

Outline is a fast, collaborative knowledge base: a React 19 SPA served by a
Koa + Sequelize backend, with Y.js realtime collaboration and Bull job queues.

The whole backend is one Node program, `node build/server/index.js`, launched
under a `throng` process supervisor. That single program can run any combination
of these services:

| Service | Role | Notes |
| ------- | ---- | ----- |
| `web` | Hosts the SPA, the RPC API, auth, OAuth and MCP | Mandatory, at least one process |
| `worker` | Processes the Bull queues (async jobs, event reactors) | Mandatory, at least one process |
| `websockets` | Socket.IO on `/realtime` | Same box or separate |
| `collaboration` | Hocuspocus Y.js server on `/collaboration` | Same box or separate |
| `cron` | Schedules `CronTask`s (hourly and daily intervals) | Not in the default image service set, add explicitly |
| `admin` | Bull Board at `/admin` | Development only, blocked when `NODE_ENV=production` |

Select services with the `--services=` CLI flag or the `SERVICES` environment
variable, comma-separated. The flag wins over the variable. Example:

```bash
node build/server/index.js --services=web,worker
```

With no flag and no `SERVICES` variable the image runs the default production
set in a single process: `collaboration,websockets,worker,web` (from
`server/env.ts`).

The repo `Procfile` splits the work into two dyno-style processes, which is the
minimum workable production split:

```text
web: yarn start --services=web,websockets,collaboration
worker: yarn start --services=worker
```

In short, a deployment is: run the app (one or more processes) against a
PostgreSQL database and a Redis instance, with a reverse proxy for TLS and at
least one authentication provider configured. No auth provider means the app
boots but nobody can sign in.

## Deployment options

| Option | When to use | Notes |
| ------ | ----------- | ----- |
| **Docker (recommended)** | Any Docker host, Linux VM, or container platform | Reproducible, matches the shipped `Dockerfile`, healthcheck included |
| Bare Node on Linux | No Docker available, or you want an uncontainerised systemd service | You own the toolchain, TLS and process supervision |

Docker is recommended. It packages the exact runtime, user, volume and
healthcheck the fork ships, and it is the only path that works from Windows
without a POSIX shell. Do not attempt a bare Node production install on Windows:
`yarn build` (which runs `build:i18n` / `copy:i18n` via `mkdir -p` and `cp`)
needs a POSIX environment, and Windows is supported for local development only.

## Prerequisites

| Tool | Version | Notes |
| ---- | ------- | ----- |
| Node.js | 22.x | `engines` also allows 20.19+, 24<24.17.0, 26<26.3.1 |
| Yarn | 4.18.0 | via `corepack`, pinned in `package.json` |
| PostgreSQL | 16+ (17+ recommended) | Managed service or your own instance |
| Redis | 7+ (8+ recommended) | `GETDEL` requires Redis 6.2 or newer |
| Docker | recent | For Option A; the base image builds `node:26.3.0` |
| Git | any | To clone the fork |
| Reverse proxy | nginx or Caddy | Provides TLS in front of port 3000 |

Migrations run `CREATE EXTENSION` for `uuid-ossp`, `unaccent`, `pg_trgm` and
`btree_gin`, so the database role must be allowed to create extensions (a
superuser, or a role with the equivalent privileges).

## Option A: Docker (recommended)

Run every command below on the Docker host, in a clone of the fork.

### 1. Clone the fork

```bash
git clone https://github.com/donichristian/outline-ygpkb.git
cd outline-ygpkb
git checkout development
```

This fork integrates on `development`; feature and fix branches flow from
`development` into `main`. Deploy from the branch you have validated.

### 2. Build the fork's own base image first

This is the most important fork-specific step. The app `Dockerfile` copies the
compiled application from a base image:

```text
ARG BASE_IMAGE=outlinewiki/outline-base
FROM ${BASE_IMAGE} AS base
```

The `outlinewiki/outline-base` image published on Docker Hub contains **upstream
Outline**, not this fork's code. Building the app image against it would ship
upstream source, not the fork. You must rebuild the base image from the fork
source locally (or in your own CI), then build the app image against it:

```bash
docker build -f Dockerfile.base -t outline-base .
docker build --build-arg BASE_IMAGE=outline-base -t outline-ygpkb .
```

How the two stages work (from `Dockerfile.base` and `Dockerfile`):

- `Dockerfile.base` (`FROM node:26.3.0`) copies `package.json` / `yarn.lock` /
  `.yarnrc.yml`, runs `yarn install --immutable`, copies the source, runs
  `yarn build`, then `yarn workspaces focus --production`. It produces the
  compiled `build/`, `server/`, `public/` and production `node_modules/`.
- `Dockerfile` uses that base image and a runner stage `FROM node:26.3.0-slim`,
  copies the compiled artifacts, installs `wget` for the healthcheck, creates a
  non-root user `nodejs` (uid/gid 1001), sets
  `FILE_STORAGE_LOCAL_ROOT_DIR=/var/lib/outline/data`, declares
  `VOLUME /var/lib/outline/data`, exposes port 3000 and runs
  `CMD ["node", "build/server/index.js"]`.

The image healthcheck is:

```text
HEALTHCHECK --interval=1m CMD wget -qO- "http://localhost:${PORT:-3000}/_health" | grep -q "OK" || exit 1
```

No upstream CI publishes this fork. The upstream workflow
`.github/workflows/docker.yml` (triggered on `v*` tags) calls
`docker-build.yml`, which pushes `outlinewiki/outline` and
`outlinewiki/outline-base` using the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`
secrets. It targets the upstream namespace, so it is **not** the path for a
fork. Build the two images yourself.

### 3. Provision PostgreSQL and Redis

Use a managed service, your own containers, or the repo's local compose helper.
Note that the repo `docker-compose.yml` defines **only** `redis` and `postgres`
(no app service); it is a local helper that binds both to `127.0.0.1`:

```bash
docker compose up -d postgres redis
```

For a self-contained production stack, extend the compose file with an `outline`
service that uses the locally built image:

```yaml
services:
  postgres:
    image: postgres
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: change_me
      POSTGRES_DB: outline
    volumes:
      - postgres-data:/var/lib/postgresql/data
    restart: unless-stopped

  redis:
    image: redis
    restart: unless-stopped

  outline:
    image: outline-ygpkb
    env_file: .env
    ports:
      - "3000:3000"
    volumes:
      - outline-data:/var/lib/outline/data
    depends_on:
      - postgres
      - redis
    restart: unless-stopped

volumes:
  postgres-data:
  outline-data:
```

### 4. Create the environment file

```bash
cp .env.sample .env
```

Generate the two secrets, then edit `.env`:

```bash
openssl rand -hex 32    # SECRET_KEY
openssl rand -hex 32    # UTILS_SECRET
```

At a minimum set `URL`, `SECRET_KEY`, `UTILS_SECRET`, `DATABASE_URL`,
`REDIS_URL`, `FILE_STORAGE`, and one auth provider. See
[Environment reference](#environment-reference) for the full list.

### 5. Run migrations

Migrations run from the app image by overriding the default command. The
Sequelize CLI ships in the image's `node_modules` and `.sequelizerc` is copied
in, so it resolves the migrations and database config from the container:

```bash
docker run --rm --env-file .env outline-ygpkb npx sequelize db:migrate
```

If you prefer to run via Yarn, use the base image, which has Corepack and Yarn
enabled:

```bash
docker run --rm --env-file .env outline-base yarn db:migrate
```

The repository currently has 308 migrations under `server/migrations` (plain
CommonJS `.js` files). Migrations are forward-only; rollback is
`sequelize db:migrate:undo`.

### 6. Start the app container

```bash
docker run -d \
  --name outline \
  --env-file .env \
  -p 3000:3000 \
  -v outline-data:/var/lib/outline/data \
  --restart unless-stopped \
  outline-ygpkb
```

By default this runs `collaboration,websockets,worker,web` in one process. To
split web and worker, override the command and start two containers (or two
compose services) that share the same `.env`, Postgres and Redis:

```bash
docker run -d --name outline-web --env-file .env -p 3000:3000 \
  -v outline-data:/var/lib/outline/data --restart unless-stopped \
  outline-ygpkb node build/server/index.js --services=web,websockets,collaboration

docker run -d --name outline-worker --env-file .env --restart unless-stopped \
  outline-ygpkb node build/server/index.js --services=worker
```

Add `cron` to one of the service lists if you rely on scheduled tasks, since it
is not part of the default set:

```bash
--services=worker,cron
```

### 7. Put a reverse proxy in front for TLS

Terminate TLS at nginx (or Caddy) and proxy to the container's port 3000. A
minimal nginx server block:

```nginx
server {
    listen 443 ssl;
    server_name kb.your-domain.example;

    ssl_certificate     /etc/letsencrypt/live/kb.your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kb.your-domain.example/privkey.pem;

    location / {
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://127.0.0.1:3000;
    }
}
```

When TLS terminates at the proxy, set `FORCE_HTTPS=false` and
`PROXY_HEADERS_TRUSTED=true` in `.env` to avoid a redirect loop (see
[Troubleshooting](#troubleshooting)). Set `URL` to the public HTTPS URL.

## Option B: Bare Node on Linux

For hosts without Docker. You are responsible for process supervision and TLS.

### 1. Install the toolchain

Install Node.js 22.x, enable Corepack, then confirm Yarn resolves to the pinned
version:

```bash
corepack enable
node --version
yarn --version    # expect 4.18.0
```

### 2. Clone and install

```bash
git clone https://github.com/donichristian/outline-ygpkb.git
cd outline-ygpkb
git checkout development
yarn install --immutable
```

### 3. Build

```bash
yarn build
```

`yarn build` runs `clean`, `vite:build`, `build:i18n` and `build:server`, and
must run on Linux (the i18n step uses `mkdir -p` / `cp`). It produces
`build/server/index.js`, the compiled SPA assets and the locale files.

### 4. Configure the environment

```bash
cp .env.sample .env
openssl rand -hex 32    # SECRET_KEY
openssl rand -hex 32    # UTILS_SECRET
```

The server loads `.env` from the working directory and, in production,
`.env.production` (see `server/utils/environment.ts`). Edit `.env` with the
values from [Environment reference](#environment-reference).

### 5. Run migrations

`.sequelizerc` loads `.env` and points Sequelize at `server/migrations` and
`server/config/database.js`:

```bash
NODE_ENV=production yarn db:migrate
```

The fork's documented local flow runs `yarn db:migrate` with
`NODE_ENV=development` so the app's env validator reads `.env.development`; in
production, run it with `NODE_ENV=production` and a complete `.env` (or exported
variables). Roll back a single migration with `yarn db:rollback`.

### 6. Start the services

```bash
NODE_ENV=production yarn start --services=web,websockets,collaboration
NODE_ENV=production yarn start --services=worker
NODE_ENV=production yarn start --services=worker,cron
```

`yarn start` is `node ./build/server/index.js`. Run the web process and at least
one worker process. `WEB_CONCURRENCY` controls the number of worker processes
spawned by the supervisor (default 1; a rough rule of thumb is server RAM in MB
divided by 512).

Supervise these with systemd, one unit per service, for example:

```ini
[Unit]
Description=Outline web
After=network.target postgresql.service redis.service

[Service]
Type=simple
WorkingDirectory=/opt/outline-ygpkb
Environment=NODE_ENV=production
ExecStart=/usr/bin/yarn start --services=web,websockets,collaboration
Restart=always
User=outline

[Install]
WantedBy=multi-user.target
```

Create a second unit with `--services=worker` (and, if needed, `cron`), and add
a reverse proxy for TLS exactly as in Option A step 7.

## Environment reference

All variable names below are the exact names in `.env.sample`. Generate secrets
with `openssl rand -hex 32`.

### Required to boot

| Variable | Example | Notes |
| -------- | ------- | ----- |
| `URL` | `https://kb.your-domain.example` | Fully-qualified, publicly reachable URL. Behind a proxy this is the proxy's URL. |
| `SECRET_KEY` | `<32-byte hex>` | 32-byte hex. Encrypts database columns. Never reuse the development value. |
| `UTILS_SECRET` | `<random>` | Any random string. |
| `DATABASE_URL` | `postgres://user:pass@postgres:5432/outline` | Postgres connection string. |
| `REDIS_URL` | `redis://redis:6379` | ioredis-compatible URL, or a Base64-encoded config object. |
| `FILE_STORAGE` | `local` or `s3` | Where images and attachments are stored. |

### Authentication

At least one provider is required, or the app has no sign-in options. The app
still boots without one, but is unusable.

| Provider | Variables |
| -------- | --------- |
| Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Microsoft Entra | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_RESOURCE_APP_ID` |
| Discord | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_SERVER_ID`, `DISCORD_SERVER_ROLES` |
| Generic OIDC | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_AUTH_URI`, `OIDC_TOKEN_URI`, `OIDC_USERINFO_URI`, `OIDC_LOGOUT_URI`, `OIDC_USERNAME_CLAIM`, `OIDC_DISPLAY_NAME`, `OIDC_SCOPES` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Email magic links | `SMTP_SERVICE`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` |

### Storage

- `FILE_STORAGE=local` stores files on disk. Set `FILE_STORAGE_LOCAL_ROOT_DIR`
  (the image default is `/var/lib/outline/data`, declared as a volume).
- `FILE_STORAGE=s3` stores files in an S3-compatible bucket. Requires:
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
  `AWS_S3_UPLOAD_BUCKET_URL`, `AWS_S3_UPLOAD_BUCKET_NAME`,
  `AWS_S3_FORCE_PATH_STYLE`, `AWS_S3_ACL`, and optionally
  `AWS_S3_UPLOAD_METHOD` (`post` or `put`). Providers such as Cloudflare R2
  need `AWS_S3_UPLOAD_METHOD=put`. Optional CloudFront signing uses
  `AWS_CLOUDFRONT_URL`, `AWS_CLOUDFRONT_KEY_PAIR_ID`,
  `AWS_CLOUDFRONT_PRIVATE_KEY`.

### Optional

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `PORT` | `3000` | Container port. Must match the healthcheck. |
| `CDN_URL` | | Hostname for JS, CSS and images served through a CDN. |
| `WEB_CONCURRENCY` | `1` | Worker processes. Rough estimate: RAM in MB / 512. |
| `DEFAULT_LANGUAGE` | `en_US` | Default interface language. |
| `COLLABORATION_URL` | | Only when collaboration runs on a separate domain, e.g. `wss://docs-collaboration.example.com`. Not needed for a single box. |
| `REDIS_COLLABORATION_URL` | | Separate Redis for horizontal collaboration scaling (may equal `REDIS_URL`). |
| `SSL_KEY`, `SSL_CERT` | | Base64-encoded key and certificate for HTTPS termination in the app. |
| `FORCE_HTTPS` | `true` | Set `false` when TLS terminates at an external load balancer. |
| `PROXY_IP_HEADER` | `X-Forwarded-For` | Header to read the client IP from behind a proxy. |
| `PROXY_HEADERS_TRUSTED` | | `true` to trust `X-Forwarded-*` headers from an upstream proxy. |
| `PGSSLMODE` | | Set `disable` only when the database is on the same machine. |
| `DATABASE_CONNECTION_POOL_MIN`, `DATABASE_CONNECTION_POOL_MAX` | `0`, `5` | Per-process pool. Keep within the database's connection limit. |
| `ENABLE_UPDATES` | `true` | Set `false` to disable anonymous update checks; recommended for a private fork. |
| `RATE_LIMITER_ENABLED` | `true` | Global rate limiter on/off. |
| `RATE_LIMITER_REQUESTS` | `1000` | Global request budget per window. |
| `RATE_LIMITER_DURATION_WINDOW` | `60` | Window length in seconds. |
| `RATE_LIMITER_MULTIPLIER` | `1` | Multiplier for hardcoded per-endpoint limits. |
| `AI_CHAT_BASE_URL`, `AI_CHAT_API_KEY`, `AI_CHAT_MODEL`, `AI_CHAT_GROUNDING` | | Fork AI chat. Disabled when unset. See `docs/AI-CHAT.md`. |
| `SENTRY_DSN`, `SENTRY_TUNNEL` | | Optional Sentry error and performance tracking. |
| `DEBUG` | `http` | Debug categories. `DEBUG=*` for everything. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `http`, `verbose`, `debug` or `silly`. |

`NODE_ENV=production` is already set inside the image.

### File-based secrets

Any variable can be loaded from a file by appending `_FILE` to its name and
setting the value to the file path, which is useful for Docker secrets. For
example:

```text
SECRET_KEY_FILE=/run/secrets/outline_secret_key
```

The file contents are trimmed. If both the direct variable and the `_FILE`
variant are set, the direct variable wins.

## Post-deploy verification

1. Health endpoint. `GET /_health` returns `OK` when both the database and Redis
   respond (this is what the image healthcheck uses):

   ```bash
   curl -fsS http://localhost:3000/_health
   ```

2. Container health and logs. Confirm the container reports `healthy` and the
   logs contain the lifecycle line:

   ```bash
   docker inspect --format '{{.State.Health.Status}}' outline
   docker logs outline | grep "[lifecycle] Listening on"
   ```

   Expect `[lifecycle] Listening on http://localhost:3000 / <URL>`.

3. Open `URL` in a browser and confirm the sign-in options render. If the login
   screen has no providers, no auth provider is configured.

4. Worker running. Confirm at least one `worker` process is up so Bull queues
   drain. In the logs, look for `Starting worker service`.

5. Updates disabled (optional). With `ENABLE_UPDATES=false`, the install sends no
   anonymous update statistics.

## Upgrades

Always back up the database before upgrading, and run migrations before starting
the new version.

### Source checkout

```bash
yarn upgrade
```

`yarn upgrade` runs `git fetch && git pull && yarn install && yarn heroku-postbuild`.
`heroku-postbuild` is `yarn build && yarn db:migrate`, so the build and migration
happen together. Then restart the web and worker processes.

### Docker

```bash
git pull
docker build -f Dockerfile.base -t outline-base .
docker build --build-arg BASE_IMAGE=outline-base -t outline-ygpkb .
docker stop outline
docker run --rm --env-file .env outline-ygpkb npx sequelize db:migrate
docker rm outline
docker run -d --name outline --env-file .env -p 3000:3000 \
  -v outline-data:/var/lib/outline/data --restart unless-stopped outline-ygpkb
```

Migrations are forward-only via `db:migrate`. To undo the last migration use
`yarn db:rollback` (`sequelize db:migrate:undo`). Branch flow for the fork is
`main` → `development` → feature branches; deploy from a branch you have
validated, not from an unreviewed feature branch.

## Backup and restore

- PostgreSQL. Use `pg_dump` and `pg_restore`, or managed snapshots:

  ```bash
  pg_dump "$DATABASE_URL" --format=custom --file=outline-$(date +%F).dump
  pg_restore --clean --no-owner --dbname "$DATABASE_URL" outline-2026-01-01.dump
  ```

- File storage. For `FILE_STORAGE=local`, back up the volume mounted at
  `/var/lib/outline/data`. For `FILE_STORAGE=s3`, rely on bucket versioning or a
  bucket sync.
- `SECRET_KEY`. It encrypts database columns. Changing it after data exists
  breaks decryption of existing rows, and never reuse the development value in
  production. Store it in your secret manager and keep it with your backups.

## Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `Environment configuration is invalid` on `db:migrate` | `NODE_ENV` not set, so the env validator reads the wrong env file | Set `NODE_ENV` (`development` for the local flow, `production` for a real deployment) before running the migration. |
| `db:migrate` reports it cannot find a compiled migration | Source checkout whose migrations have not been compiled (older workflow) | Run `yarn build:server` first, then retry. The current tree ships plain `.js` migrations under `server/migrations`, which run without a build. |
| Container never becomes `healthy`, `/_health` fails | Server not booted yet, or `PORT` does not match the healthcheck port | Wait for boot and check `docker logs`. Ensure `PORT` equals the port the healthcheck probes (default 3000). |
| No sign-in options on the login screen | No authentication provider configured | Configure at least one provider (Slack, Google, Entra, Discord, OIDC, GitHub, or SMTP magic links). |
| Uploads fail with `FILE_STORAGE=s3` | Provider does not support presigned POST | Set `AWS_S3_UPLOAD_METHOD=put` (for example Cloudflare R2). |
| Collaboration never connects | `REDIS_URL` / `REDIS_COLLABORATION_URL` wrong, or split across domains without `COLLABORATION_URL` | Verify the Redis URLs and, if collaboration runs on its own domain, set `COLLABORATION_URL` (for example `wss://docs-collaboration.example.com`). |
| HTTPS redirect loop | `FORCE_HTTPS=true` behind a TLS-terminating proxy without trusted forwarded headers | Set `FORCE_HTTPS=false` and/or `PROXY_HEADERS_TRUSTED=true`. |
| Jobs never process | No worker process running | Run at least one process with the `worker` service (`--services=worker` or `--services=web,worker`). |
| Scheduled tasks never run | `cron` is not in the default service set | Add `cron` to a service list, for example `--services=worker,cron`. |
