# HTTP API

Everything is JSON over `/v1`. Authentication is a session cookie, so calls are made
with `credentials: 'same-origin'` and `WEB_ORIGIN` decides which origins may make
them. There is no bearer token yet — see the [roadmap](../ROADMAP.md).

Errors come back as `{ "error": { "code", "message", "retryable", "fields"? } }`.
Asking for somebody else's recording returns **404, not 403**, so the endpoint does
not confirm that an id exists.

## Sessions

| | |
|---|---|
| `POST /v1/auth/login` | `{ email, password }`. Rate limited per address *and* account, so one office behind one address cannot lock each other out. |
| `POST /v1/auth/logout` | |
| `POST /v1/auth/password` | Change your own. |
| `GET /v1/auth/me` | Who you are, and your role. |

## Recordings

| | |
|---|---|
| `GET /v1/recordings` | Your recordings, newest first. `?limit=`, `?cursor=`, and `?all=1` for admins. Includes a poster URL per recording. |
| `GET /v1/recordings/:id` | Detail, assets, a playable URL and a poster URL. |
| `POST /v1/recordings` | Start a recording and its upload session. |
| `PATCH /v1/recordings/:id` | Rename, or set a description. |
| `DELETE /v1/recordings/:id` | Soft delete. Files go after `RETENTION_DAYS`. |

Paging is keyset: `nextCursor` is opaque, pass it back as `?cursor=`.

## Uploading

Parts are numbered from 1 and may be sent in any order and more than once — sending
the same part twice is a normal thing for a retrying client to do.

| | |
|---|---|
| `POST /v1/uploads/:id/parts/:n/target` | Where to send one part. Either a signed URL for the provider, or an instruction to proxy. |
| `PUT /v1/uploads/:id/parts/:n` | Send one part through the API. |
| `POST /v1/uploads/:id/parts/:n/ack` | Confirm a part that went directly to the provider. |
| `POST /v1/uploads/:id/complete` | Commit. Returns as soon as the object exists. Completing twice is safe. |
| `POST /v1/uploads/:id/abort` | Give up and clean up. |
| `GET /v1/uploads/:id` | What has landed so far — this is what crash recovery reads. |

## Sharing

| | |
|---|---|
| `POST /v1/recordings/:id/shares` | `{ visibility: 'link' \| 'password' \| 'authenticated', password? }` |
| `GET /v1/recordings/:id/shares` | Existing links, including their URLs. |
| `DELETE /v1/shares/:id` | Revoke. Takes effect immediately. |
| `GET /v1/recordings/:id/views` | View and completion counts, for the owner. |

### Public, no account needed

| | |
|---|---|
| `GET /v1/shares/:token` | Open a shared recording. `403` means it wants a password. |
| `POST /v1/shares/:token/unlock` | `{ password }` |
| `POST /v1/shares/:token/views` | Watch progress. One viewing counts once, not once per report. |

## Administration

Requires the `admin` role.

| | |
|---|---|
| `GET /v1/admin/users` | |
| `POST /v1/admin/users` | `{ email, name, password, role }` |
| `PATCH /v1/admin/users/:id` | Name, role, or active. Changing role or disabling revokes every session that user holds. |
| `POST /v1/admin/users/:id/reset-password` | |
| `GET /v1/admin/storage` | Configurations, never their credentials. |
| `POST /v1/admin/storage` | Tested before it is saved; `makeDefault` starts using it. |
| `POST /v1/admin/storage/:id/test` | Write, read back, delete. Transient network failures are retried. |
| `POST /v1/admin/storage/:id/default` | Re-tested at the moment it starts mattering. |
| `DELETE /v1/admin/storage/:id` | Refused while recordings still point at it. |

## Files

| | |
|---|---|
| `GET /files/:storageId/*` | Signed reads for the local-disk backend. Supports range requests. |
