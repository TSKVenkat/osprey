# 00 — Systems Study

> Phase 0. Understand the problem class before writing a line of product code.
> Nothing here is a decision; decisions live in [01-baseline.md](01-baseline.md).

---

## 1. What class of system is this?

A Loom-like tool looks like a video app. It is actually **three systems welded together**, and
they fail for different reasons:

| Sub-system | What it does | Dominant failure mode | Hard because |
|---|---|---|---|
| **Media capture & transfer** | Turn screen pixels into durable bytes somewhere else | Data loss, slow "time to link" | The browser tab is a hostile, crash-prone host and the uplink is the bottleneck |
| **Media delivery** | Get those bytes back to a viewer, instantly, seekable | Buffering, broken seek, cost | Containers/codecs are unforgiving; CDN economics dominate |
| **Sharing & context** | Links, permissions, comments, view analytics | Leaked links, N+1 queries | Ordinary CRUD + authz. The *easy* part |

Most clones get sub-system 3 right and 1–2 wrong. **The study below spends its budget on 1 and 2.**

### The single UX property that defines the product

> **Time-to-link**: the delay between the user pressing *Stop* and a working share URL.

Loom's whole architecture is downstream of making this ~1–3 seconds regardless of recording length.
The only way to achieve it is to **upload while recording**, so that at *Stop* only the tail
(the last few seconds) remains in flight. Every other design choice bends to this.

A naive design — buffer in memory, upload on stop — has time-to-link proportional to file size:

```
time_to_link_naive ≈ file_bytes / uplink_bytes_per_sec
time_to_link_streamed ≈ tail_bytes / uplink_bytes_per_sec + assemble_time
```

---

## 2. The physics: numbers that constrain the design

Screen content at 1080p30 with a modern codec sits around **2.0–3.0 Mbps** (screen video is
low-entropy — large flat regions, sporadic motion — so it encodes far cheaper than camera video).

| Recording length | @2.5 Mbps | Upload time @5 Mbps uplink | Upload time @25 Mbps |
|---|---|---|---|
| 1 min | ~19 MB | ~30 s | ~6 s |
| 5 min | ~94 MB | ~2.5 min | ~30 s |
| 15 min | ~280 MB | ~7.5 min | ~1.5 min |
| 60 min | ~1.1 GB | ~30 min | ~6 min |

**Consequences that are not negotiable:**

1. **A 60-minute recording cannot live in tab memory.** At ~1.1 GB you are one GC pause from an
   OOM kill. Bytes must leave the tab continuously, or spill to disk.
2. **The uplink, not the CPU, is the bottleneck** on most connections. Encoder choice matters less
   than transfer scheduling. Optimizing encode speed while uploading serially is optimizing the
   wrong end.
3. **Upload must survive interruption.** A 7-minute upload on flaky Wi-Fi *will* be interrupted.
   Restart-from-zero is not an acceptable recovery strategy → resumable, chunked transfer is
   mandatory, not an enhancement.
4. **Storage cost is a product constraint.** 1 GB/hour/user compounds. Retention policy, orphan
   GC, and rendition count are architecture concerns, not ops afterthoughts.

---

## 3. The capture layer: what browsers actually give you

### 3.1 The two APIs

- `navigator.mediaDevices.getDisplayMedia()` → a `MediaStream` of screen/window/tab.
- `MediaRecorder` → encodes that stream into container chunks, emitted via `ondataavailable`.
- `MediaRecorder.start(timeslice)` — **the key call.** With a timeslice (ms), chunks are emitted
  periodically instead of one blob at the end. This is what makes streaming upload possible.

### 3.2 Capability matrix (as of 2026 — verify at implementation time)

| Capability | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| `getDisplayMedia` video | ✅ | ✅ | ✅ |
| **System/tab audio** via `getDisplayMedia` | ✅ (`audio:{systemAudio:'include'}`) | ❌ *API accepts it, silently gives no audio* | ❌ same |
| Mic audio (`getUserMedia`) | ✅ | ✅ | ✅ |
| `MediaRecorder` WebM/VP8/VP9/Opus | ✅ | ✅ | ✅ **only 18.4+** |
| `MediaRecorder` MP4/H.264/**AAC** | ❌ **see below** | ⚠️ partial | ✅ (was the *only* option ≤18.3) |
| `MediaRecorder` MP4/H.264/**Opus** | ✅ | ⚠️ | — |
| WebCodecs `VideoEncoder` | ✅ 94+ | ✅ 130+ desktop, ❌ Android | ✅ 16.4+ (audio only from 26) |

### Measured in Chrome 148 (not inferred)

Everything above is documentation. These were measured directly, and two of them
contradict what the docs imply:

| Requested | `isTypeSupported` | What you actually get | `<video>.duration` |
|---|---|---|---|
| `video/mp4;codecs=avc1.42E01E,mp4a.40.2` | ❌ | — | — |
| `video/mp4;codecs=avc1.42E01E,opus` | ✅ | `avc1.420015,opus` | **9.14 s** ✅ |
| `video/mp4` (bare) | ✅ | **`vp9,opus` in MP4** | 9.14 s ✅ |
| `video/webm;codecs=vp9,opus` | ✅ | `vp9,opus` | **`Infinity`** ❌ |

1. **Chrome has no AAC in `MediaRecorder`.** Every `mp4a.40.2` string is rejected; it
   pairs MP4 with Opus. A preference list that only asks for the AAC string never
   matches MP4 at all and silently falls through to WebM.
2. **Bare `video/mp4` yields VP9 inside an MP4 container** — playable in Chromium and
   Firefox, not in Safari. It looks like the safe fallback and is not one.
3. **Recording to MP4 fixes the duration problem outright.** Same capture, same
   length: WebM reports `Infinity`, MP4 reports the real duration and seeks
   immediately. This is a capture-time decision, not something the server has to
   repair afterwards.
4. **Chrome's MP4 output is already fragmented with `moov` at the front**
   (`ftyp, moov@36, moof, mdat, …`), so no faststart remux is needed for it. Only
   the Opus audio has to become AAC for Safari to play it.

**Design implications:**

- **Never hardcode a mimeType, and never assume a codec string is accepted.** Probe with
  `MediaRecorder.isTypeSupported()` against an ordered preference list, record the negotiated type
  as metadata, and check what the browser actually produced (`recorder.mimeType`) — it is not
  always what was asked for.
- **System audio is Chromium-only.** The product must degrade honestly: on Firefox/Safari, either
  hide the "record system audio" toggle or surface an explicit "not supported in this browser"
  state. Silently producing a silent track is the worst outcome and is exactly what the naive
  implementation does.
- Because Safari historically emitted MP4 and Chrome WebM, **the server will receive at least two
  container families.** Normalization is not optional.

### 3.3 The container trap (this bites everyone)

`MediaRecorder` output is **not** a well-formed seekable file:

- **WebM/Matroska**: the recorder writes a streaming-oriented EBML header with **unknown duration**
  and **no Cues (seek index)**. Result: `<video>` shows `duration: Infinity`, the scrubber is
  broken, and seeking either fails or forces a full download. This is the single most common bug
  in every Loom clone.
- **MP4/ISOBMFF**: the `moov` atom (the index) is written **last**, after `mdat`. A player must
  download the entire file before it can start. The fix is `faststart` — relocating `moov` to the
  front.
- **Individual timeslice chunks are not independently playable.** Chunk 0 carries the header;
  chunks 1..n are raw cluster continuations. Chunk 7 in isolation is meaningless bytes.

That last point forks the entire architecture:

| Approach | What a "chunk" is | Enables | Cost |
|---|---|---|---|
| **A. Byte-range chunks** | Opaque slices of one file, reassembled in order | Simple, works with S3 multipart / tus verbatim | Must remux server-side to fix duration/faststart; no playback until complete |
| **B. Real independent segments** | Self-contained fMP4/CMAF segments (via WebCodecs + a muxer) | Progressive/live playback, per-segment retry, no server remux | Much more client code; encoder management; Android Firefox has no WebCodecs |

Approach **A** is the correct baseline. Approach **B** is the correct end state. The baseline must
therefore keep a **seam** at the chunk boundary so B can replace A without touching the transfer,
storage, or delivery layers.

---

## 4. The transfer layer: prior art

Four established ways to move a large file from a browser to storage, resumably:

| Mechanism | Resumable | Direct-to-storage | Notes |
|---|---|---|---|
| **S3 Multipart Upload + presigned part URLs** | ✅ (per part) | ✅ | Native to S3/MinIO/R2/B2. Min part 5 MiB (last part exempt), max 10 000 parts. Client collects `ETag`s; server calls `CompleteMultipartUpload`. **Requires bucket CORS with `ExposeHeaders: ETag`** — forgetting this is the #1 integration bug |
| **tus 1.0** (`tusd`, `tus-js-client`) | ✅ (byte offset) | Via a tus server | Storage-agnostic protocol over plain HTTP; can back onto S3. Adds a service to run |
| **Google resumable upload** (Drive/YouTube) | ✅ (byte offset) | ✅ | `Content-Range` based, **chunks must be multiples of 256 KiB** except the last. Browser CORS restricts reading the `Range` response header → needs a server-side proxy. *Evaluated and dropped; see 05-connectors §2.4* |
| **Provider chunked upload** (Cloudinary `upload_large`) | Partial | ✅ with signature | Sequential chunks with a shared `X-Unique-Upload-Id`; ~100 MB threshold. Less parallel than S3 multipart |

**Insight:** these are the *same abstract protocol* with different spellings —
`begin(session) → put(part_k) → commit([refs]) | abort()`. That shape is exactly what the
connector interface should expose, and it is why a single upload client can drive all of them.

### Prior art in the product space

- **Loom** — cloud-first, chunked upload during recording, compression on the way up.
- **Cap** (`CapSoftware/Cap`, AGPL) — the closest OSS analogue. Tauri/Rust desktop + Next.js web,
  Drizzle + MySQL, S3, self-hostable via Docker Compose, supports **bring-your-own S3**. Worth
  reading before building; confirms the shape but is desktop-first.
- **Screenity** — MIT browser extension; buffers to IndexedDB. Good reference for crash recovery.
- **Mux / Cloudflare Stream** — the managed version of the delivery half. Their public docs are a
  good specification of what "done" looks like for the pipeline.

---

## 5. The delivery layer

Two delivery modes, and the choice is per-recording, not global:

1. **Progressive** — one `.mp4` served over HTTP with `Range` support. Works in every browser with
   zero JS. Requires `faststart`. No bitrate adaptation: a viewer on 3G stalls on a 1080p file.
2. **Adaptive (HLS/DASH)** — a manifest plus segments at multiple bitrates. Requires a transcode
   ladder and `hls.js` for non-Safari browsers. Necessary once viewers are on varied networks.

Baseline ships progressive. But note the connector asymmetry discovered in research: **Cloudinary
and ImageKit can produce adaptive streams on their own** (ImageKit generates HLS/DASH from a URL
parameter, on first request, with no pre-encoding pipeline at all), while MinIO and local disk cannot.
This is a capability difference that will leak into the product unless the delivery layer is
explicitly capability-driven from day one.

**Delivery economics:** egress dominates cost at scale. Immutable, content-addressed object keys
plus long `Cache-Control` turn the CDN into the real serving tier. A design that re-signs a fresh
URL on every page view defeats CDN caching entirely — a subtle but expensive mistake.

---

## 6. Failure-mode catalogue (the real requirements list)

Every one of these has been observed in production systems of this class. The baseline is judged by
whether it has an answer for each.

| # | Failure | Consequence if unhandled | Where it must be handled |
|---|---|---|---|
| F1 | Tab crashes / laptop sleeps mid-recording | Total loss of a 40-min recording | Client: persistent spill (OPFS) + resumable session |
| F2 | Network drops for 90 s | Upload aborts, restart from 0 | Client: per-part retry w/ backoff; server: idempotent parts |
| F3 | Presigned part URL expires on a slow link | Late parts 403 | Re-sign on demand; never pre-sign all parts up front |
| F4 | Retry delivers the same part twice | Duplicate/corrupt assembly | Server: unique `(session, part_no)`, at-least-once tolerant |
| F5 | Parts arrive out of order | Corrupt file | Order by part number at commit, not arrival |
| F6 | User abandons recording | Orphan multipart uploads bill forever | Sweeper job: abort + delete after TTL |
| F7 | Recorded WebM has `duration: Infinity` | Broken scrubber, "it doesn't seek" bug reports | Server: remux/metadata fix stage |
| F8 | MP4 `moov` at end | Viewer waits for full download before playback | `faststart` in the same stage |
| F9 | Share link leaks / is guessed | Private video exposed | High-entropy token, hashed at rest, optional password/expiry |
| F10 | Popular video → thundering herd | Origin/provider rate limits | CDN + cacheable URLs + TTL bucketing |
| F11 | Storage credentials in DB | Instance-wide breach | Envelope encryption, never returned by API, not even to an admin |
| F12 | Provider outage (Cloudinary down) | Recording lost | Fail the upload *before* deleting local spill; retriable |
| F13 | Two tabs recording, same session id | Interleaved parts | Session ownership + fencing token |
| F14 | Clock skew / duplicate view events | Inflated analytics | Idempotency key per view session |

---

## 7. What we are deliberately not building

Explicit non-goals keep the baseline honest:

- ❌ **No AI**: no transcription, summaries, chapters, titles, translation, or "smart" anything.
- ❌ No live streaming / WebRTC broadcast (recording only).
- ❌ No timeline editor (trim-only is a later, optional stage).
- ❌ No DRM.
- ❌ No mobile native apps.

Trim, chapters-by-hand, and desktop capture are *later*, and the seams are noted where relevant.

---

## 8. Open questions this study surfaced (answered in the baseline)

1. Chunk-as-byte-range or chunk-as-segment? → **byte-range, with a seam** (§3.3)
2. Direct-to-provider or proxied upload? → **capability-driven per connector** (see 05-connectors)
3. Where does normalization (remux/faststart/thumbnail) run? → **a pluggable processing stage**
4. Who owns a recording? → **a user**. Single-tenant instance; storage is configured once by an admin
5. Does the client or server decide chunk size? → **client, adaptively; server sets bounds**

---

## Sources

- [MDN: MediaDevices.getDisplayMedia()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [MDN: MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
- [Chrome Platform Status: MP4 container support for MediaRecorder](https://chromestatus.com/feature/5163469011943424)
- [Recording cross-browser compatible media — Media Codings](https://media-codings.com/articles/recording-cross-browser-compatible-media)
- [WebCodecs browser support](https://www.testmuai.com/learning-hub/webcodecs-browser-support/)
- [tus — Resumable Upload Protocol 1.0](https://tus.io/protocols/resumable-upload)
- [tusd reference server](https://github.com/tus/tusd)
- [Google Drive: Upload file data (resumable)](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Cloudinary: chunked upload guidelines](https://support.cloudinary.com/hc/en-us/articles/208263735-Guidelines-for-implementing-chunked-upload-to-Cloudinary)
- [Cloudinary: Adaptive Bitrate Streaming](https://cloudinary.com/documentation/adaptive_bitrate_streaming)
- [ImageKit: Adaptive bitrate streaming](https://imagekit.io/docs/adaptive-bitrate-streaming)
- [S3 multipart + presigned URL upload reference](https://github.com/prestonlimlianjie/aws-s3-multipart-presigned-upload)
- [Cap — open source Loom alternative](https://github.com/CapSoftware/Cap)
