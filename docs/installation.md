# Installing osprey

Everything runs in containers. The only thing you need on the machine is Docker.

## Quick start

```bash
git clone https://github.com/TSKVenkat/osprey.git
cd osprey
cp .env.example .env
```

Open `.env` and set three things:

```bash
# 32 bytes, base64. This encrypts storage credentials at rest.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| Setting | What to put |
|---|---|
| `SECRET_KEY` | The value printed above. There is no default, on purpose. |
| `ADMIN_EMAIL` | Your email. Used once, to create the first account. |
| `ADMIN_PASSWORD` | At least ten characters. Used once. |

Then:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

That is the whole instance on <http://localhost:8080> — web, API, worker, Postgres
and MinIO. Sign in with the address and password you just set, open **Settings**,
add a storage backend, and record.

```bash
# follow the API and worker
docker compose --env-file .env -f deploy/docker-compose.yml logs -f api worker

# stop, keeping recordings
docker compose --env-file .env -f deploy/docker-compose.yml down

# stop, deleting recordings and accounts
docker compose --env-file .env -f deploy/docker-compose.yml down -v
```

## Before putting it on a network

The compose file ships credentials so that the quick start works with nothing to
fill in first. They are not secrets and they are not meant to leave your machine.

- **Change the Postgres password** (`openloom`/`openloom` by default in the compose
  file) and the MinIO credentials, or drop MinIO entirely and point at real storage.
- **Set a real `SECRET_KEY`.** Changing it later makes every stored storage
  credential unreadable, so set it once, before you configure anything.
- **Put it behind TLS.** Session cookies and recordings both travel over it.
- **Set `PUBLIC_API_URL` and `WEB_ORIGIN`** to the address browsers actually use.
  See [configuration](configuration.md) — this is the setting most likely to produce
  recordings that upload fine and then refuse to play.

## Ports

The published ports are configurable, because a fixed port means the stack refuses
to start next to anything else already using Postgres:

```bash
WEB_PORT=8080            # the instance
POSTGRES_PORT=5432       # only so you can reach the database with psql
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001
```

Nothing inside the stack uses these; the containers talk to each other over the
compose network regardless.

## Running from source

For development, run the backing services in containers and the applications
directly. You need Node 24 or newer, pnpm 10, and ffmpeg on your PATH for the
worker.

```bash
pnpm install
pnpm run stack:deps      # postgres and minio only
pnpm db:migrate

pnpm dev:api             # http://localhost:3000
pnpm dev:web             # http://localhost:5173
pnpm dev:worker
```

The web app proxies `/v1` to the API so the session cookie stays same-origin, which
avoids fighting SameSite rules locally.

## Upgrading

```bash
git pull
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

Migrations run in their own container before the API starts, so nothing queries a
schema that is not there yet. Recordings and accounts live in named volumes and
survive a rebuild.
