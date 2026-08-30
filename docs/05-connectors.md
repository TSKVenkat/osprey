# 05 — Storage Connectors

> Five backends behind one interface. The differences are real and must be *declared*, not
> discovered at runtime. Interface definition lives in [03-lld.md §2](03-lld.md).

---

## 1. Capability matrix

This table is the design. Everything else in this document is footnotes to it.

| Capability | S3/MinIO | Cloudinary | ImageKit | Local FS |
|---|---|---|---|---|
| `directUpload` (browser → provider) | ✅ presigned PUT | ❌ staged | ❌ staged | ❌ |
| `multipart` (parallel, out-of-order) | ✅ native | ✅ into staging | ✅ into staging | ✅ (we implement it) |
| `resumable` | ✅ per part | ✅ per part, in staging | ✅ per part, in staging | ✅ |
| `signedRead` | ✅ | ✅ | ✅ | ✅ (our own signer) |
| `rangeRequests` | ✅ | ✅ | ✅ | ✅ |
| `immediatelyConsistent` | ✅ | ✅ *measured* | ❌ *measured* | ✅ |
| Returns the bytes you gave it | ✅ | ✅ | ❌ **only via `orig-true`** | ✅ |
| Accepts non-media bytes | ✅ | ❌ rejects on upload | ⚠️ accepts, refuses to serve | ✅ |
| `serverSideTranscode` | ❌ | ✅ eager/derived | ✅ on-the-fly | ❌ (ffmpeg is ours) |
| `adaptiveStreaming` | ❌ | ✅ HLS+DASH | ✅ URL-param HLS/DASH | ❌ |
| `minPartBytes` | 5 MiB | 1 B (staged) | 1 B (staged) | 1 B |
| `maxObjectBytes` | ~5 TiB | plan-dependent | plan-dependent | disk |
| Effective role | **reference backend** | managed pipeline | managed delivery | dev + test oracle |

**Google Drive is out of scope.** It was in the original study as a personal-archive
option; it is not being built. Its CORS behaviour forces every byte through our API,
and its delivery side is poor enough that it would have needed pairing with a second
backend to be useful.

**Two structural asymmetries drive everything:**

1. **Who accepts parts at all.** S3 takes parts natively while a recording is still going.
   Cloudinary and ImageKit take *whole files only*: neither has a concept of a part, and neither
   accepts bytes whose total length is not yet known — which a live recording's never is. They sit
   behind `StagedConnector`, which collects parts locally and hands over one finished file. The
   cost is honest: for those backends the recording is not at the provider until it is complete, so
   time-to-link is bound by assembly rather than by the last part.
2. **Who transcodes.** Cloudinary and ImageKit can; S3 and local cannot. The `Processor` chain is
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

### 2.1a What running against real accounts changed

Everything above the line was written from documentation. These were measured
against live Cloudinary and ImageKit accounts, and three of them contradicted what
the code assumed:

1. **ImageKit does not return the bytes you uploaded.** It is a media CDN: by
   default it serves an optimised rendition, and a 13,970-byte MP4 came back as
   4,731 bytes of different data. `?tr=orig-true` returns the original exactly,
   supports range requests, and bypasses the media validation. Playback uses the
   optimised URL; everything else — the worker especially — must use the original,
   because processing a re-encode of a re-encode is not what "the original" means.
2. **ImageKit's file index is eventually consistent in both directions.** It
   returned no results for a file that had just been uploaded, and one result for a
   file that had just been deleted. Using it to answer "does this exist" reported
   recordings missing seconds after they were stored, so `stat` asks the CDN
   directly and `delete` retries its id lookup.
3. **Cloudinary refuses non-media outright.** `Unsupported video format or file`,
   at upload time, for anything that is not really a video. ImageKit is laxer: it
   accepts the upload and then refuses to serve it. Neither is a general object
   store, which is why the conformance suite uploads a real MP4 for Cloudinary.
4. **Cloudinary's admin API does not throw `Error` objects.** It throws a plain
   object with the details nested under `.error`, so a top-level check for
   `http_code` finds nothing and a missing asset surfaces as an error with no
   message rather than as "not there".
5. **Cloudinary is immediately consistent**, and returns uploaded bytes exactly.
   In both respects it behaves more like object storage than ImageKit does.

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

### 2.4 Google Drive — not built

Dropped from scope. Worth recording why, since the study argued for it:

- Browsers cannot reliably read the `Range` response header a resumable upload needs, so **every
  byte would flow through our API** rather than going direct.
- Its delivery side is not a serving story — sharing permissions and quirky range behaviour make it
  an archive, not an origin. Useful only paired with a second backend for playback, which the
  baseline does not support (a recording pins one storage configuration).

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

1. Implement `StorageConnector` — or, for a provider that only takes whole files, implement
   `Publisher` and let `StagedConnector` do the rest.
2. Declare `capabilities` honestly.
3. Add the kind to the `connector_kind` enum (one migration).
4. Add config + secret Zod schemas to `packages/contracts`.
5. Register in the conformance suite.
6. Add a fixture set for CI.

No changes to the recorder, the API routes, the worker, or the player. That is the acceptance
criterion for this design.
