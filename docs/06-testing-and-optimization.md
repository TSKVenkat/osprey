# 06 — Testing Strategy & Optimization Baseline

> "Proper testing" for a media pipeline is not "more unit tests". It is: pure logic tested
> exhaustively, byte-level correctness proven by property tests, and a real capture→playback path
> exercised in a real browser. "Proper optimization" is: measure the four numbers that matter, and
> only then optimize.

---

# Part A — Testing

## 1. The pyramid, sized for this system

```
        ┌──────────────────────────┐
        │  E2E (Playwright)  ~10   │   real capture → upload → playback
        ├──────────────────────────┤
        │  Integration       ~60   │   fastify.inject + testcontainers(pg, minio)
        ├──────────────────────────┤
        │  Conformance       ~12×5 │   one suite, five connectors
        ├──────────────────────────┤
        │  Property/fuzz     ~10   │   byte-level invariants under chaos
        ├──────────────────────────┤
        │  Unit             ~200   │   coalescer, backoff, state machines, ffmpeg argv
        └──────────────────────────┘
```

## 2. Unit — the pure core

`packages/recorder` and `packages/processing` are pure by construction, which is what makes this
tier cheap and fast:

| Under test | Assertions |
|---|---|
| `ChunkCoalescer` | Every emitted part except the last ≥ `minPartBytes`; concatenation reproduces input exactly; `flush()` on an empty buffer emits nothing; single 20 MiB chunk splits correctly |
| `Backoff` | Seeded RNG → deterministic sequence; monotonic ceiling; respects `CAP` and `MAX_ATTEMPTS`; total budget honoured |
| `RateEstimator` | Converges on constant input; no NaN on a zero-elapsed sample |
| Recorder state machine | Every illegal transition throws; `stop` during `finalizing` is a no-op; recovery path reaches `finalizing` |
| `pickMimeType` | Preference order respected with mocked `isTypeSupported` |
| ffmpeg argv builders | Exact argv snapshot per branch (copy / faststart / transcode). **Snapshot the args, never shell out in a unit test** |
| Signed-URL bucketing | Two calls in the same bucket → identical string; bucket boundary → new string; expiry ≥ 1 h always |
| Density check | `[1,2,3]` ok; `[1,3]` rejected; `[]` rejected; `[1,1]` impossible (PK) |

Fake timers throughout (`vi.useFakeTimers()`); no test sleeps.

## 3. Property & fuzz — where byte correctness is proven

The highest-value tests in the repo. Chunked upload is exactly the kind of code where an
example-based test passes and production still corrupts one file in a thousand.

```ts
// Invariant: assembly is loss-free under adversarial delivery.
fc.assert(fc.property(
  fc.array(fc.uint8Array({ minLength: 1, maxLength: 1 << 20 }), { minLength: 1, maxLength: 200 }),
  fc.array(fc.integer({ min: 0, max: 3 })),   // per-part fault script: ok|retry|dup|reorder
  async (chunks, faults) => {
    const source   = concat(chunks);
    const uploaded = await runUploadWithFaults(chunks, faults);   // in-memory connector
    expect(uploaded).toEqualBytes(source);
  }
));
```

Properties worth asserting:

1. **Loss-free assembly** under retry, duplicate delivery, and reordering (F2/F4/F5).
2. **Crash safety**: kill the client at a random point → recovery produces the identical file (F1).
3. **Idempotent ack**: N acks of part *k* leave exactly one row and one ETag.
4. **Sweeper safety**: an active session is never swept; an expired one always is (F6).
5. **Path safety**: a fuzzed `objectKey` never escapes the configured storage root.

## 4. Integration

- `fastify.inject()` — no ports, no flakiness.
- **Testcontainers**: real Postgres (migrations run per suite, transactional rollback per test) and
  real MinIO. Mocking the database out of an upload flow tests the mock.
- Job assertions: run pg-boss in-process, drain the queue synchronously, assert state transitions.
- Authz matrix as a table test: `{anonymous, user, other-user, owner, admin} × {route}` → expected
  status. This is how a permissions regression gets caught before it becomes a data leak, and it is
  the single highest-value integration test in the repo.

## 5. Connector conformance

See [05-connectors.md §4](05-connectors.md). One suite, five implementations, plus the meta-test
asserting declared capabilities match observed behaviour.

## 6. End-to-end (Playwright)

Real capture in headless Chromium:

```
--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream
--use-file-for-fake-video-capture=fixtures/screen-30s.y4m
--auto-select-desktop-capture-source="Entire screen"
--autoplay-policy=no-user-gesture-required
```

Scenarios:

| # | Scenario | Assertion |
|---|---|---|
| E1 | Record 30 s → stop → share link | Link returned in **< 3 s** (this is the product SLO, asserted in CI) |
| E2 | Playback | `<video>` reaches `readyState ≥ 3`, `duration` is finite and within ±200 ms of 30 s |
| E3 | Seek | Set `currentTime = 20`; `seeked` fires in < 1 s (proves faststart) |
| E4 | Crash recovery | Kill the page context at ~60 %; reopen; recovery completes; **downloaded bytes match the reference** |
| E5 | Offline blip | `context.setOffline(true)` for 5 s mid-upload; upload completes |
| E6 | Private share | Non-member gets 404 (not 403 — do not confirm existence) |
| E7 | Authorization | User B gets 404 on user A's recording; a `user` gets 403 on every admin route |
| E8 | Cross-browser | E1–E3 in Chromium, Firefox, WebKit; assert the *negotiated mimeType* per engine |

**Media-level assertions use `ffprobe`, not eyeballs:**

```bash
ffprobe -v quiet -print_format json -show_format -show_streams out.mp4
# assert: duration ≈ 30s ±0.2 | codec_name = h264 | moov before mdat | nb_streams = 2
```

## 7. Chaos & failure injection

Each of F1–F14 in [00-systems-study §6](00-systems-study.md) gets a named test. A failure mode
without a test is a rumour:

- `SIGKILL` the worker mid-assembly → job retries → file is correct, no duplicate assets.
- Provider returns 503 on 30 % of parts → upload still completes within budget.
- Presigned URL expires mid-upload → re-signed transparently (F3).
- Two tabs, one session → fencing token rejects the second writer (F13).
- Postgres connection drops during commit → transaction rolls back, no half-committed session.

## 8. CI

| Stage | Runs | Budget |
|---|---|---|
| lint + typecheck | every push | 60 s |
| unit + property | every push | 90 s |
| integration + conformance (local, MinIO) | every push | 4 min |
| E2E Chromium | every PR | 5 min |
| E2E Firefox + WebKit | merge to main | 8 min |
| Conformance vs. real Cloudinary/ImageKit | nightly | — |
| Load (k6) | weekly + before release | — |

Coverage targets: `packages/recorder` and `packages/storage` ≥ 90 % (pure, no excuse); API handlers
≥ 75 %; UI untargeted — E2E covers what matters there.

---

# Part B — Optimization baseline

## 9. The four numbers

Everything else is noise until these are instrumented:

| # | Metric | Target | Why it is the one that matters |
|---|---|---|---|
| **M1** | **Time-to-link** — `Stop` → share URL returned | p50 < 1.5 s, p95 < 3 s, **independent of duration** | The product's defining property |
| **M2** | **Time-to-first-frame** — share page open → first painted frame | p50 < 800 ms | The viewer's entire impression |
| **M3** | **Upload success rate** — sessions reaching `ready` without user retry | > 99.5 % | Silent data loss is the worst failure |
| **M4** | **Storage bytes per recorded minute** | < 20 MB/min at 1080p | Directly the cost model |

M1 is asserted in CI (E1). A metric that only exists in a dashboard rots.

## 10. Optimizations already designed in

These are architectural, not tuning — they must be in the baseline or they are expensive to add:

| Optimization | Mechanism | Wins |
|---|---|---|
| Upload during recording | timeslice + coalescer + scheduler | M1: O(1) instead of O(duration) |
| Parallel parts (4) | bounded worker pool | Saturates uplink; ~3× over serial |
| Bytes bypass our servers | `directUpload` + presigned targets | Removes API bandwidth cost entirely on S3 |
| Prefer MP4 at capture | mimeType preference order | Turns a transcode (minutes CPU) into a remux (seconds) |
| Remux over transcode | `ffprobe` branch (§03-lld 5.5) | 10–100× less CPU on the common path |
| `faststart` | `-movflags +faststart` | M2: playback starts on first bytes |
| Immutable content-addressed keys | `{sha256[:16]}.mp4` + `max-age=31536000, immutable` | CDN hit rate → M2 and egress cost |
| Signed-URL TTL bucketing | `floor(now/ttl)` cache key | Makes signed URLs CDN-cacheable at all (F10) |
| Keyset pagination | `(created_at, id)` cursor | List latency constant as data grows |
| Partial index on in-flight state | `WHERE state IN (...)` | Sweeper scans stay O(in-flight) |
| Batched view events | client ring buffer + flush | ~1 request per view instead of one per second |
| Streaming assembly | `pipeline`, never `readFile` | Constant memory on 1 GB files |
| Transactional job enqueue | pg-boss + Drizzle, one transaction | No lost or ghost jobs → M3 |

## 11. Adaptive behaviours

```
part_size = clamp(ewma_bps * TARGET_SECONDS_PER_PART, minPartBytes, 16 MiB)
concurrency = capabilities.multipart ? (ewma_bps > 10 Mbps ? 4 : 2) : 1
```

Large parts on fast links = fewer round trips. Small parts on slow links = less to redo on retry
and smoother progress. `TARGET_SECONDS_PER_PART ≈ 8` keeps a part's in-flight time bounded, which
also keeps presigned-URL expiry comfortably out of reach.

## 12. Deliberate non-optimizations (baseline)

Documented so nobody "fixes" them prematurely:

- ❌ No AV1 — encode cost dwarfs the bandwidth saving at this scale.
- ❌ No HLS ladder — one 1080p progressive file until viewer-network data says otherwise.
- ❌ No Redis cache — Postgres at this scale is not the bottleneck; measure first.
- ❌ No WebCodecs pipeline — `MediaRecorder` is adequate and vastly simpler. Revisit when
  progressive playback of an in-progress recording becomes a requirement.
- ❌ No multi-region — single region until latency data justifies the complexity.

## 13. Load testing shape (k6)

| Scenario | Shape | Passes if |
|---|---|---|
| Upload storm | 50 concurrent sessions, 8 MiB parts, 10 min each | p95 `getPartTarget` < 150 ms; no 5xx |
| Share-page burst | 1 000 rps on `/v1/shares/:token` | p95 < 100 ms; CDN hit > 90 % on second run |
| Dashboard list | 200 rps, an account with 5 000 recordings | p95 < 120 ms (proves keyset pagination) |
| Worker saturation | 100 queued `recording.process` jobs | Queue drains; no OOM; ffmpeg concurrency capped |

The worker must cap ffmpeg concurrency at `min(cpus - 1, 4)`. Unbounded transcode concurrency is the
classic way a media worker takes down its own host.
