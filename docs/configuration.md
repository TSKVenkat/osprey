# Configuration

Everything is environment variables, read once at boot. A bad value fails the
process at startup rather than the first request that happens to touch it.

Storage backends are *not* configured here. They are added through **Settings** in
the running application, tested before they are saved, and their credentials are
encrypted at rest. See [storage](storage.md).

## Required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | `postgres://user:password@host:5432/database` |
| `SECRET_KEY` | 32 bytes, base64. Encrypts storage credentials at rest. **No default.** Changing it makes existing credentials unreadable. |

Generate the key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Addresses

| Variable | Default | Notes |
|---|---|---|
| `PUBLIC_API_URL` | `http://localhost:3000` | How a **browser** reaches this instance. Playback URLs are built from it. |
| `WEB_ORIGIN` | `http://localhost:5173` | Which origin may call the API. Comma-separated for more than one. |
| `PORT` | `3000` | What the API listens on inside its container. |

`PUBLIC_API_URL` is the setting worth reading twice. It is not where the API listens
— it is where a browser finds it. Running from source that is the API directly
(`http://localhost:3000`); behind compose everything arrives through the web
container (`http://localhost:8080`), which is why the compose file overrides it. A
value that is right for one topology and wrong for another produces recordings that
upload perfectly and then refuse to play.

## First account

| Variable | Notes |
|---|---|
| `ADMIN_EMAIL` | Used **once**, on an empty database. |
| `ADMIN_PASSWORD` | Same. Must satisfy `PASSWORD_MIN_LENGTH`. |

These create the first administrator and are then ignored. They cannot be used to
add an admin to a running instance — the bootstrap only fires when there are no
users at all. Changing them later does nothing; use **Settings → People**.

## Passwords

| Variable | Default | Notes |
|---|---|---|
| `PASSWORD_MIN_LENGTH` | `10` | The shortest password this instance accepts. |

Length does more for password strength than character classes, so length is the only
rule. Lowering this is a deliberate line in your own configuration, which is a
different thing from software that does not care — but do not lower it on anything
reachable from outside your own machine.

## Storage and retention

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_LOCAL_ROOT` | `./data/storage` | Where the local-disk backend writes. The API and worker must both see the same path. |
| `RETENTION_DAYS` | `7` | How long a deleted recording keeps its files before the sweeper removes them. |

## Published ports

Only the compose file reads these, and only to decide what to publish on the host.
Nothing inside the stack uses them.

| Variable | Default |
|---|---|
| `WEB_PORT` | `8080` |
| `POSTGRES_PORT` | `5432` |
| `MINIO_PORT` | `9000` |
| `MINIO_CONSOLE_PORT` | `9001` |

## Development only

| Variable | Notes |
|---|---|
| `NODE_ENV` | `development`, `test` or `production`. |
| `BCRYPT_ROUNDS` | Lowered by the test suite so it does not spend twelve seconds proving bcrypt is slow. Leave it alone anywhere else. |
