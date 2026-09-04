# 03 — Low-Level Design

> Module boundaries, the interfaces that matter, state machines, and the algorithms worth writing
> down before writing code. Types are illustrative TypeScript, not final source.

---

## 1. Repository layout

```
osprey/
├─ apps/
│  ├─ web/                    React 19 + Vite (recorder + viewer + dashboard)
│  ├─ api/                    Fastify 5
│  └─ worker/                 pg-boss consumers + ffmpeg
├─ packages/
│  ├─ contracts/              Zod schemas → shared types (the ONLY cross-tier dependency)
│  ├─ storage/                StorageConnector interface + 5 implementations + conformance suite
│  ├─ recorder/               framework-free: coalescer, spill log, scheduler, backoff, state machine
│  ├─ processing/             Processor chain, ffmpeg argv builders, ffprobe parsing
│  ├─ db/                     Drizzle schema, migrations, repositories, scoping helper
│  └─ jobs/                   job name/payload registry, pg-boss wiring
├─ deploy/                    docker-compose, Caddyfile, .env.example
└─ docs/
```

**Rule:** `packages/recorder` and `packages/storage` have **zero framework imports**. They take
plain data and return plain data, which is what makes them testable without a browser or a network.

---

## 2. `StorageConnector` — the central interface

The unification of S3 multipart, Google resumable, and Cloudinary chunked upload, all of which are
`begin → put(part) → commit | abort`.

```ts
export type ConnectorKind = 's3' | 'cloudinary' | 'imagekit' | 'gdrive' | 'local';

export interface ConnectorCapabilities {
  directUpload: boolean;        // browser → provider with a signed target
  multipart: boolean;           // parts may go in parallel / out of order
  resumable: boolean;           // an interrupted upload can continue
  signedRead: boolean;
  rangeRequests: boolean;       // seeking works
  serverSideTranscode: boolean; // provider can produce renditions
  adaptiveStreaming: boolean;   // provider can serve HLS/DASH
  minPartBytes: number;
  maxPartBytes: number;
  maxObjectBytes: number;
  partAlignmentBytes?: number;  // for a provider that demands aligned chunks
}

export interface UploadSession {
  sessionId: string;            // ours
  providerRef: string;          // S3 uploadId, or our own key for staged backends
  objectKey: string;
  expiresAt: Date;
}

export type UploadTarget =
  | { mode: 'direct'; url: string; method: 'PUT' | 'POST';
      headers: Record<string, string>; expiresAt: Date }
  | { mode: 'proxy'; url: string };   // an API endpoint; bytes stream through us

export interface PartRef { partNumber: number; etag: string; bytes: number }

export interface StoredObject {
  objectKey: string; bytes: number; contentType: string; providerId?: string;
}

export interface PlaybackTarget {
  url: string; kind: 'progressive' | 'hls' | 'dash';
  expiresAt?: Date; poster?: string;
}

export interface StorageConnector {
  readonly kind: ConnectorKind;
  readonly capabilities: ConnectorCapabilities;

  createUpload(i: { objectKey: string; contentType: string; expectedBytes?: number })
    : Promise<UploadSession>;
  getPartTarget(s: UploadSession, partNumber: number, byteLen: number)
    : Promise<UploadTarget>;                       // signed ON DEMAND — never all up front (F3)
  putPart(s: UploadSession, partNumber: number, body: Readable, byteLen: number)
    : Promise<PartRef>;                            // proxy path only
  completeUpload(s: UploadSession, parts: PartRef[]): Promise<StoredObject>;
  abortUpload(s: UploadSession): Promise<void>;

  getPlaybackTarget(o: StoredObject, opts?: { ttlSeconds?: number; preferAdaptive?: boolean })
    : Promise<PlaybackTarget>;
  stat(objectKey: string): Promise<{ bytes: number; contentType: string } | null>;
  delete(objectKey: string): Promise<void>;
  openRead(objectKey: string, range?: { start: number; end?: number }): Promise<Readable>;
}
```

**Design notes:**

- `getPartTarget` is per-part and on-demand. Pre-signing all parts at session creation is the
  standard mistake: a slow uploader's later URLs expire mid-flight (F3).
- `putPart` and `getPartTarget` are the two topologies; the client picks by
  `capabilities.directUpload`. One client, two transports.
- `openRead` with a range exists so the worker can stream to `ffmpeg` without materializing a 1 GB
  file in memory.
- Everything is `Promise`-returning and takes/returns plain objects → the conformance suite (see
  [06-testing](06-testing-and-optimization.md)) runs unmodified against all five implementations.

---

## 3. Recorder state machine

```
                     ┌──────┐
                     │ idle │
                     └───┬──┘
                start    │
                         ▼
              ┌────────────────────┐   denied / no devices
              │ requestingCapture  │────────────────────────┐
              └─────────┬──────────┘                        │
                        │ granted                           ▼
                        ▼                              ┌─────────┐
                  ┌──────────┐   user cancels          │ failed  │
                  │  ready   │────────────────────────►└─────────┘
                  └────┬─────┘                              ▲
                       │ start                              │
                       ▼                                    │ unrecoverable
       ┌──────────────────────────────┐                     │
       │         recording            │◄──── resume ────┐   │
       │ (coalescing, spilling,       │                 │   │
       │  uploading concurrently)     │──── pause ─────►│ paused
       └──────────────┬───────────────┘                 └───┘
                      │ stop
                      ▼
            ┌────────────────────┐   parts still queued
            │     finalizing     │◄──── retry loop ────┐
            │ flush → drain → commit                   │
            └──────────┬─────────┘─────────────────────┘
                       │ 200
                       ▼
                 ┌───────────┐
                 │ published │  (share link live; processing continues server-side)
                 └───────────┘

  On load, if SpillLog has a manifest in {recording, uploading}:
                 ┌────────────┐  reconcile with API → resume from max(acked)+1
      idle ─────►│ recovering │──────────────────────► finalizing
                 └────────────┘
```

Two states earn their keep and are usually missing from hand-rolled implementations:

- **`finalizing`** — `stop()` does not mean "done". Queued parts must drain, and the UI must show
  honest progress. This is the state where users are told "uploading last 12 MB", not spun at 99 %.
- **`recovering`** — the entire answer to F1. Without it, spilled bytes are dead weight.

---

## 4. Server-side upload lifecycle

```
 draft ──createUpload──► uploading ──complete──► assembling ──► processing ──► ready
   │                         │                       │              │
   │                         │ abort/TTL             │ fail         │ fail
   ▼                         ▼                       ▼              ▼
 abandoned ◄──── sweeper ── abandoned              failed         failed
```

Transitions are guarded by a `CHECK` constraint plus an explicit transition table — an illegal
transition raises, it never silently no-ops.

`assembling` is a distinct state because connector behaviour diverges:

- **S3/MinIO** — `CompleteMultipartUpload` assembles server-side. Assembly is O(1) for us.
- **Local FS** — concatenate part files with a streaming pipeline (never `readFile`).
- **Cloudinary / ImageKit** — parts were staged locally; commit assembles them and uploads one
  finished file, because neither provider accepts parts at all.
- **Cloudinary** — final chunk with the terminal `Content-Range` triggers assembly provider-side.

Same state, four implementations. That divergence is precisely why it is a named state and not an
inline branch.

---

## 5. Key algorithms

### 5.1 mimeType negotiation (client, run once at startup)

```ts
const PREFERENCE = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',  // best: needs no transcode server-side
  'video/webm;codecs=vp9,opus',              // efficient for screen content
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
] as const;

export function pickMimeType(): string | null {
  return PREFERENCE.find(t => MediaRecorder.isTypeSupported(t)) ?? null;
}
```

MP4 first is a deliberate cost decision: an H.264/AAC MP4 needs only a faststart **remux**
(≈1 s, no re-encode), whereas VP9/Opus WebM needs a full transcode (minutes of CPU). Preferring MP4
at capture time moves work off the server for free.

### 5.2 Part upload with retry (client)

```
upload(part):
  for attempt in 0..MAX_ATTEMPTS:
     target = api.getPartTarget(sessionId, part.no, part.bytes)   # fresh signature each attempt
     try:
        etag = transport.send(target, part.blob)                  # direct PUT or proxy POST
        api.ackPart(sessionId, part.no, {etag, sha256, bytes})    # idempotent
        spillLog.release(part.no)                                 # delete OPFS bytes LAST
        rateEstimator.observe(part.bytes, elapsed)
        return
     catch e:
        if isFatal(e): fail(); return                             # 4xx that retrying can't fix
        if budgetExhausted(): fail(); return
        sleep(backoff(attempt))                                   # full jitter
```

The signature is refreshed on every attempt (F3), and OPFS bytes are released only after the
server acknowledges (F1). Both orderings are load-bearing.

### 5.3 Crash recovery (client, on load)

```
for manifest in indexedDB.manifests where state != 'done':
    remote = api.getSession(manifest.uploadSessionId)      # 404 → session gone, offer download
    acked  = set(remote.parts.map(p => p.partNumber))
    pending = manifest.parts.filter(p => !acked.has(p.no) && opfs.exists(p.no))
    if pending.isEmpty and manifest.state == 'uploading':
        api.completeUpload(...)                            # everything landed; just commit
    else:
        enqueue(pending); resumeUploadingUI()
```

Reconciliation is server-authoritative: the server's part table is truth, the client's manifest is
a hint. That asymmetry avoids a whole class of split-brain bugs.

### 5.4 Server-side assembly for connectors without native multipart

```
completeLocal(session, parts):
    assert parts numbered 1..n with no gaps            # invariant from PartTable
    out = createWriteStream(finalKey)
    for p in parts.sortBy(no):
        await pipeline(createReadStream(partPath(p)), out, { end: false })
    out.end()
    verify(sha256(out) or byte length == sum(parts.bytes))
    unlink all part files
```

`pipeline` with `{end:false}` streams part-by-part at constant memory. A `readFile`-and-concat
implementation OOMs on a 1 GB recording — this is the single most common server-side bug in this
system class.

### 5.5 Normalization decision (worker)

```
probe = ffprobe(original)
needsTranscode = probe.videoCodec not in {h264} or probe.audioCodec not in {aac}
needsRemux     = probe.container != 'mp4' or probe.moovAtEnd or probe.durationUnknown

if   not needsTranscode and not needsRemux:  reuse original as mp4_source   # zero work
elif not needsTranscode:                     ffmpeg -i in -c copy -movflags +faststart out.mp4
else:                                        ffmpeg -i in -c:v libx264 -preset veryfast -crf 23 \
                                                    -c:a aac -b:a 128k -movflags +faststart out.mp4
```

Three tiers: free, cheap, expensive. Measuring which tier real recordings land in — per browser —
is the highest-leverage optimization data point in the whole system.

### 5.6 Signed URL with TTL bucketing (API)

```
ttl    = 3600
bucket = floor(now / ttl)
key    = `${objectKey}:${bucket}`
url    = cache.get(key) ?? cache.set(key, connector.sign(objectKey, expiresAt = (bucket+2)*ttl))
```

Signing to `(bucket+2)*ttl` rather than `now+ttl` means a URL minted at the end of a bucket is still
valid for ≥1 hour. Without the `+2`, users who load the page at second 3599 get a URL that dies
one second later — a genuinely nasty intermittent bug.

---

## 6. API surface (baseline)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/recordings` | Create draft + upload session → `{recordingId, sessionId, capabilities, partSizeHint}` |
| `GET` | `/v1/recordings` | Keyset-paginated list of the caller's recordings (admins may pass `?all=1`) |
| `GET` | `/v1/recordings/:id` | Detail + assets |
| `PATCH` | `/v1/recordings/:id` | Title, description, folder |
| `DELETE` | `/v1/recordings/:id` | Soft delete → GC job |
| `POST` | `/v1/uploads/:sid/parts/:n/target` | Mint a signed target for one part |
| `PUT` | `/v1/uploads/:sid/parts/:n` | Proxy transport (non-direct connectors) |
| `POST` | `/v1/uploads/:sid/parts/:n/ack` | Idempotent part acknowledgement |
| `POST` | `/v1/uploads/:sid/complete` | Verify density → commit → enqueue processing |
| `POST` | `/v1/uploads/:sid/abort` | Explicit abandon |
| `GET` | `/v1/uploads/:sid` | Recovery reconciliation |
| `POST` | `/v1/recordings/:id/shares` | Create share link |
| `GET` | `/v1/shares/:token` | Public resolve → metadata + playback target |
| `POST` | `/v1/shares/:token/views` | Batched view events (idempotency key) |
| `POST` | `/v1/auth/login` · `/v1/auth/logout` · `GET /v1/auth/me` | Email + password session |
| `GET/POST/PATCH` | `/v1/admin/users` | Admin only: invite, disable, change role |
| `GET/POST/DELETE` | `/v1/admin/storage` | Admin only: storage config (write-only credentials) |
| `POST` | `/v1/admin/storage/:id/test` | Round-trip validation before it can become the default |

Every route: Zod schema in `packages/contracts` → runtime validation, TS types on both sides, and
generated OpenAPI. One definition, three consumers.

---

## 7. Cross-cutting concerns

| Concern | Implementation |
|---|---|
| Errors | `AppError { code: 'UPLOAD_PART_MISMATCH', httpStatus, retryable, context }`. `retryable` is part of the contract so the client's backoff loop reads it instead of guessing from status codes |
| Idempotency | Part acks are idempotent by primary key. No general idempotency table in the baseline — it would be machinery for a problem we do not have yet |
| Rate limits | `@fastify/rate-limit`. `getPartTarget` gets a high ceiling (it is on the hot path); `createUpload` and `login` get low ones. Login is limited per email **and** per IP |
| Auth | `bcrypt` + `sessions` table; a `preHandler` resolves the cookie into `req.user`. Handlers never read cookies. Route guards: `requireAuth`, `requireAdmin`, `requireOwnerOrAdmin` |
| Secrets | AES-256-GCM envelope encryption; `{ciphertext, iv, tag, keyVersion}` per credential. `keyVersion` exists so rotation is possible without a migration scramble |
| Observability | One trace per upload session (`sessionId` as trace attribute), spans per part. Debugging a stuck upload without this is guesswork |
