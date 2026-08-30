# openloom — an open-source async video messaging tool

> Screen recording → instant share link → playback with comments and view analytics.
> Bring your own storage: Cloudinary, ImageKit, Google Drive, S3/MinIO, or local disk.
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
| Storage | S3/MinIO (reference), Cloudinary, ImageKit, Google Drive, local FS |
| AI | None |

## Running it

Requires Node 24, pnpm 10, and Docker.

```bash
pnpm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # paste into SECRET_KEY

pnpm up            # postgres + minio
pnpm db:migrate    # apply migrations
pnpm dev:api       # http://localhost:3000/health
```

Checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

The S3 conformance tests skip themselves unless a bucket is reachable. To run them
against the MinIO from `pnpm up`:

```bash
S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_BUCKET=openloom \
S3_TEST_ACCESS_KEY_ID=openloom S3_TEST_SECRET_ACCESS_KEY=openloom123 pnpm test
```

## Layout

```
apps/api          Fastify HTTP API
packages/db       Drizzle schema, migrations, database client
packages/storage  StorageConnector interface, backends, conformance suite
packages/recorder Client-side capture core: coalescer, scheduler, retry, spill, state machine
deploy/           docker compose (postgres, minio)
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

GET    /files/:storageId/*                    signed reads for the local backend
```

No Redis, no Kafka, no cloud dependency.
