<img src="assets/logo.svg" alt="" width="72" height="72" />

# osprey — self-hosted screen recording with share links

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![CI](https://github.com/TSKVenkat/osprey/actions/workflows/ci.yml/badge.svg)](https://github.com/TSKVenkat/osprey/actions/workflows/ci.yml)

Record your screen in a browser, get a link, send it. Your recordings live in
storage you control, on a server you run.

**No AI features.** Not transcription, not summaries, not chapters. That is the
point of the project rather than an omission.

An osprey watches, dives, and comes up holding what it went in for.

---

## What it does

- **Records** screen, window or tab, with microphone, system audio, and a camera
  bubble you can drag anywhere on screen mid-recording.
- **Shares** with a link that works for someone with no account — optionally behind
  a password, revocable immediately.
- **Stores** wherever you point it: S3, MinIO, Cloudflare R2, Backblaze B2,
  Cloudinary, ImageKit, or a directory on disk.
- **Survives a crash.** Parts are written to the browser's own file system as they
  are made, so a browser that dies mid-recording offers to finish the upload rather
  than losing it.
- **Gives you the link in one to three seconds** after you press stop, whether the
  recording ran for one minute or forty, because parts upload while you are still
  recording.
- **Counts views**, including how many people watched to the end.

## Getting started

Requires Docker. Everything else runs in containers.

```bash
git clone https://github.com/TSKVenkat/osprey.git
cd osprey
cp .env.example .env

# SECRET_KEY encrypts storage credentials at rest, and has no default on purpose.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# put that in SECRET_KEY, and set ADMIN_EMAIL and ADMIN_PASSWORD

docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

Open <http://localhost:8080>, sign in, add a storage backend under **Settings**, and
record.

[**Installation**](docs/installation.md) covers running from source, upgrading, and
what to change before putting it on a network.

## Documentation

| | |
|---|---|
| [Installation](docs/installation.md) | Docker, from source, upgrading, going to production |
| [Configuration](docs/configuration.md) | Every environment variable and what it does |
| [Storage](docs/storage.md) | The four backends, what each actually supports, adding your own |
| [Architecture](docs/architecture.md) | How recording, processing and playback fit together |
| [HTTP API](docs/api.md) | The endpoints |
| [Roadmap](ROADMAP.md) | What is likely next, and what is deliberately not planned |

## How it is built

TypeScript throughout — Fastify 5, Drizzle, Postgres 17, pg-boss, React 19, ffmpeg
in the worker. Postgres is the only infrastructure: the job queue lives in the
database you already run. No Redis, no Kafka, no cloud dependency.

Storage backends sit behind one interface whose declared capabilities are checked
against measured behaviour by a shared conformance suite, so "pluggable storage" is
a property of the system rather than an intention.

## Contributing

Bug reports, fixes and new storage backends are welcome.
[CONTRIBUTING.md](CONTRIBUTING.md) covers getting it running, what a change is
expected to carry, and how to add a backend so it passes the conformance suite.

Security problems go through [SECURITY.md](SECURITY.md), never a public issue —
every instance is self-hosted, so a public report is a working attack on everyone
who has not updated yet.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

```bash
pnpm lint
pnpm typecheck
pnpm test        # unit and integration
pnpm test:e2e    # Playwright, against a running instance
```

All four run in CI against a real Postgres, real Chrome and real ffmpeg.

## Licence

[GNU Affero General Public License v3.0](LICENSE), and deliberately not MIT.

MIT would let a company take this, run it as a hosted service, improve it, and keep
those improvements to themselves. The AGPL closes that: section 13 extends copyleft
across the network, so anyone offering a modified version *as a service* has to
offer its users the modified source. Running it inside your own company, modified
however you like, is entirely fine — the obligation is to the people you serve it
to, and only when you serve it to them.

The interface links to its own source on every page, which is the mechanism the
licence itself suggests. If you run a modified copy, point `SOURCE_URL` in
`apps/web/src/components/SourceLink.tsx` at your fork.

    osprey — self-hosted screen recording with share links
    Copyright (C) 2026 TSKVenkat and osprey contributors

    This program is free software: you can redistribute it and/or modify it under
    the terms of the GNU Affero General Public License as published by the Free
    Software Foundation, either version 3 of the License, or (at your option) any
    later version.

    This program is distributed in the hope that it will be useful, but WITHOUT ANY
    WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
    PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License along
    with this program. If not, see <https://www.gnu.org/licenses/>.
