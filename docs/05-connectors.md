# 05 — Storage Connectors

> Five backends behind one interface. The differences are real and must be *declared*, not
> discovered at runtime. Interface definition lives in [03-lld.md §2](03-lld.md).

---

## 1. Capability matrix

This table is the design. Everything else in this document is footnotes to it.

| Capability | S3/MinIO | Cloudinary | ImageKit | Google Drive | Local FS |
|---|---|---|---|---|---|
| `directUpload` (browser → provider) | ✅ presigned PUT | ✅ signed POST | ✅ signed POST | ⚠️ CORS-constrained | ❌ |
| `multipart` (parallel, out-of-order) | ✅ | ❌ sequential chunks | ❌ single request | ❌ sequential offsets | ✅ (we implement it) |
| `resumable` | ✅ per part | ⚠️ per chunk | ❌ | ✅ byte offset | ✅ |
| `signedRead` | ✅ | ✅ | ✅ | ✅ | ✅ (our own signer) |
| `rangeRequests` | ✅ | ✅ | ✅ | ⚠️ quirky | ✅ |
| `serverSideTranscode` | ❌ | ✅ eager/derived | ✅ on-the-fly | ❌ | ❌ (ffmpeg is ours) |
| `adaptiveStreaming` | ❌ | ✅ HLS+DASH | ✅ URL-param HLS/DASH | ❌ | ❌ |
| `minPartBytes` | 5 MiB | ~6 MB practical | n/a | 256 KiB | 1 B |
| `partAlignmentBytes` | — | — | — | **262 144** | — |
| `maxObjectBytes` | ~5 TiB | plan-dependent | plan-dependent | user quota | disk |
| Effective role | **reference backend** | managed pipeline | managed delivery | personal/BYO archive | dev + test oracle |

**Two structural asymmetries drive everything:**

1. **Parallelism.** Only S3 does true out-of-order multipart. Everyone else is sequential. The
   `UploadScheduler` therefore must run with `concurrency = capabilities.multipart ? 4 : 1`, and
   sequential connectors must upload parts strictly in ascending order.
2. **Who transcodes.** Cloudinary/ImageKit can; S3/Drive/local cannot. The `Processor` chain is
   either *executed* by our worker or *delegated* to the provider. Same pipeline contract, two
   executors.

---

## 2. Per-connector notes

### 2.1 S3 / MinIO (`kind: 's3'`) — the reference implementation

One implementation covers AWS S3, MinIO, Cloudflare R2, Backblaze B2, Wasabi, Hetzner. This is the
default for self-hosting (MinIO in Compose) and the connector everything else is measured against.

```ts
new S3Client({
  endpoint,                    // MinIO / R2 / B2
  region: region ?? 'us-east-1',
  forcePathStyle: true,        // REQUIRED for MinIO
  credentials: { accessKeyId, secretAccessKey },
})
```

Flow: `CreateMultipartUpload` → per-part presigned `UploadPart` (signed on demand, 1 h TTL) →
`CompleteMultipartUpload` with ascending `{PartNumber, ETag}` → `AbortMultipartUpload` on failure.

**Required bucket CORS** — omit `ExposeHeaders: ETag` and the browser cannot read the ETag, the
part table never fills, and completion fails with a confusing error. This is *the* classic bug:

```json
[{ "AllowedOrigins": ["https://app.example.com"],
   "AllowedMethods": ["GET","PUT","POST","HEAD"],
   "AllowedHeaders": ["*"],
   "ExposeHeaders": ["ETag","x-amz-request-id"],
   "MaxAgeSeconds": 3000 }]
```

Also set a lifecycle rule to abort incomplete multipart uploads after 1 day — a second line of
defence behind our own sweeper (F6). Orphaned parts are invisible in the bucket listing but still
billed.

**Gotcha:** MinIO ETags are quoted strings; AWS ETags for multipart parts are quoted MD5s. Normalize
by stripping quotes before storing, or completion comparisons fail across backends.

### 2.2 Cloudinary (`kind: 'cloudinary'`)

Value: an entire media pipeline as a service — transcode, ABR, posters, derived formats.

- Chunked upload above ~100 MB via `upload_large`, i.e. sequential chunks sharing an
  `X-Unique-Upload-Id` with `Content-Range` headers. **Sequential** → `concurrency = 1`.
- Signed direct upload from the browser: server computes the signature over the params; browser
  POSTs to `/v1_1/{cloud}/video/upload`. The API secret never leaves the server.
- **Eager transformations** at upload time produce the streaming renditions, so the `hls` stage is
  delegated. Eager work is async — the connector must poll or accept a notification URL before
  marking assets ready.
- `resource_type: 'video'` and `public_id` set to our object key so keys stay uniform across
  connectors.

**Gotchas:** free-tier limits bite quickly on video; eager transforms are billed per rendition;
deletion must go through the Admin API (`destroy`) — deleting our DB row alone leaks storage.

### 2.3 ImageKit (`kind: 'imagekit'`)

The cheapest adaptive streaming in the set: **HLS/DASH are URL parameters**. Manifests and
renditions are generated on first request — no pre-encoding pipeline, no extra storage, no job
queue. For this connector, `getPlaybackTarget({preferAdaptive:true})` is a string transformation and
nothing else.

- Upload is a single signed POST (server-generated token/signature/expire). No native chunking →
  large recordings must go through the **proxy** transport with server-side assembly first, then a
  single upload of the assembled file.
- That is an important honest limitation: for ImageKit, "upload during recording" lands the parts in
  *our* staging area (local/S3), and the final object is pushed after assembly. Time-to-link is
  therefore assembly-bound, not upload-bound. Document it in the connector picker UI.

### 2.4 Google Drive (`kind: 'gdrive'`)

Value: users store recordings in their own Drive. Popular for privacy-conscious self-hosters.

- OAuth 2.0 with `drive.file` scope (access limited to files we create — the least-privilege scope,
  and the one that passes Google verification most easily).
- Resumable upload: `POST .../files?uploadType=resumable` → session URI → sequential `PUT`s with
  `Content-Range: bytes {start}-{end}/{total}`. **Chunks must be multiples of 256 KiB** except the
  last (`partAlignmentBytes: 262144`).
- Total size may be unknown up front (`bytes {start}-{end}/*`) — which suits live recording, since
  we do not know the final length until the user stops.
- **CORS is the blocker for direct upload:** browsers cannot reliably read the `Range` response
  header needed to resume. → Drive runs on the **proxy** transport. Bytes flow browser → our API →
  Drive. Plan for the bandwidth: unlike S3, our server is on the data path.
- Refresh tokens must be stored (encrypted) and refreshed; a revoked grant must surface as a
  `status='failing'` connector, not as silent upload failures.

**Gotchas:** playback from Drive is not a clean CDN story — sharing permissions and quirky range
behaviour make it best suited to *archival* rather than *serving*. Recommended pairing: Drive as
archive + another connector for delivery. The data model already supports this (assets carry their
own object keys), but the baseline ships single-connector-per-recording; dual-destination is Phase 3.

### 2.5 Local filesystem (`kind: 'local'`)

Not a toy. It is the **conformance oracle**: the simplest possible correct implementation, against
which every other connector's behaviour is compared, and the one that runs in unit tests with no
containers.

- Parts as files under `{root}/{objectKey}.parts/{partNumber}`; commit streams them in order into
  the final file (§03-lld 5.4), then `fsync` + rename for atomicity.
- Reads served by the API with proper `Range` support (`206`, `Content-Range`, `Accept-Ranges`).
- Signed reads via HMAC-signed query params with expiry — same shape as a presigned S3 URL, so the
  playback code path is identical.
- Requires a shared volume when scaling the API horizontally. Documented as single-node only.

---

## 3. Connector selection and configuration

- One instance default, set by an admin. `recording.storage_config_id` is pinned at creation, so
  changing the default never orphans existing recordings.
- `POST /connectors/:id/test` performs a real round trip — create a small object, read it back,
  range-read the middle, delete it — and stores the observed capabilities. **Never trust a
  hand-declared capability matrix in production**; a misconfigured MinIO without CORS declares
  `directUpload: true` and fails only for real users. The test writes the truth.
- Credentials are validated before saving; a failing connector cannot be made the default.

---

## 4. Conformance suite (the payoff)

One test file, five implementations. This is what makes "pluggable storage" real rather than
aspirational:

```ts
describe.each(connectorsUnderTest)('conformance: %s', (make) => {
  it('round-trips a small object');
  it('multipart uploads 3 parts and reassembles byte-identically');
  it('rejects a part below minPartBytes when it is not the last');
  it('is idempotent: re-uploading the same part yields the same result');
  it('aborts cleanly and leaves no residue');           // F6
  it('serves a byte range that matches the source slice');
  it('signed read URL expires');                        // clock-controlled
  it('stat() returns null for a missing key');
  it('delete() is idempotent');
  it('rejects an object key outside the configured root'); // path traversal
  it('honours partAlignmentBytes when declared');       // Drive
  it('reports capabilities that match observed behaviour');  // the meta-test
});
```

Local FS and MinIO (testcontainers) run on every commit. Cloudinary, ImageKit, and Drive run
against **recorded HTTP fixtures** in CI and against real credentials in a nightly job — credentials
never enter PR CI.

The last test is the important one: it asserts the declared matrix against measured behaviour, so
§1 of this document cannot silently drift away from the code.

---

## 5. Adding a sixth connector

The checklist, deliberately short — if it grows, the interface is wrong:

1. Implement `StorageConnector` in `packages/storage/src/<kind>/`.
2. Declare `capabilities` honestly.
3. Add the kind to the `connector_kind` enum (one migration).
4. Add config + secret Zod schemas to `packages/contracts`.
5. Register in the conformance suite.
6. Add a fixture set for CI.

No changes to the recorder, the API routes, the worker, or the player. That is the acceptance
criterion for this design.
