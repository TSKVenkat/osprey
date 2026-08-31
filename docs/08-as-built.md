# 08 — As Built

> What exists, what was proven, and where reality disagreed with the plan.
>
> Documents 00–07 are the design written before any code. This one is written
> after, and where the two conflict, this one is right.

---

## 1. What exists

```
apps/api          Fastify 5. Auth, uploads, recordings, sharing, storage config, file serving
apps/web          React 19 + Vite. Sign in, library, record with a camera bubble, watch, share, settings
apps/worker       pg-boss consumer. ffmpeg normalisation, poster frames, the sweeper
packages/db       Drizzle schema, migrations, PGlite test database
packages/storage   StorageConnector, four backends, the conformance suite
packages/recorder  Capture core: coalescer, scheduler, retry, spill, recovery, state machine
packages/processing ffprobe, the encode plan, ffmpeg argument builders
packages/jobs      Job names and queue setup, shared by the API and the worker
e2e/               Playwright: record, camera, share, recover, spill — in a real browser
deploy/            Dockerfile targets and compose for the whole instance
```

**300 unit and integration tests, 17 browser specs.** CI runs lint, typecheck, the
full suite, a production build, and the browser suite against a real Postgres with
the Chrome already on the runner.

## 2. The product loop, end to end

Measured on a real instance, not inferred:

| Step | What happens | Measured |
|---|---|---|
| Record | `getDisplayMedia` + `MediaRecorder`, 3 s timeslice | Chrome negotiates H.264 + Opus MP4 |
| Upload | Coalesced into 8 MiB parts, spilled to OPFS, 4 parallel workers | Runs while recording continues |
| Stop | Flush the tail, commit | **Share link live in 184 ms** |
| Process | Probe, plan, encode, poster | **1 691 ms** for an 8 s recording |
| Watch | Progressive MP4 over HTTP Range | h264 + aac, duration 8.048 s, seeks instantly |

Time-to-link is independent of recording length, which was the property the whole
design was built around.

## 3. Where reality disagreed with the plan

Every item here was found by running the thing, not by reading about it. They are
the reason this document exists.

### 3.1 The browser

**Chrome has no AAC in `MediaRecorder`.** Every `mp4a.40.2` codec string is
rejected; it pairs MP4 with Opus. The preference list asked only for the AAC
string, so it never matched MP4 at all and silently fell through to WebM — and a
WebM from `MediaRecorder` reports `duration: Infinity`. Same nine-second capture:
WebM says `Infinity`, MP4 says 9.14 s and seeks immediately.

The design doc's reasoning ("prefer MP4, it needs only a remux") was right. The
string was wrong, so the fix never took effect.

**Bare `video/mp4` yields VP9 inside an MP4 container** in Chrome — playable in
Chromium and Firefox, not in Safari. It looks like the safe fallback and is not
one; it now sits last, behind plain WebM.

**Chrome's MP4 output is already fragmented with `moov` at the front**, so no
faststart remux is needed for it. A whole class of planned work disappeared.

### 3.2 Serving

**Helmet's default `Cross-Origin-Resource-Policy: same-origin` blocks playback**
whenever the API is on a different origin from the client, with no error the page
can see. Media is meant to be embedded from elsewhere; access is controlled by the
signed URL.

**`PUBLIC_API_URL` is the setting worth reading twice.** Playback URLs are built
from it, so a value that is right for one topology and wrong for another produces
recordings that upload perfectly and then refuse to play.

### 3.3 Storage providers

Neither of these could have been found without real accounts.

**ImageKit does not return the bytes you uploaded.** It is a media CDN: by default
it serves an optimised rendition, and a 13 970-byte MP4 came back as 4 731 bytes of
different data. `?tr=orig-true` returns the original exactly, supports ranges, and
bypasses media validation. Playback uses the optimised URL; the worker must not.

**ImageKit's file index is eventually consistent in both directions** — no results
for a file just uploaded, one result for a file just deleted. `stat` asks the CDN
directly; `delete` retries its id lookup, without which removing a recording
shortly after storing it would silently do nothing.

**Cloudinary rejects non-media at upload time**, and **its admin API throws plain
objects with the details nested under `.error`** — so a missing asset surfaced as
an error with no message rather than as absence.

**Cloudinary is immediately consistent and returns bytes exactly**, which is the
opposite of what was assumed for it. Consistency is now a declared capability,
measured per backend rather than assumed from what kind of service it looks like.

### 3.4 The runtime

**Node cannot strip a TypeScript parameter property.** `constructor(private readonly x: T)`
is syntax that emits code, not a type annotation. Four classes used one; they
typechecked and passed their tests, because Vitest and Vite transpile rather than
strip — and then the worker refused to start. Lint now rejects them.

### 3.5 Our own design

**Crash safety was tied to S3's minimum part size.** Parts were only written to
disk once 8 MiB had accumulated, so a low-bitrate recording could run for minutes
with nothing spilled and be lost entirely. How much data is acceptable to lose has
nothing to do with what S3 accepts as a part. The coalescer now also persists what
has not yet become a whole part.

**A recovered recording ends mid-fragment**, and ffprobe cannot see it — the header
still reports the duration it intended to reach. Recovered uploads are marked
`interrupted` so processing rebuilds the container instead of trusting it.

### 3.6 A gap the plan never mentioned

The study scoped capture as screen and audio, and never said out loud that a tool
of this kind is expected to put the presenter on screen as well. The camera bubble
was missing entirely until someone asked where it was — which is a failure of the
study, not of the build.

It exists now, along with the floating controls, and the interesting part is that
the bubble has to be **drawn into the video**. An overlay positioned on the page would look correct while recording and
be absent from the file, and nothing short of watching the result back would show
the difference. The screen and camera are composed onto a canvas and that canvas is
what gets recorded, which is why the end-to-end test reads pixels out of the stored
recording rather than checking the page.

**The camera reaches the recording in one of two ways, and which one depends on
what is being shared.** When the whole screen is shared, the camera lives in a
small always-on-top window that is dragged around the real screen with the window
manager — and it is in the recording because it is genuinely on the screen, which
is how a desktop recorder does it and the only arrangement where the thing being
dragged is the bubble itself. When one window or one tab is shared, that floating
window is not inside the capture at all, so the camera is painted into the picture
instead and moved on a preview.

Choosing wrongly is not a visible mistake at the time: a floating bubble over a
shared tab looks perfectly right on screen and is simply absent from the file, and
nobody finds out until they watch it back. So the decision is made from what the
browser reports about the capture, and defaults to painting it in whenever that is
unclear.

**Where a painted bubble goes is a drag, not a setting.** The first version asked for a
corner and a size before recording started, which is a question nobody can answer
yet: where the presenter should sit depends on what is on screen at the time, and
that changes while recording. It is now a free position, dragged on a live view of
the composed picture — so what is dragged is literally what is being stored. The
launcher asks for almost nothing: three toggles and a button, and the recording is
named afterwards, when somebody knows what is in it.

The controls have the same shape of problem. While a whole screen is being
recorded the recorder tab is behind whatever is being demonstrated, so controls on
the page cannot be reached without switching away from the thing being recorded —
and the recording then shows that. Document picture-in-picture is the only way a
browser can put real controls above every other window; Chrome and Edge have it,
Firefox and Safari do not, and there the page keeps its own copy. So does Chrome,
because closing that window must not strand a recording with no way to stop it.

### 3.7 Our own rate limit

Signing in was limited to ten attempts a minute **per address**, and the end-to-end
suite signed in for every test, so it tripped its own protection and failed a test
for a reason unrelated to what it was testing.

Keying on the address alone was wrong regardless: everyone behind one office router
shares that budget and can lock each other out of their own accounts. It is now
counted per account per address, which is what the design document said and what
guessing a password actually looks like. The suite signs in once and reuses the
session, which is also how a person uses it.

## 4. What changed from the plan

| Planned | Built | Why |
|---|---|---|
| Multi-tenant, workspaces | Single-tenant, users own recordings | Scope decision |
| better-auth | ~150 lines: bcrypt + a sessions table | An auth framework for two roles is more to understand, not less |
| XState | A reducer over a discriminated union | Exhaustively typechecked; no dialect to learn |
| Partitioned `view_events` | A plain table | Partitioning needs a partition-creation job; not a problem we have |
| Google Drive connector | Dropped | Its CORS behaviour forces every byte through our API, and its delivery side is an archive, not an origin |
| Testcontainers | PGlite | Real Postgres in-process; no container needed, so the integration tier runs anywhere including CI |
| MSW + fixtures for providers | Conformance suite against real accounts | Recorded fixtures would have reproduced my wrong assumptions faithfully |

## 5. Not built

- **Adaptive streaming (HLS).** Progressive MP4 only. Cloudinary and ImageKit can
  produce adaptive streams themselves; ours would need a ladder and a worker stage.
- **Trim, chapters, folders, search.** No editing of any kind.
- **Desktop capture.** The `CaptureSource` seam exists; nothing fills it.
- **WebCodecs.** `MediaRecorder` is adequate and much simpler.
- **Quotas.** No per-user storage limit is enforced.
- **Audit log.** Security-relevant actions are logged, not recorded in a table.
- **Backup and restore** across Postgres and object storage together.

## 6. What is verified, and how

| Claim | How it is held |
|---|---|
| Upload never loses or corrupts bytes | Property tests: random chunk sequences under injected retry, duplicate and reorder faults |
| Every backend behaves the same | One conformance suite, 11 tests, run against local, S3/MinIO, Cloudinary and ImageKit |
| Recording works in a browser | Playwright drives real Chrome with a synthetic screen |
| A crashed tab is recoverable | The e2e test kills the page mid-recording and recovers it |
| Processing produces playable video | Real ffmpeg on real files, verified with ffprobe |
| Permissions hold | A matrix test: every admin route as anonymous, as a user, as an admin |
| The whole instance runs | The browser suite passes against the containers, not just the dev server |
