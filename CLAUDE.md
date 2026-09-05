# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm lint                 # eslint
pnpm typecheck            # tsc across every workspace package
pnpm test                 # vitest, unit and integration
pnpm test:e2e             # Playwright, needs a running instance
pnpm build                # production build of every package

pnpm vitest run path/to/file.test.ts          # one file
pnpm vitest run -t 'part of the test name'    # one test
```

The whole instance, on <http://localhost:8080>:

```bash
pnpm stack                # build and start everything
pnpm stack:logs           # follow the api and worker
pnpm stack:down           # stop, keeping data. Add -v to delete it.
```

From source instead, with only the backing services in containers:

```bash
pnpm stack:deps           # postgres and minio
pnpm db:migrate
pnpm dev:api              # :3000
pnpm dev:web              # :5173, proxies /v1 to the API
pnpm dev:worker           # needs ffmpeg on PATH
```

`pnpm db:generate` after changing `packages/db/src/schema.ts`, then `pnpm db:migrate`.

### Running the browser tests

They need an instance to point at. Against compose:

```bash
E2E_WEB_URL=http://localhost:8080 pnpm test:e2e
```

Four specs import application modules directly, so they only run against the Vite
dev server and **skip** against a production build. That is deliberate, not a
failure. `playwright.config.ts` reads `.env`, so the suite signs in with whatever
account the instance actually has.

### Do not run the suite while the stack is up

This is a 7 GB machine and the combination gets OOM-killed. `vitest.config.ts` sizes
its worker pool from `MemAvailable` for that reason, but the reliable rule is one
heavy thing at a time: stop the containers, run the tests, start them again.

## Architecture

Screen recording in the browser, uploaded in parts while recording continues, then
normalised by a worker. Single-tenant: one instance is one team, every recording has
exactly one owner, and there is no permission lattice.

**`packages/recorder`** is the capture core and has no React and no DOM beyond what
capture needs — that is what makes its state machine testable and a desktop client
possible later. `MediaRecorder` emits a chunk every 3 s; `coalescer.ts` accumulates
those into 8 MiB parts; `scheduler.ts` uploads four at a time *during* recording, so
stopping only flushes the tail. Parts are spilled to OPFS as they are made, which is
what lets an interrupted recording be finished rather than lost.

**`packages/storage`** is one `StorageConnector` interface over four backends. The
important file is `conformance.ts`: a shared suite every backend must pass, which
checks declared capabilities against measured behaviour. Two of its cases exist
because of shipped bugs — it rebuilds the connector between calls (the API makes one
per request, so a connector holding upload state in a field passes a naive test and
fails in production), and it refuses a backend that claims a capability it does not
have.

`staged.ts` wraps whole-file providers (Cloudinary, ImageKit) that cannot take
multipart. Its staging directory is fixed rather than `mkdtemp` for the reason above.

**`apps/api`** is Fastify. Sessions are rows, not signed tokens, so revocation is a
delete. `requireOwnerOrAdmin` returns **404, not 403** for somebody else's recording,
so the endpoint does not confirm an id exists. Storage credentials are sealed with
AES-256-GCM under `SECRET_KEY` and no endpoint returns them.

**`apps/worker`** probes the finished file and does the cheapest thing that works —
reuse, remux, transcode audio only, or transcode — producing a faststart H.264/AAC
MP4 and a poster frame. A recording is watchable before this finishes; the detail
view falls back to the original and swaps in the rendition when it lands.

The job queue is pg-boss, which is a queue inside Postgres. There is no Redis.

## Things that will bite

**Node runs `.ts` directly by stripping types, and cannot strip a parameter
property.** A class using one typechecks, passes tests through a bundler, then
refuses to start under Node. There is an eslint rule for it; do not disable it.

**Chrome has no AAC in `MediaRecorder`**, so it pairs MP4 with Opus, and a WebM
recording reports `duration: Infinity` — which is what leaves a scrubber broken.
Codec choice goes through `isTypeSupported`, never an assumption.

**`PUBLIC_API_URL` is where a *browser* finds the instance**, not where the API
listens. Getting it wrong produces recordings that upload perfectly and then refuse
to play.

**Never compare multi-megabyte buffers with `toEqual`.** It walks them element by
element building a diff and exhausts the heap. Use `Buffer.equals`.

**Integration tests use PGlite** — real Postgres compiled to WebAssembly — so they
exercise real SQL and real constraints without a container. Each worker holds its
own, which is why the pool is memory-sized.

## Conventions

Comments explain *why*, not what. A note saying why a fixed staging directory is
correct where `mkdtemp` is wrong earns its lines, because the wrong version looks
right; `// increment the counter` does not.

Commit messages carry the reasoning: what was wrong, why the obvious fix was not the
one taken. **No AI or co-author trailers** in commits or pull requests.

A bug fix comes with a test that fails without it, ideally with the same message
production gave.

## Scope

**No AI features.** Not transcription, summaries, or chapters. This is the point of
the project, not an omission, and requests for it are closed.

**No permission lattice** — no workspaces, folders, or per-object ACLs. See
`ROADMAP.md` for what is planned and what is deliberately not.
