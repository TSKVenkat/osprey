# Contributing

Bug reports, fixes and new storage backends are all welcome. This file is the
short version of how the project is built and what a change is expected to carry
with it.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting it running

You need Node 24 or newer, pnpm 10, Docker, and ffmpeg on your PATH for the
worker tests.

```bash
pnpm install
cp .env.example .env
# SECRET_KEY encrypts storage credentials at rest and has no default on purpose.
node -e "console.log('SECRET_KEY=' + require('crypto').randomBytes(32).toString('base64'))" >> .env

docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

That is the whole instance on <http://localhost:8080>: web, API, worker, Postgres
and MinIO. Sign in with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` from your `.env` —
the first admin is created once, on an empty database.

To run the apps from source instead, `pnpm dev` starts the API on 3000 and the web
app on 5173, with the web app proxying `/v1` to the API so the session cookie stays
same-origin.

## The checks

```bash
pnpm lint         # eslint
pnpm typecheck    # tsc across every package
pnpm test         # unit and integration, ~320 of them
pnpm e2e          # Playwright, needs a running instance
```

All four run in CI against a real Postgres, real Chrome and real ffmpeg. The
integration tests use PGlite — Postgres compiled to WebAssembly — so they exercise
real SQL, real constraints and real transactions without a container.

Two things about the browser tests. They need an instance to point at:
`E2E_WEB_URL=http://localhost:8080 pnpm e2e` against a compose deployment, or the
default 5173 against `pnpm dev`. And four of them import application modules
directly, so they only run against the dev server and skip against a production
build — that is deliberate, not a failure.

## What a change is expected to carry

**A test that fails without it.** For a bug fix, write the test first and watch it
fail with the same message production gave. Several tests in this repository say in
a comment exactly which bug they were written against and what the symptom was;
that is the standard.

**A commit message that explains why.** What changed is in the diff. What is worth
writing down is the reasoning: what was wrong, why the obvious fix was not the one
taken, what a future reader would otherwise have to rediscover. Subject line in the
imperative, body wrapped at 80.

**Comments that explain decisions, not mechanics.** `// increment the counter` is
noise. A note saying why a fixed staging directory is correct where `mkdtemp` is
wrong is worth its lines, because the wrong version looks right.

Do not add AI or attribution trailers to commits or pull requests.

## Adding a storage backend

Implement `StorageConnector` from `packages/storage/src/types.ts` and run the
conformance suite against it:

```ts
runConformanceSuite('your backend', async () => ({
  connector: makeYourConnector(),
  fresh: () => makeYourConnector(),
  cleanup: async () => { /* remove what the test left behind */ },
}));
```

The suite is what makes "pluggable storage" a property of the system rather than an
intention. A backend is finished when it passes — including the test that rebuilds
the connector between every call, because the API constructs one per request and a
connector that keeps upload state in a field works in a test and fails in
production. That exact bug shipped once.

Declare capabilities honestly. `immediatelyConsistent: false` and
`directUpload: false` are checked against what the backend actually did, and
claiming otherwise fails the suite rather than producing a subtle bug later.

## Pull requests

Branch off `main`, keep the pull request to one subject, and say in the description
what was verified and how. Small and explained beats large and assumed. CI has to
be green before review.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
