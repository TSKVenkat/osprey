<img src="assets/logo.svg" alt="" width="72" height="72" />

# osprey — self-hosted screen recording with share links

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![CI](https://github.com/TSKVenkat/osprey/actions/workflows/ci.yml/badge.svg)](https://github.com/TSKVenkat/osprey/actions/workflows/ci.yml)

> Screen recording → instant share link → playback with comments and view analytics.
> Bring your own storage: S3/MinIO, Cloudinary, ImageKit, or local disk.
> **No AI features.** Not now, not later.

Your recordings live in storage you control, on a server you run. The share link is
live one to three seconds after you press stop, whether the recording was one minute
or forty, because parts upload while you are still recording.

An osprey watches, dives, and comes up holding what it went in for — which is
roughly what a screen recorder is for.

---

## Status

Built and running. Record in a browser, get a share link, watch it back — with
processing, crash recovery, and four interchangeable storage backends.

**318 unit and integration tests, 17 browser specs.** CI runs lint, typecheck, the
suite, a production build, and the browser tests against a real Postgres with real
Chrome. Cloudinary and ImageKit are verified against live accounts.

[**08 — As Built**](docs/08-as-built.md) is the honest record: what exists, what was
measured, and the ten or so places where reality disagreed with the design below.

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
| [07 — Build Order & Next Phase](docs/07-build-order-and-next-phase.md) | M0–M8 milestones, all done; the Phase 2 agenda |
| [08 — As Built](docs/08-as-built.md) | **What was actually built and measured**, and where it differs from the plan |
| [09 — Auth & Scopes](docs/09-auth-and-scopes.md) | How Windmill handles roles and scoped API tokens, and which parts of it are worth taking |

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
S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_BUCKET=osprey \
S3_TEST_ACCESS_KEY_ID=osprey S3_TEST_SECRET_ACCESS_KEY=osprey123 pnpm test
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

## Contributing

Bug reports, fixes and new storage backends are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
covers getting it running, what a change is expected to carry, and how to add a
storage backend so it passes the conformance suite.

Two things worth knowing before you open something:

- **No AI features.** Not transcription, not summaries, not chapters. Requests for
  them are closed politely and immediately. That is the point of the project, not
  an omission.
- **Security problems go through [SECURITY.md](SECURITY.md)**, never a public
  issue. Every instance is self-hosted, so a public report is a working attack on
  everyone who has not updated yet.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

[GNU Affero General Public License v3.0](LICENSE), and deliberately not MIT.

MIT would let a company take this, run it as a hosted service, improve it, and keep
those improvements to themselves. The AGPL closes that: section 13 extends copyleft
across the network, so anyone who offers a modified version *as a service* has to
offer its users the modified source. Running it inside your own company, modified
however you like, is entirely fine — the obligation is to the people you serve it
to, and only when you serve it to them.

This is the same reasoning Grafana, Mastodon, Nextcloud and Plausible followed, and
the practical effect is that improvements come back rather than becoming somebody
else's product.

Two consequences worth stating plainly:

- The interface links to its own source, on every page. That is the mechanism the
  licence itself suggests for satisfying section 13. If you run a modified copy,
  point `SOURCE_URL` in `apps/web/src/components/SourceLink.tsx` at your fork.
- Building a proprietary product on top of this means asking about a different
  licence, not reading this one creatively.

    osprey — self-hosted screen recording with share links
    Copyright (C) 2026 TSKVenkat and osprey contributors

    This program is free software: you can redistribute it and/or modify it under
    the terms of the GNU Affero General Public License as published by the Free
    Software Foundation, either version 3 of the License, or (at your option) any
    later version.

    This program is distributed in the hope that it will be useful, but WITHOUT ANY
    WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
    PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License along
    with this program. If not, see <https://www.gnu.org/licenses/>.
