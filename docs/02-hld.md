# 02 — High-Level Design

> Components, boundaries, and the three flows that matter. **Single-tenant**: one instance, one
> team. Baseline scale target: **~200 users, ~50 concurrent recordings**. Scaling is Phase 3.

---

## 1. Component map

```
┌──────────────────────────────────────────── BROWSER ─────────────────────────────────────────────┐
│                                                                                                  │
│   ┌─────────────────┐    MediaStream    ┌──────────────┐   Blob/3s   ┌────────────────────────┐  │
│   │  CaptureSource  │ ────────────────► │ MediaRecorder│ ──────────► │     ChunkCoalescer     │  │
│   │ getDisplayMedia │                   └──────────────┘             │   (→ 8 MiB parts)      │  │
│   │ + getUserMedia  │                                                └───────────┬────────────┘  │
│   └─────────────────┘                                                            │               │
│                                       ┌──────────────────┐                       ▼               │
│                                       │  SpillLog (OPFS  │◄────── durable write ─────┐           │
│                                       │  + IndexedDB)    │                           │           │
│                                       └──────────────────┘                  ┌────────┴────────┐  │
│                                                                             │ UploadScheduler │  │
│   ┌─────────────────┐                                                       │  pool of 4      │  │
│   │  Viewer (React) │                                                       └────────┬────────┘  │
│   └────────┬────────┘                                                                │           │
└────────────┼─────────────────────────────────────────────────────────────────────────┼───────────┘
             │ share page / playback                        control-plane calls │      │ part bytes
             │                                                                  │      │ (direct, when
             ▼                                                                  ▼      │  capable)
       ┌───────────┐                                              ┌──────────────────┐ │
       │    CDN    │◄─────────── signed, TTL-bucketed URLs ───────►│   API (Fastify)  │ │
       └─────┬─────┘                                              │  ┌────────────┐  │ │
             │                                                    │  │ Recordings │  │ │
             │                                                    │  │ Uploads    │  │ │
             │                                                    │  │ Sharing    │  │ │
             │                                                    │  │ Connectors │  │ │
             │                                                    │  └─────┬──────┘  │ │
             │                                                    └────────┼─────────┘ │
             │                                                             │           │
             │                     ┌───────────────────────────────────────┴────┐      │
             │                     │        StorageConnector interface          │◄─────┘
             │                     ├────────┬──────────┬─────────┬──────┬───────┤   (proxied, when
             │                     │ S3/    │Cloudinary│ImageKit │ Local │        not capable)
             │                     │ MinIO  │          │         │      │       │
             │                     └────┬───┴────┬─────┴────┬────┴───┬──┴───┬───┘
             └──────────── object bytes ─┴────────┴──────────┴────────┴──────┘
                                                       ▲
       ┌──────────────┐   pg-boss    ┌─────────────────┴────┐        ┌──────────────┐
       │  PostgreSQL  │◄────────────►│  Worker (Node)       │        │   ffmpeg     │
       │  (+ job q)   │              │  assemble │ normalize│───────►│  (subprocess)│
       └──────────────┘              │  thumbnail│ sweep    │        └──────────────┘
                                     └──────────────────────┘
```

**Five deployable units** (`docker compose`): `web` (static), `api`, `worker`, `postgres`, `minio`.
Plus `caddy` for TLS/routing in the self-host profile. No Redis, no Kafka, no S3 requirement — the
baseline is intentionally a four-container system.

---

## 2. Trust boundaries

| Boundary | Rule |
|---|---|
| Browser → API | Session cookie (httpOnly, SameSite=Lax, Secure). Every request resolves to `(userId, role)` or anonymous |
| Browser → Provider | **Only** via short-lived signed targets minted by the API, scoped to one object key and one part number. The browser never sees provider credentials |
| API → Provider | Storage credentials, envelope-encrypted at rest, decrypted in memory per request, never logged, never returned by any endpoint — not even to an admin |
| Worker → Provider | Same credential path; workers are the only component that reads whole objects |
| Public → CDN | Share tokens are opaque, high-entropy, hashed at rest. A signed URL leak is bounded by its TTL |

---

## 3. Flow A — Record and upload (the critical path)

```
  Browser                          API                     Storage Provider          Worker
     │                              │                             │                    │
     │ 1. POST /recordings          │                             │                    │
     │    {title, mime}             │                             │                    │
     │─────────────────────────────►│ insert recording(draft)     │                    │
     │                              │ resolve default storage     │                    │
     │                              │ connector.createUpload() ──►│ CreateMultipart    │
     │◄─────────────────────────────│ {recordingId, sessionId,    │◄───{uploadId}      │
     │   {ids, capabilities}        │  capabilities}              │                    │
     │                              │                             │                    │
     │ 2. ── recording starts; MediaRecorder emits every 3 s ──   │                    │
     │    ChunkCoalescer → 8 MiB part → SpillLog(OPFS) → queue    │                    │
     │                              │                             │                    │
     │ 3. POST /uploads/:id/parts/:n/target      (per part,       │                    │
     │─────────────────────────────►│           signed on demand) │                    │
     │◄──── {url, headers, expiry} ─│ presign PUT part n          │                    │
     │                              │                             │                    │
     │ 4. PUT part bytes ───────────────────────────────────────► │ (direct)           │
     │◄──────────────────────────── 200 {ETag} ───────────────────│                    │
     │                              │                             │                    │
     │ 5. POST /uploads/:id/parts/:n/ack {etag, sha256, bytes}    │                    │
     │─────────────────────────────►│ upsert upload_part (idempotent)                  │
     │                              │                             │                    │
     │    ── delete OPFS part file only after this 2xx ──         │                    │
     │                              │                             │                    │
     │ 6. POST /uploads/:id/complete  (on Stop, after last part)  │                    │
     │─────────────────────────────►│ verify parts 1..n dense     │                    │
     │                              │ connector.completeUpload() ►│ CompleteMultipart  │
     │                              │ recording → 'processing'    │                    │
     │                              │ pg-boss.send('process') ────────────────────────►│
     │◄──── 200 {shareUrl} ─────────│   ◄── SHARE LINK IS LIVE HERE ──                 │
     │                              │                             │                    │
     │                              │           7. probe → remux → faststart → thumb   │
     │                              │◄─────────── recording → 'ready' ─────────────────│
```

**The critical property:** the share link is returned at step 6, before processing. The viewer page
handles a `processing` recording by playing the original object (already complete and playable, if
imperfectly seekable) and hot-swapping to the normalized rendition when it appears. Time-to-link is
therefore `last part upload + CompleteMultipart` ≈ **1–3 s**, independent of recording length.

**When the connector cannot do direct upload** (local disk, and the staged providers), step 3 returns
a *proxy* target — an API endpoint — and step 4 streams through the API to the provider. Same
client code path; the difference is one capability flag.

---

## 4. Flow B — Playback

```
  Viewer            API                        Storage / CDN
    │                │                              │
    │ GET /s/:token  │                              │
    │───────────────►│ hash token → share_link      │
    │                │ authz: public | password |    │
    │                │        signed-in user         │
    │                │ pick rendition by capability: │
    │                │   adaptiveStreaming? → HLS URL│
    │                │   else              → MP4 URL │
    │                │ sign with TTL bucketing       │
    │◄───────────────│ {meta, playbackUrl, poster}   │
    │                │                              │
    │ GET playbackUrl (Range: bytes=0-) ───────────►│ CDN hit (immutable key)
    │◄──────────────────────────────────────────────│
    │                │                              │
    │ POST /views (batched, idempotency-keyed) ────►│
```

Rendition selection is a pure function of `(connectorCapabilities, availableAssets, clientHints)` —
one function, unit-testable, no branching scattered through the UI.

---

## 5. Flow C — Processing (worker)

`pg-boss` job `recording.process` → a `Processor` chain. Each stage is independently retryable and
writes its own asset row:

| Stage | Input | Action | Output asset |
|---|---|---|---|
| `probe` | original | `ffprobe` → duration, codecs, dimensions, `moov` position | metadata on `recording` |
| `normalize` | original | if already H.264/AAC MP4 with faststart → **skip**; else `ffmpeg -c copy -movflags +faststart` (remux, no re-encode) or transcode if codecs are incompatible | `mp4_source` |
| `thumbnail` | normalized | frame at `min(3s, duration/2)` → WebP + JPEG poster | `poster` |
| `sprite` *(optional)* | normalized | scrubbing sprite sheet + WebVTT | `sprite` |
| `hls` *(later)* | normalized | ABR ladder → fMP4 segments + manifests | `hls_manifest` |

**The important optimization is the skip:** a Safari MP4 that is already H.264/AAC needs only a
faststart remux (seconds, no re-encode). A Chrome VP9/Opus WebM needs a real transcode. Detect and
branch — do not transcode unconditionally.

For connectors with `serverSideTranscode` (Cloudinary) or on-the-fly adaptive URLs (ImageKit), the
`normalize` and `hls` stages are **delegated**: the connector produces renditions and the worker
only records the resulting asset URLs. Same chain, different executor.

---

## 6. Ownership, roles, and storage

**Single-tenant.** One instance serves one team. A recording is owned by the user who made it;
there is no workspace or organisation layer.

### Roles — two, least privilege by default

| | `user` | `admin` |
|---|:--:|:--:|
| Record, upload, manage **own** recordings | ✅ | ✅ |
| Share own recordings | ✅ | ✅ |
| Read or delete **any** recording | ❌ | ✅ |
| Create and disable users | ❌ | ✅ |
| Configure storage | ❌ | ✅ |
| Read storage credentials | ❌ | ❌ |

New accounts are `user`. Open sign-up is off by default; an admin invites people. Ownership checks
live in one helper (`requireOwnerOrAdmin`) rather than being repeated in every handler — one place
to read, one place to get right.

### Auth

Email and password, `bcrypt` at cost 12. A login inserts a `sessions` row and sets an httpOnly
cookie holding a 256-bit token; the row stores only `sha256(token)`. A `preHandler` resolves the
cookie to `req.user` once, and handlers never touch cookies.

A session row (rather than a JWT) is deliberate: logout has to actually log out, and disabling a
user has to take effect on their next request. Deleting a row does that; revoking a signed token
requires building the very table we would have skipped.

### Object key layout

```
r/{recordingId}/original.{ext}
r/{recordingId}/mp4/{sha256[:16]}.mp4
r/{recordingId}/poster/{sha256[:16]}.webp
r/{recordingId}/hls/{sha256[:16]}/master.m3u8
```

The content-addressed leaf makes every rendition URL immutable → `Cache-Control: public,
max-age=31536000, immutable` → the CDN serves it forever and reprocessing never needs a purge.

### Storage configuration

An admin configures the instance's storage backend once — MinIO out of the box, or S3, Cloudinary,
or ImageKit. Recordings pin `storage_config_id` at creation, so changing the default never
orphans anything already stored.

## 7. Deployment (baseline)

```yaml
# conceptual — the real file lives at deploy/docker-compose.yml
services:
  caddy:     # TLS, routes / → web, /api → api
  web:       # static React build
  api:       # Fastify, stateless, N replicas
  worker:    # pg-boss consumer + ffmpeg; CPU-bound, scale separately
  postgres:  # data + job queue
  minio:     # default storage connector for self-host
```

`api` is stateless → horizontal scaling is trivial. `worker` is the CPU-bound tier and scales
independently — that separation is why `normalize` must never run inside a request handler.

---

## 8. What this HLD explicitly defers

| Deferred | Why it's safe to defer | Where the seam is |
|---|---|---|
| Redis / BullMQ | pg-boss handles baseline volume; transactional enqueue is worth more than throughput here | Job interface in `packages/jobs` |
| HLS ladder | Progressive MP4 covers the baseline viewer | `Processor` chain + `DeliveryStrategy` |
| Read replicas | Single Postgres is fine at target scale | Repository layer |
| Search | List + filter suffices at baseline volume | — |
| Desktop app | Browser covers the baseline | `CaptureSource` |
