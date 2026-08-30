# 07 — Build Order & the Next Phase

> Phase 1 ends here. This document is (a) the order to build the baseline in, and (b) the agenda
> for the scaling conversation — **not** the scaling plan itself.

---

## 1. Build order

Sequenced so that each milestone is independently demoable and de-risks the *next* one. The riskiest
work (chunked upload correctness) comes early, not last.

> **All eight are done.** What was actually built, and where it differs from this
> plan, is recorded in [08-as-built.md](08-as-built.md).

| # | Milestone | Deliverable | Status |
|---|---|---|---|
| **M0** | Skeleton | pnpm monorepo, Fastify + health, Vite shell, Drizzle 0001–0002, Compose w/ Postgres + MinIO | ✅ Done |
| **M1** | **Storage core** | `StorageConnector` + `local` + `s3`; conformance suite green | ✅ Done |
| **M2** | **Upload core (headless)** | Coalescer, spill log, scheduler, backoff + server session/part/commit routes. **No UI** — driven by a test harness | ✅ Done |
| **M3** | Recorder UI | `getDisplayMedia`, mimeType negotiation, reducer state machine, live progress | ✅ Done |
| **M4** | Share & play | Share links, public viewer, `Range` playback, view events | ✅ Done |
| **M5** | Processing | Worker, `ffprobe` branch, remux/faststart, poster | ✅ Done |
| **M6** | Recovery & GC | `recovering` state, sweeper, quota enforcement | ✅ Done |
| **M7** | Connectors | Cloudinary, ImageKit + `/test` round trip + storage UI | ✅ Done |
| **M8** | Hardening | Rate limits, audit log, tracing, E2E across three engines | ✅ Done |

**M1 → M2 → M3 order is the important one.** Building the recorder UI first (the tempting path,
because it demos well) means debugging capture, transfer, and storage simultaneously through a
browser. M2's headless harness lets the byte-correctness work be debugged with `console.log` and
property tests instead.

---

## 2. Reference targets for the baseline

| Dimension | Baseline target | Note |
|---|---|---|
| Users | ~200 on one instance | Single Postgres |
| Concurrent recordings | ~50 | API is stateless; workers are the constraint |
| Recording length | ≤ 60 min | Above this, revisit part sizing and browser memory |
| Storage | Provider-limited | Ours is metadata only |
| Regions | 1 | |
| Availability goal | 99 % | Self-host default; no HA Postgres in the baseline |

---

## 3. The Phase 2 agenda (open questions, deliberately unanswered)

These are the conversations to have **after** the baseline exists and has produced data. Each is
listed with the measurement that should decide it — deciding them now would be guessing.

### 3.1 Delivery
- When does progressive MP4 stop being enough? → **Measure**: viewer bandwidth distribution and
  rebuffer rate from M2 telemetry. Decide the HLS ladder from real numbers, not from intuition.
- Build our own ladder, or delegate to Cloudinary/ImageKit? Cost model differs sharply by volume —
  this is arithmetic once egress data exists.
- CDN strategy: bunny/Cloudflare in front of MinIO, or provider CDNs? Egress cost dominates.

### 3.2 Capture
- Does the WebCodecs path (independently playable segments) earn its complexity? It unlocks
  progressive playback *while recording* and removes server remux — but doubles client complexity
  and excludes Firefox Android.
- Tauri desktop: system audio everywhere, global hotkeys, crash-resilient local buffering. The
  `CaptureSource` seam exists for exactly this. Scope: packaging, signing, auto-update.

### 3.3 Scale-out
- pg-boss → BullMQ: at what job rate? → **Measure** queue latency under load first.
- Read replicas + PgBouncer: at what read QPS?
- Worker autoscaling: CPU-bound and bursty — the natural first candidate for a separate scaling
  policy (or spot instances).
- Multi-region: only when viewer latency data justifies it. Object storage replication and share
  token routing are the hard parts, not the API.

### 3.4 Product surface
- **Teams/workspaces**, if the instance ever needs to serve more than one group. The current model
  is deliberately single-tenant; adding a tenancy layer later is a real migration, and that is an
  accepted, documented cost.
- Trim editor (server-side cut on keyframes — cheap; frame-accurate — expensive).
- Chapters, hand-authored (no AI).
- Folders, search, bulk operations at 10 000+ recordings.
- Embeds, custom domains, SSO/SAML.
- Webhooks, public API, an OSS SDK.

### 3.5 Operations
- Backup/restore covering **both** Postgres and object storage — a consistent restore across two
  systems is a genuine design problem, and the one most self-host projects skip.
- Retention and legal hold; GDPR delete across every connector, including the ones we do not own.
- Usage metering and storage quotas per user.

---

## 4. Risks carried into Phase 2

| Risk | Likelihood | Impact | Current mitigation |
|---|---|---|---|
| Browser API drift (system audio, MediaRecorder containers) | High | Medium | Capability probing at runtime; never hardcode |
| Provider API breaking changes (5 connectors × versions) | Medium | Medium | Conformance suite + nightly real-credential run |
| ffmpeg CPU cost at scale | Medium | High | Remux-over-transcode branch; concurrency cap; delegate to Cloudinary where available |
| Storage cost growth | High | High | Quotas, retention, orphan GC, single-rendition baseline |
| Staged backends put bytes through our API | Medium | Medium | Cloudinary and ImageKit take whole files only; documented, and S3 stays the direct-upload default |
| **Name/trademark** — "Loom" is a trademark | High | High | **Rename before any public release.** `openloom` here is a working directory name only |

---

## 5. What Phase 1 hands to Phase 2

- Five documents that state *why*, not just *what*, so decisions can be revisited on their original
  reasoning rather than re-litigated from scratch.
- Four seams (`CaptureSource`, `StorageConnector`, `Processor`, `DeliveryStrategy`), each with at
  least two known implementations — which is what distinguishes an abstraction from speculation.
- Fourteen named failure modes, each mapped to a mechanism and a test.
- Four metrics (M1–M4) that make the scaling conversation quantitative instead of aesthetic.
