# 04 — Data Model

> Postgres 17 + Drizzle. **Single-tenant**: one instance, one team. Users own recordings directly;
> there is no workspace/organisation layer. Types shown as SQL for clarity; the source of truth is
> `packages/db/schema.ts`.

---

## 1. Entity map

```
user ──┬── session                  (login)
       ├── recording ──┬── upload_session ──── upload_part
       │               ├── media_asset          (renditions)
       │               ├── share_link ───────── view_event
       │               └── comment
       └── folder

storage_config                      (instance-level, admin-managed)
```

---

## 2. Tables

### Users and sessions

Email + password with bcrypt. No OAuth, no magic links, no external auth service — the simplest
thing that is correct.

```sql
CREATE TYPE user_role AS ENUM ('admin','user');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,          -- bcrypt, cost 12
  name          text NOT NULL,
  role          user_role NOT NULL DEFAULT 'user',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL,          -- sha256 of the cookie value; the token is never stored
  user_agent   text,
  ip           inet,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON sessions (token_hash);
CREATE INDEX ON sessions (user_id);
CREATE INDEX ON sessions (expires_at);          -- expired-session sweeper
```

**Why bcrypt and not argon2id:** `bcrypt` is one dependency, has no tuning parameters to get wrong,
and is fine at cost 12. Password hashing is not where this application's risk lives.

**Why a sessions table and not a JWT:** logout has to actually work, and an admin disabling a user
has to take effect immediately. A row you can delete does that; a signed token does not.

### Roles — least privilege

Two roles, and the default is the weaker one.

| Action | `user` | `admin` | anonymous |
|---|:--:|:--:|:--:|
| Record + upload | ✅ | ✅ | ❌ |
| Read / edit / delete **own** recording | ✅ | ✅ | ❌ |
| Read / delete **any** recording | ❌ | ✅ | ❌ |
| Create share link for own recording | ✅ | ✅ | ❌ |
| View a valid share link | ✅ | ✅ | ✅ |
| Comment on a recording they can view | ✅ | ✅ | if the link allows |
| Create / disable users | ❌ | ✅ | ❌ |
| Configure storage | ❌ | ✅ | ❌ |
| Read storage credentials | ❌ | ❌ | ❌ |

Nobody reads storage credentials — not even an admin. They are write-only through the API.

Ownership is checked in one place (`requireOwnerOrAdmin`), not scattered through handlers.

### Storage configuration

Instance-level and admin-managed: the operator points the instance at one storage backend, with
others available as alternatives.

```sql
CREATE TYPE connector_kind AS ENUM ('local','s3','cloudinary','imagekit','gdrive');

CREATE TABLE storage_configs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           connector_kind NOT NULL,
  label          text NOT NULL,
  config         jsonb NOT NULL,     -- NON-SECRET only: region, bucket, endpoint, folder id
  secret_ct      bytea NOT NULL,     -- AES-256-GCM ciphertext of the credential blob
  secret_iv      bytea NOT NULL,
  secret_tag     bytea NOT NULL,
  capabilities   jsonb NOT NULL,     -- measured by the /test round trip, not hand-declared
  is_default     boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'untested',   -- untested | ok | failing
  last_tested_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_default_storage ON storage_configs ((is_default)) WHERE is_default;
```

That partial unique index makes "exactly one default" a database guarantee rather than an
application convention.

**Rule enforced in code and in review:** nothing secret ever enters `config`. The split exists so
`config` can be returned by the API while `secret_*` has no read path at all.

### Recordings

```sql
CREATE TYPE recording_state AS ENUM
  ('draft','uploading','assembling','processing','ready','failed','abandoned');

CREATE TABLE folders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON folders (owner_id);

CREATE TABLE recordings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id         uuid REFERENCES folders(id) ON DELETE SET NULL,
  storage_config_id uuid NOT NULL REFERENCES storage_configs(id),

  title             text NOT NULL DEFAULT 'Untitled recording',
  description       text,
  state             recording_state NOT NULL DEFAULT 'draft',
  failure_reason    text,

  -- client-reported at creation, then verified by ffprobe
  source_mime       text,
  duration_ms       integer,
  width             integer,
  height            integer,
  bytes             bigint,
  has_audio         boolean NOT NULL DEFAULT false,
  recorded_with     jsonb,             -- {browser, os, mimeType, systemAudio}

  created_at        timestamptz NOT NULL DEFAULT now(),
  ready_at          timestamptz,
  deleted_at        timestamptz
);

CREATE INDEX ON recordings (owner_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON recordings (created_at DESC)           WHERE deleted_at IS NULL;  -- admin list
CREATE INDEX ON recordings (state) WHERE state IN ('uploading','processing');
```

`storage_config_id` is pinned at creation, so changing the instance default never orphans existing
recordings.

That last **partial index** is the sweeper's index: it stays tiny (only in-flight rows) no matter how
many recordings exist, so the GC scan is O(in-flight), not O(all).

### Upload sessions and parts

```sql
CREATE TABLE upload_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id      uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  storage_config_id uuid NOT NULL REFERENCES storage_configs(id),
  provider_ref      text NOT NULL,     -- S3 uploadId | Drive session URI | Cloudinary id
  object_key        text NOT NULL,
  content_type      text NOT NULL,
  part_size         integer NOT NULL,
  state             text NOT NULL DEFAULT 'uploading',
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON upload_sessions (state, expires_at) WHERE state = 'uploading';

CREATE TABLE upload_parts (
  session_id  uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number integer NOT NULL CHECK (part_number >= 1),
  etag        text NOT NULL,
  bytes       integer NOT NULL CHECK (bytes > 0),
  sha256      text NOT NULL,
  acked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, part_number)      -- duplicate delivery is a no-op (F4)
);
```

The composite primary key **is** the idempotency mechanism. A repeated ack with a matching `sha256`
returns the stored ETag; a mismatched `sha256` for the same part number is a hard error
(`UPLOAD_PART_MISMATCH`) — two different byte sequences claimed the same slot, which is corruption,
not a retry.

Density check at commit, one query:

```sql
SELECT count(*) AS n, max(part_number) AS hi, sum(bytes) AS total
FROM upload_parts WHERE session_id = $1;
-- require n = hi  (dense 1..n, no gaps)
```

### Media assets (renditions)

```sql
CREATE TYPE asset_kind AS ENUM
  ('original','mp4_source','poster','sprite','hls_manifest','hls_segment');

CREATE TABLE media_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  kind         asset_kind NOT NULL,
  object_key   text NOT NULL,
  content_type text NOT NULL,
  bytes        bigint NOT NULL,
  width        integer, height integer, duration_ms integer, bitrate_bps integer,
  provider_url text,                   -- set when the provider serves it (ImageKit/Cloudinary)
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recording_id, kind, object_key)
);
CREATE INDEX ON media_assets (recording_id, kind);
```

`original` is never deleted by processing — reprocessing must always be possible from source.

### Sharing

```sql
CREATE TYPE share_visibility AS ENUM ('private','authenticated','link','password');

CREATE TABLE share_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id   uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  token_hash     bytea NOT NULL,       -- sha256(token). The token itself is NEVER stored (F9)
  visibility     share_visibility NOT NULL DEFAULT 'link',
  password_hash  text,                 -- bcrypt, only when visibility = 'password'
  expires_at     timestamptz,
  allow_download boolean NOT NULL DEFAULT true,
  allow_comments boolean NOT NULL DEFAULT true,
  created_by     uuid NOT NULL REFERENCES users(id),
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON share_links (token_hash);
CREATE INDEX ON share_links (recording_id);
```

Tokens are 256 bits from `crypto.randomBytes(32)`, base64url, stored hashed — a database leak hands
out nothing playable.

### Engagement

```sql
CREATE TABLE view_events (
  id              bigserial,
  recording_id    uuid NOT NULL,
  share_link_id   uuid,
  viewer_id       uuid,                -- null for anonymous
  session_key     text NOT NULL,       -- client-generated; dedupe key (F14)
  watched_ms      integer NOT NULL DEFAULT 0,
  max_position_ms integer NOT NULL DEFAULT 0,
  completed       boolean NOT NULL DEFAULT false,
  referrer        text,
  created_at      timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE UNIQUE INDEX ON view_events (recording_id, session_key, created_at);
CREATE INDEX ON view_events (recording_id, created_at DESC);

CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  author_id    uuid REFERENCES users(id),
  author_name  text,                   -- anonymous commenter on a link share
  body         text NOT NULL,
  at_ms        integer,                -- timestamped comment; null = general
  parent_id    uuid REFERENCES comments(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX ON comments (recording_id, created_at);
```

`view_events` is partitioned monthly from day one. It is the only table with unbounded growth, and
retrofitting partitioning onto a large table is painful — doing it now costs one extra migration.

---

## 3. Object key layout

```
r/{recordingId}/original.{ext}
r/{recordingId}/mp4/{sha256[:16]}.mp4
r/{recordingId}/poster/{sha256[:16]}.webp
r/{recordingId}/hls/{sha256[:16]}/master.m3u8
```

The content-addressed leaf makes every rendition URL immutable → `Cache-Control: public,
max-age=31536000, immutable` → the CDN serves it forever and reprocessing never needs a purge.

---

## 4. Access patterns → index justification

| Query | Frequency | Index used |
|---|---|---|
| My recordings, newest first | Very high | `recordings (owner_id, created_at DESC) WHERE deleted_at IS NULL` |
| Resolve a share token | Very high (public) | `share_links (token_hash)` unique |
| Resolve a session cookie | Every request | `sessions (token_hash)` unique |
| Ack a part | High (~n per recording) | `upload_parts` PK |
| Commit density check | Once per recording | `upload_parts` PK (index-only scan) |
| Sweeper scan | Every 15 min | `upload_sessions (state, expires_at) WHERE state='uploading'` |
| Recording detail + assets | High | `media_assets (recording_id, kind)` |
| Admin: all recordings | Low | `recordings (created_at DESC) WHERE deleted_at IS NULL` |

**Pagination is keyset, never `OFFSET`:**

```sql
WHERE owner_id = $1 AND deleted_at IS NULL AND (created_at, id) < ($cursorTs, $cursorId)
ORDER BY created_at DESC, id DESC LIMIT 25;
```

`OFFSET 10000` makes Postgres walk 10 000 rows to discard them. Keyset stays O(limit) forever.

---

## 5. Migration ordering

| # | Migration |
|---|---|
| 0001 | `users`, `sessions` |
| 0002 | `storage_configs` |
| 0003 | `folders`, `recordings` |
| 0004 | `upload_sessions`, `upload_parts` |
| 0005 | `media_assets` |
| 0006 | `share_links`, `view_events` (partitioned) + first partitions |
| 0007 | `comments` |

Rules: forward-only, additive, never `DROP COLUMN` in the same release that stops writing it
(expand → migrate → contract). Every migration must be runnable against a database with data.

---

## 6. First-run bootstrap

On an empty database the API creates nothing automatically. `pnpm bootstrap` (or
`ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars on first boot) creates the single admin account. Open
sign-up is **off** by default — an admin invites users. An instance that self-registers admins is an
instance anyone on the internet can take over.
