# 01 — Baseline: Root Decisions, Libraries, Data Structures

> Phase 1. The floor everything else stands on. Read [00-systems-study.md](00-systems-study.md) first.
> Every entry is **decision + why + what would change it**.

---

## 0. Locked-in product decisions

| Axis | Decision | Consequence |
|---|---|---|
| Deployment shape | **Single-tenant self-host** | One instance = one team. No workspace/organisation layer. Recordings are owned by users; storage is configured once by an admin |
| Client | **Browser first, desktop (Tauri) as a later connector** | Capture is an interface (`CaptureSource`), not inline code. Baseline has exactly one implementation |
| Stack | **TypeScript end-to-end** (Node/Fastify + React) | Shared types across client/server/connectors. CPU-bound media work shells out to `ffmpeg` |
| Pipeline | **Passthrough now, transcode as a pluggable stage** | Store what was recorded; a `Processor` chain normalizes it. HLS drops in later without touching transfer/storage |
| AI | **None** | No transcription, summarization, chapters, or translation. Ever, in this codebase |

---

## Layer 0 — Physics: formats, codecs, protocols

These are not library choices; they are the substrate. Get them wrong and no amount of good code helps.

### Containers

| Container | Role in this system |
|---|---|
| **WebM (Matroska)** | What Chrome/Firefox `MediaRecorder` produces. Streaming-friendly, **unknown duration, no seek index** |
| **MP4 (ISOBMFF)** | What Safari produces and what we normalize *to*. Universal playback. Needs `moov` at the front (`faststart`) |
| **fMP4 / CMAF** | Fragmented MP4. The segment format for HLS **and** the format WebCodecs pipelines emit. The bridge between today's baseline and tomorrow's adaptive streaming |

**Decision:** canonical stored format is **progressive MP4, H.264 + AAC, faststart**. It is the only
combination that plays everywhere with no JS. Originals are retained as uploaded.

### Codecs

| Codec | Use |
|---|---|
| **H.264 (avc1)** | Canonical delivery. Universal hardware decode. Patent-encumbered but ubiquitous |
| **VP9** | Common recording output in Chromium. Good screen-content efficiency. Kept as-is on ingest |
| **AV1** | ~30% better than H.264, encode is slow. Future second rendition, not baseline |
| **Opus / AAC** | Opus on ingest (WebM), AAC in the canonical MP4 |

### Protocols

| Protocol | Use |
|---|---|
| **HTTP Range (RFC 9110)** | Progressive playback + seeking. The baseline delivery mechanism |
| **S3 Multipart Upload** | The baseline transfer mechanism. Min part **5 MiB**, max **10 000** parts, last part exempt |
| **Google resumable upload** | Drive connector. `Content-Range`, chunks in multiples of **256 KiB** |
| **HLS (RFC 8216)** | Later adaptive delivery. `hls.js` for non-Safari |
| **tus 1.0** | *Not baseline.* Kept as a documented alternative for the proxied-upload path |

### The arithmetic that sets the constants

```
S3 min part size          = 5 MiB
S3 max parts              = 10 000
=> max object via 5 MiB parts = ~48 GiB   (far above any recording)

Target part size          = 8 MiB   (headroom above the 5 MiB floor, ~3 s of 1080p at 2.5 Mbps
                                     is only ~1 MB, so ~8 timeslices coalesce into one part)
MediaRecorder timeslice   = 3 000 ms  (small enough for responsive spill, large enough to
                                       keep the callback rate trivial)
Upload concurrency        = 4        (saturates typical uplinks without head-of-line blocking)
```

**Therefore: a timeslice chunk is NOT a part.** Chunks must be coalesced up to the 5 MiB floor.
This one fact drives the central client data structure (§Layer 2).

---

## Layer 1 — Libraries

Chosen for: maintained in 2026, TypeScript-native, no lock-in at the seams, testable offline.

### Runtime & tooling

| Concern | Choice | Why | Would change if |
|---|---|---|---|
| Runtime | **Node 24 LTS** | Native `fetch`, stable streams, best SDK coverage | Bun's ecosystem parity for AWS SDK closes |
| Language | **TypeScript 5.x**, `strict`, `noUncheckedIndexedAccess` | Off-by-one part indexing is a real risk here | — |
| Monorepo | **pnpm workspaces + Turborepo** | Shared `packages/contracts` types between web/api/connectors | — |
| Bundler | **Vite** (web), `tsup` (packages) | — | — |

### API tier

| Concern | Choice | Why | Rejected |
|---|---|---|---|
| HTTP | **Fastify 5** | Fastest mature Node server; schema-first; first-class plugin encapsulation | Express (no schema/typing story), NestJS (DI overhead for this size) |
| Validation | **Zod** + `fastify-type-provider-zod` | One schema → runtime validation + TS types + OpenAPI | — |
| DB client | **Postgres 17** + **Drizzle ORM** + `drizzle-kit` | SQL-shaped, no query-engine binary, migrations are plain SQL, excellent TS inference | Prisma (binary engine, weaker raw-SQL ergonomics for partitioned analytics tables) |
| Jobs | **pg-boss** | No Redis. **Transactional enqueue**: insert the recording row *and* its processing job in one Drizzle transaction — impossible with Redis-backed queues | BullMQ — better feature set, adopt when Redis exists anyway (see 07-scaling) |
| Auth | **hand-rolled: `bcrypt` + a sessions table** | Email and password, session row keyed by a hashed cookie. Two roles (`admin`, `user`). About 150 lines total — an auth framework here would be more code to understand, not less | better-auth / Auth.js (built for OAuth, orgs, and multi-tenancy we do not have) |
| Logging | **pino** (+ `pino-pretty` in dev) | Structured, fast, Fastify-native | — |
| Tracing | **OpenTelemetry** SDK, OTLP export | Upload/processing spans are where debugging happens | — |
| Config | **Zod-parsed `process.env`**, single `env.ts` | Fail fast at boot, not at first request | dotenv sprawl |

### Storage connectors

| Connector | Library | Note |
|---|---|---|
| S3 / MinIO / R2 / B2 | **`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`** | One implementation covers all S3-compatible backends. MinIO needs `forcePathStyle: true` |
| Cloudinary | **`cloudinary`** (official Node SDK) | `upload_large` for chunking; signed direct upload; eager transforms for renditions |
| ImageKit | **`@imagekit/nodejs`** | Adaptive streaming is a **URL parameter**, generated on first request — no pipeline needed |
| Google Drive | **`googleapis`** (`drive_v3`) | Resumable sessions; 256 KiB chunk multiples; OAuth refresh-token storage required |
| Local filesystem | none (`node:fs/promises`) | Reference implementation + the conformance-test oracle |

### Media handling

| Concern | Choice | Why |
|---|---|---|
| Server transcode/remux | **`ffmpeg` via `node:child_process.spawn`** with explicit argv | `fluent-ffmpeg` is effectively unmaintained and hides the args you must audit. Explicit argv is testable and greppable |
| Server probe | **`ffprobe -v quiet -print_format json -show_format -show_streams`** | Duration, codecs, dimensions, `moov` position — also the assertion tool in tests |
| Client remux / metadata / thumbnails | **`mediabunny`** | Pure-TS, zero-dep, tree-shakes to ~5 kB. Successor to `mp4-muxer`/`webm-muxer`; adopted by Remotion. Fixes WebM duration client-side and is the muxer for the future WebCodecs path |
| Player (progressive) | native `<video>` | Baseline is one MP4 + Range. No library needed |
| Player (adaptive, later) | **`hls.js`** | Most-installed player shim on the web; Safari uses native HLS |
| Player chrome | **Vidstack** *(watch Video.js v10)* | Video.js v10 is consolidating Plyr/Vidstack/Media Chrome — re-evaluate before committing UI work |

### Web client

| Concern | Choice | Why |
|---|---|---|
| Framework | **React 19 + Vite** | — |
| Routing/data | **TanStack Router + TanStack Query** | Typed routes; Query gives caching/retry/invalidation for free |
| Recorder state | **a plain reducer over a union type** | The recorder has 8 states and explicit transitions. A `switch` over a discriminated union is exhaustively typechecked and readable by anyone; a state-chart library is a dependency and a dialect to learn |
| Other client state | **Zustand** | Small, no context tax |
| Persistence | **OPFS** (`navigator.storage.getDirectory()`) + **IndexedDB** | OPFS for chunk bytes (fast, synchronous access handles in a worker); IndexedDB for the small manifest record |
| Styling | **Tailwind v4** | — |

### Testing & ops

| Concern | Choice | Why |
|---|---|---|
| Unit/integration | **Vitest** | Same config for browser and node packages; fake timers for backoff tests |
| HTTP tests | `fastify.inject()` | No socket, no port juggling |
| Real dependencies | **Testcontainers** (Postgres + MinIO) | The connector conformance suite must run against a real S3 API |
| External APIs | **MSW** + recorded fixtures | Cloudinary/ImageKit/Drive without credentials in CI |
| E2E | **Playwright** with `--use-fake-device-for-media-stream`, `--auto-select-desktop-capture-source` | Real capture→upload→playback in headless Chromium |
| Load | **k6** | API tier; upload path with synthetic parts |
| Containers | **Docker Compose** (web, api, worker, postgres, minio, caddy) | The self-host story is a first-class deliverable |

---

## Layer 2 — Data structures

The parts worth designing on paper. Each is small, testable in isolation, and has a clear invariant.

### 2.1 `ChunkCoalescer` — timeslice chunks → upload parts

**Problem:** `MediaRecorder` emits ~1 MB every 3 s; S3 demands ≥5 MiB per part (except the last).

```
Structure:  { buf: Blob[], bytes: number, partNo: number }
Invariant:  bytes === sum(b.size for b in buf)
push(blob):
    buf.push(blob); bytes += blob.size
    if bytes >= PART_SIZE (8 MiB):  emit Part{no: partNo++, blob: new Blob(buf)}; buf=[]; bytes=0
flush():                            # called once, on stop
    if bytes > 0: emit Part{no: partNo++, blob: new Blob(buf), last: true}
```

Blob concatenation is by reference — no byte copy, and the data stays off the JS heap.
**Invariant to test:** for any input chunk sequence, concatenating all emitted parts in `no` order
reproduces the input byte stream exactly, and every part except the last is ≥ 5 MiB.

### 2.2 `SpillLog` — the crash-recovery journal (OPFS + IndexedDB)

F1 (tab crash) is only survivable if bytes and intent are on disk before they are acknowledged.

```
OPFS:       /recordings/{recordingId}/part-{000123}.bin      # append-only, one file per part
IndexedDB:  manifest {
              recordingId, uploadSessionId, connectorKind,
              nextPartNo, parts: [{no, bytes, sha256, state, etag?}],
              mimeType, startedAt, state: 'recording'|'uploading'|'done'
            }
```

Write order (the durability rule): **bytes to OPFS → manifest update → enqueue upload → on 2xx mark
`uploaded` → delete OPFS file.** Never delete local bytes before the remote acknowledges.
On boot, any manifest not in `done` is a recovery candidate.

### 2.3 `PartTable` — the completion structure

```
Map<partNo:number, { state, etag?, bytes, attempts, sha256 }>
```

Ordered iteration at commit time. S3 `CompleteMultipartUpload` requires parts **ascending with all
ETags present**; a missing entry must fail loudly, never silently skip.
**Invariant:** at commit, keys are exactly `1..n` with no gaps.

### 2.4 `UploadScheduler` — bounded worker pool with backpressure

```
inFlight: Set<partNo>         # |inFlight| <= CONCURRENCY (4)
ready:    MinHeap<partNo>     # lowest part number first — earliest bytes land first,
                              # which is what makes progressive playback possible later
retry:    MinHeap<{at: epochMs, partNo}>   # time-ordered retry queue
```

Ordering by part number rather than FIFO is deliberate: it keeps the uploaded prefix contiguous, so
the server can begin assembly (and, in a future segmented world, publish playable prefix) early.

### 2.5 `Backoff` — exponential with full jitter

```
delay(attempt) = random_uniform(0, min(CAP, BASE * 2^attempt))
BASE = 500 ms, CAP = 30 s, MAX_ATTEMPTS = 8, TOTAL_BUDGET = 10 min
```

Full jitter (not "equal jitter", not fixed backoff) — it is what prevents retry storms when a
provider blips and 500 clients retry in lockstep. Pure function of `(attempt, rng)` → trivially
unit-testable with a seeded RNG.

### 2.6 `RateEstimator` — EWMA over completed parts

```
ewma_bps = α * (bytes / elapsed_s) + (1-α) * ewma_bps      α = 0.3
```

Feeds two decisions: adaptive part size (grow to 16 MiB on fast links, shrink to 5 MiB on slow
ones — fewer round trips vs. smaller loss on retry) and an honest ETA in the UI.

### 2.7 `ConnectorCapabilities` — a flat capability record

```ts
{
  directUpload: boolean       // browser may talk to the provider directly
  multipart: boolean          // parallel, out-of-order parts
  resumable: boolean          // sequential byte-offset resume
  signedRead: boolean
  rangeRequests: boolean      // seeking works without downloading everything
  serverSideTranscode: boolean
  adaptiveStreaming: boolean
  minPartBytes: number; maxPartBytes: number; maxObjectBytes: number
  partAlignmentBytes?: number // Drive: 262144
}
```

This is the single most important structure in the codebase: it is what lets the *same* upload
client and the *same* player drive five very different providers, and what makes the capability
asymmetries (§00-5) explicit instead of emergent.

### 2.8 Server-side: idempotency and signed-URL caching

- **Part idempotency:** unique index on `(upload_session_id, part_number)`; a repeated `PUT` with a
  matching `sha256` returns `200` with the stored ETag rather than erroring. F4 handled by the
  schema, not by application branching.
- **Signed-URL TTL bucketing:** cache key `(objectKey, floor(now / TTL))`. Every request inside a
  bucket window gets a *byte-identical* URL, so the CDN can actually cache the response. Re-signing
  per request makes every URL unique and drops your CDN hit rate to zero (F10).

---

## Layer 3 — The four seams

Places where the baseline is deliberately abstract, because we know what replaces it:

| Seam | Baseline implementation | Planned replacement |
|---|---|---|
| `CaptureSource` | `getDisplayMedia` + `MediaRecorder` | Tauri native capture; WebCodecs encoder |
| `StorageConnector` | S3/MinIO, local FS | Cloudinary, ImageKit, Drive (all in baseline scope) |
| `Processor` | remux → faststart → thumbnail | HLS ladder, AV1 rendition, trim |
| `DeliveryStrategy` | progressive MP4 + Range | HLS manifest, connector-native adaptive URL |

An abstraction with one implementation is speculation. Each of these has ≥2 known implementations,
which is what justifies it.

---

## Definition of "baseline done"

- [ ] Record screen + mic in Chrome, Firefox, Safari; correct mimeType negotiated per browser
- [ ] Bytes are uploading **while** recording; time-to-link < 3 s for a 10-minute recording
- [ ] Kill the tab at 60 % — reopening offers recovery and completes the upload
- [ ] Same recording flow succeeds against **all five** connectors (conformance suite green)
- [ ] Stored MP4 has correct duration, `moov` at the front, and seeks instantly
- [ ] Share link works logged-out; private link 404s for a non-member
- [ ] `docker compose up` yields a working instance with MinIO, seeded, in < 2 min
- [ ] Abandoned uploads are swept within 24 h, leaving no orphan parts
