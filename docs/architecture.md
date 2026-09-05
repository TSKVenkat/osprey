# How it works

Five processes, one database, and storage you bring yourself.

```
browser ──── web (Caddy, static files) ──── api (Fastify) ──── postgres
   │                                          │
   │                                          ├─── storage backend
   └──── uploads parts, directly where        │
         the backend allows it                └─── job queue ──── worker (ffmpeg)
```

## Recording

The browser captures with `getDisplayMedia` and `MediaRecorder`, which hands over a
chunk every three seconds. A coalescer accumulates those into 8 MiB parts and a pool
of four workers uploads them **while recording is still going**. Pressing stop only
has to flush the tail, which is why the share link is live in one to three seconds
whether the recording ran for one minute or forty.

Parts go straight to the storage provider through short-lived signed URLs where the
backend supports it, and through the API otherwise. Either way the server commits
the upload, returns the link immediately, and queues a job.

Two things make this survivable rather than merely fast:

**Parts are spilled to the origin private file system** as they are made, so a
browser that dies mid-recording can offer to finish the upload rather than losing
it. The pending tail is persisted too, so crash safety does not depend on having
reached a part boundary.

**The recorder negotiates its codec** against `MediaRecorder.isTypeSupported`
rather than assuming. This matters more than it sounds: Chrome has no AAC in
`MediaRecorder`, so it pairs MP4 with Opus, and a WebM recording reports a duration
of `Infinity` — which is what leaves a scrubber broken. Recording to MP4 is what
fixes it.

## Processing

The worker probes the finished file and picks the cheapest thing that will work:
reuse it as-is, remux the container, transcode only the audio, or transcode
everything. The output is a faststart H.264/AAC MP4 with a poster frame.

A recording is watchable *before* this finishes — the detail view falls back to the
original file and swaps in the processed one when it lands. Processing is an
improvement, not a gate.

The worker also sweeps: abandoned uploads, and the files of deleted recordings once
`RETENTION_DAYS` has passed.

## Playback

A progressive MP4 over HTTP range requests, from an immutable key that a CDN can
cache forever. No player library, because there is nothing to play that a `<video>`
element cannot. Backends that provide adaptive streaming get it delegated to them.

Share links are unguessable tokens with three visibilities — anyone with the link,
anyone with the link and a password, anyone signed in here — checked server-side,
and revocable immediately rather than at the end of a cache window.

## The pieces

```
apps/api            Fastify HTTP API
apps/web            React client: record, library, playback, settings
apps/worker         ffmpeg normalisation, and sweeping up afterwards
packages/db         Drizzle schema, migrations, database client
packages/storage    StorageConnector, the four backends, conformance suite
packages/recorder   capture core: coalescer, scheduler, retry, spill, state machine
packages/processing ffprobe, the encode plan, ffmpeg argument builders
packages/jobs       job names and queue setup, shared by API and worker
e2e/                Playwright: record, upload and play back in a real browser
deploy/             docker compose, and the web container's Caddyfile
```

The recorder core is deliberately free of React and of the DOM beyond what capture
requires, so its state machine can be tested directly and so a desktop client could
reuse it later.

## Choices worth knowing about

**Single tenant.** One instance is one team. Users own recordings; an administrator
configures storage once. There are no workspaces, no folder ACLs, and no permission
lattice — every object has exactly one owner, and inventing machinery for sharing
rules nobody has asked for would have to be carried by every feature afterwards.

**Sessions are rows, not signed tokens.** A cookie carries an opaque id and the row
carries the expiry, so revocation is a delete rather than a wait. Changing somebody's
role or disabling them revokes every session they hold.

**Keyset pagination, not `OFFSET`.** With `OFFSET` the database walks and discards
every row it skips, so page fifty costs fifty pages of work. This stays flat forever.

**Postgres is the only infrastructure.** The job queue is `pg-boss`, which is a
queue in the database you already run. No Redis, no Kafka, no cloud dependency.

