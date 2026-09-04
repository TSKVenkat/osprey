# Security

## Reporting a vulnerability

Report it privately through
[GitHub's advisory form](https://github.com/TSKVenkat/osprey/security/advisories/new).
It reaches the maintainers and nobody else.

Please do not open a public issue. Every instance of this software is self-hosted,
which means a public report is a working description of how to attack every
deployment that has not updated yet.

Include what you did, what happened, and what you expected. A proof of concept
helps; so does the version or commit. You will get an acknowledgement within a few
days and an honest answer about whether and when it will be fixed. If it is a real
issue you will be credited in the advisory unless you would rather not be.

## What is in scope

This is self-hosted software with no hosted service behind it, so the scope is the
code in this repository: the API, the worker, the web app, the storage connectors,
and the deployment files.

Particularly interesting:

- Anything that lets one account read, modify or delete another account's
  recordings.
- Anything that makes a share link readable without the password or sign-in it was
  created with, or that makes a revoked link work again.
- Anything that leaks storage credentials. They are encrypted at rest and no
  endpoint returns them, not even to an administrator.
- Anything that escapes the storage root through a crafted object key.
- Anything that turns an upload into arbitrary writes or arbitrary reads on the
  server.

Out of scope: findings that require an administrator to already be malicious (an
administrator can configure storage and therefore already controls where bytes go),
denial of service by simply sending a great deal of data, and the deliberately weak
defaults described below.

## Defaults that are for development only

The compose file ships credentials so that `docker compose up` works with nothing
to fill in first. They are not a secret and are not meant to leave your machine:

- Postgres: `osprey` / `osprey`
- MinIO: `osprey` / `osprey123`
- The first admin, from `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your `.env`

Before putting an instance anywhere reachable, change all of them, set a real
`SECRET_KEY`, and put it behind TLS. `SECRET_KEY` encrypts storage credentials at
rest, and changing it later makes existing credentials unreadable.

## What the software does on its own

Passwords are hashed with bcrypt. Sessions are cookies, not bearer tokens, so the
API is called with `credentials: same-origin` and `WEB_ORIGIN` decides who may call
it. Login is rate limited per address *and* account, so one office behind one
address cannot lock each other out. Storage credentials are sealed with AES-GCM
under `SECRET_KEY` and are never returned by any endpoint.

Share links are unguessable tokens. A password-protected link is checked
server-side, and a revoked one stops working immediately rather than at the end of
a cache window.

## Supported versions

`main` is what gets fixed. There are no release branches yet; when there are, this
section will say which of them are still receiving fixes.
