# openloom — an open-source async video messaging tool

> Screen recording → instant share link → playback with comments and view analytics.
> Bring your own storage: S3/MinIO, Cloudinary, ImageKit, or local disk.
> **No AI features.** Not now, not later.

⚠️ `openloom` is a working directory name. "Loom" is a trademark — **rename before any public
release.**

---

## Status: Phase 1 — design baseline

No application code yet. This repository currently holds the study and the baseline design, which
is deliberate: the hard parts of this system (chunked resumable upload, container normalization,
five heterogeneous storage backends) are cheap to get right on paper and expensive to retrofit.

## Read in order

| Doc | What it answers |
|---|---|
| [00 — Systems Study](docs/00-systems-study.md) | How this class of system actually works; the physics; browser capability reality; 14 failure modes |
| [01 — Baseline](docs/01-baseline.md) | Root decisions: containers, codecs, protocols, libraries, and the seven data structures that carry the design |
| [02 — HLD](docs/02-hld.md) | Components, trust boundaries, the three flows, multi-tenancy, deployment |
| [03 — LLD](docs/03-lld.md) | `StorageConnector` interface, state machines, six algorithms, API surface |
| [04 — Data Model](docs/04-data-model.md) | Postgres schema, roles and permissions, indexes with justification, migration order |
| [05 — Connectors](docs/05-connectors.md) | Capability matrix and per-provider reality; the conformance suite |
| [06 — Testing & Optimization](docs/06-testing-and-optimization.md) | Test pyramid, property tests, E2E with real capture; the four metrics |
| [07 — Build Order & Next Phase](docs/07-build-order-and-next-phase.md) | M0–M8 milestones; the Phase 2 agenda |

## The one-paragraph architecture

The browser captures with `getDisplayMedia` + `MediaRecorder`, emitting a chunk every 3 s. A
coalescer accumulates chunks into 8 MiB parts, spills them to OPFS for crash safety, and a bounded
pool of 4 workers uploads them **while recording continues** — so pressing *Stop* only has to flush
the tail, and the share link is live in 1–3 seconds regardless of recording length. Parts go
directly to the storage provider via short-lived signed targets (or through an API proxy for
providers that cannot do CORS uploads). The server commits the multipart upload, returns the link
immediately, and enqueues a worker job that probes the file and either skips, remuxes, or transcodes
it to a faststart H.264/AAC MP4 with a poster frame. Playback is a progressive MP4 over HTTP Range
from an immutable, CDN-cacheable key — with adaptive streaming delegated to connectors that provide
it. Five storage backends sit behind one `StorageConnector` interface whose declared capabilities
are verified against measured behaviour by a shared conformance suite.

## Core decisions

| Axis | Choice |
|---|---|
| Tenancy | **Single-tenant.** One instance = one team. Users own recordings; an admin configures storage once |
| Client | Browser first; desktop (Tauri) behind the `CaptureSource` seam |
| Auth | Email + password (bcrypt), session cookie backed by a `sessions` row. Two roles: `admin`, `user` |
| Stack | TypeScript end-to-end — Fastify 5, Drizzle, Postgres 17, pg-boss, React 19 |
| Pipeline | Passthrough now; normalization and HLS as pluggable `Processor` stages |
| Storage | S3/MinIO (reference), Cloudinary, ImageKit, local disk |
| AI | None |

## Running it

Requires Docker. Everything else runs in containers.

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # paste into SECRET_KEY

pnpm run stack        # postgres, minio, migrations, api, worker, web
```

Open http://localhost:8080, sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, add a
storage directory under Settings, and record. `pnpm run stack:logs` follows the API
and worker; `pnpm run stack:down` stops everything.

`PUBLIC_API_URL` is the one setting worth reading twice: it is how a **browser**
reaches the instance, and playback URLs are built from it. Compose overrides it to
its own address, because a value left over from running the apps from source points
at a port nothing publishes there.

### From source

For development, run the backing services in containers and the apps directly:

```bash
pnpm install
pnpm run stack:deps   # postgres + minio only
pnpm db:migrate

pnpm dev:api          # http://localhost:3000
pnpm dev:web          # http://localhost:5173
pnpm dev:worker       # needs ffmpeg on PATH
```

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
```

End-to-end, in a real Chrome, against a running instance. Chrome is started with a
synthetic screen and microphone, so nothing has to be clicked:

```bash
pnpm test:e2e                                   # against pnpm dev:web
E2E_WEB_URL=http://localhost:8080 pnpm test:e2e # against the containers
```

The S3 conformance tests skip themselves unless a bucket is reachable. To run them
against the MinIO from `pnpm run stack:deps`:

```bash
S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_BUCKET=openloom \
S3_TEST_ACCESS_KEY_ID=openloom S3_TEST_SECRET_ACCESS_KEY=openloom123 pnpm test
```

Cloudinary and ImageKit have the same arrangement — see `.env.example`.

## Layout

```
apps/api          Fastify HTTP API
apps/web          React client: record, library, playback, settings
apps/worker       Normalises recordings with ffmpeg, and sweeps up after them
packages/db       Drizzle schema, migrations, database client
packages/storage  StorageConnector interface, backends, conformance suite
packages/recorder Client-side capture core: coalescer, scheduler, retry, spill, state machine
packages/processing ffprobe, the encode plan, and ffmpeg argument builders
packages/jobs     Job names and queue setup, shared by the API and the worker
e2e/              Playwright: record, upload and play back in a real browser
deploy/           docker compose and the web container's Caddyfile
docs/             the design baseline
```

## API so far

```
POST   /v1/auth/login  /logout  /password        GET /v1/auth/me
GET    /v1/admin/users            POST /v1/admin/users
PATCH  /v1/admin/users/:id        POST /v1/admin/users/:id/reset-password
GET    /v1/admin/storage          POST /v1/admin/storage
POST   /v1/admin/storage/:id/test        /v1/admin/storage/:id/default
DELETE /v1/admin/storage/:id

GET    /v1/recordings                         list your recordings (admins: ?all=1)
GET    /v1/recordings/:id                     detail, assets and a playable URL
PATCH  /v1/recordings/:id                     rename
DELETE /v1/recordings/:id                     soft delete
POST   /v1/recordings                         start a recording and its upload
POST   /v1/uploads/:id/parts/:n/target        where to send one part
PUT    /v1/uploads/:id/parts/:n               send one part through the API
POST   /v1/uploads/:id/parts/:n/ack           confirm a part sent directly
POST   /v1/uploads/:id/complete  /abort
GET    /v1/uploads/:id                        what has landed, for crash recovery

POST   /v1/recordings/:id/shares              create a share link
GET    /v1/recordings/:id/shares              list links (shows the URL again)
DELETE /v1/shares/:id                         revoke
GET    /v1/recordings/:id/views               view counts, for the owner

GET    /v1/shares/:token                      public: open a shared recording
POST   /v1/shares/:token/unlock               public: password-protected links
POST   /v1/shares/:token/views                public: watch progress

GET    /files/:storageId/*                    signed reads for the local backend
```

No Redis, no Kafka, no cloud dependency.
