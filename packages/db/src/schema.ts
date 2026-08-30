import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Hashes and secrets are stored as hex/base64 text rather than bytea. It keeps the
// schema and the query code plain, and these columns are never used for arithmetic.

export const userRole = pgEnum('user_role', ['admin', 'user']);
export const connectorKind = pgEnum('connector_kind', [
  'local',
  's3',
  'cloudinary',
  'imagekit',
  'gdrive',
]);
export const recordingState = pgEnum('recording_state', [
  'draft',
  'uploading',
  'assembling',
  'processing',
  'ready',
  'failed',
  'abandoned',
]);
export const assetKind = pgEnum('asset_kind', [
  'original',
  'mp4_source',
  'poster',
  'sprite',
  'hls_manifest',
  'hls_segment',
]);
export const shareVisibility = pgEnum('share_visibility', [
  'private',
  'authenticated',
  'link',
  'password',
]);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Always stored lowercased, so a plain unique index gives case-insensitive emails.
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: userRole('role').notNull().default('user'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // sha256 of the cookie value, hex. The token itself is never stored.
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

export const storageConfigs = pgTable(
  'storage_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: connectorKind('kind').notNull(),
    label: text('label').notNull(),
    // Non-secret settings only: bucket, region, endpoint, folder id.
    config: jsonb('config').notNull(),
    // AES-256-GCM over the credential blob, all base64.
    secretCt: text('secret_ct').notNull(),
    secretIv: text('secret_iv').notNull(),
    secretTag: text('secret_tag').notNull(),
    // Measured by the /test round trip, not hand-declared.
    capabilities: jsonb('capabilities').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    status: text('status').notNull().default('untested'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one default, guaranteed by the database rather than by convention.
    uniqueIndex('storage_configs_one_default')
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
  ],
);

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('folders_owner_id_idx').on(t.ownerId)],
);

export const recordings = pgTable(
  'recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    storageConfigId: uuid('storage_config_id')
      .notNull()
      .references(() => storageConfigs.id),

    title: text('title').notNull().default('Untitled recording'),
    description: text('description'),
    state: recordingState('state').notNull().default('draft'),
    failureReason: text('failure_reason'),

    // Reported by the client at creation, then verified by ffprobe during processing.
    sourceMime: text('source_mime'),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    bytes: bigint('bytes', { mode: 'number' }),
    hasAudio: boolean('has_audio').notNull().default(false),
    recordedWith: jsonb('recorded_with'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('recordings_owner_created_idx')
      .on(t.ownerId, t.createdAt.desc())
      .where(sql`${t.deletedAt} is null`),
    index('recordings_created_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.deletedAt} is null`),
    // Stays small no matter how many recordings exist, so the sweeper scan is
    // proportional to work in flight rather than to the whole table.
    index('recordings_in_flight_idx')
      .on(t.state)
      .where(sql`${t.state} in ('uploading', 'processing')`),
  ],
);

export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    storageConfigId: uuid('storage_config_id')
      .notNull()
      .references(() => storageConfigs.id),
    // S3 uploadId, Drive session URI, Cloudinary unique id, or our own for local.
    providerRef: text('provider_ref').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    partSize: integer('part_size').notNull(),
    state: text('state').notNull().default('uploading'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('upload_sessions_recording_idx').on(t.recordingId),
    index('upload_sessions_in_flight_idx')
      .on(t.state, t.expiresAt)
      .where(sql`${t.state} = 'uploading'`),
  ],
);

export const uploadParts = pgTable(
  'upload_parts',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => uploadSessions.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    etag: text('etag').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    ackedAt: timestamp('acked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // This primary key is the idempotency mechanism: a repeated ack of the same part
  // is a no-op rather than a duplicate row.
  (t) => [primaryKey({ columns: [t.sessionId, t.partNumber] })],
);

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    kind: assetKind('kind').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    bitrateBps: integer('bitrate_bps'),
    // Set when the provider serves the file directly (ImageKit, Cloudinary).
    providerUrl: text('provider_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('media_assets_recording_kind_idx').on(t.recordingId, t.kind),
    uniqueIndex('media_assets_unique').on(t.recordingId, t.kind, t.objectKey),
  ],
);

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    // sha256 of the token, hex, used to look the link up.
    tokenHash: text('token_hash').notNull(),
    // The token itself, encrypted with the instance key so the owner can be shown
    // the link again later. A database dump on its own is not enough to replay it.
    tokenCt: text('token_ct').notNull(),
    tokenIv: text('token_iv').notNull(),
    tokenTag: text('token_tag').notNull(),
    visibility: shareVisibility('visibility').notNull().default('link'),
    passwordHash: text('password_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    allowDownload: boolean('allow_download').notNull().default(true),
    allowComments: boolean('allow_comments').notNull().default(true),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('share_links_token_hash_key').on(t.tokenHash),
    index('share_links_recording_idx').on(t.recordingId),
  ],
);

export const viewEvents = pgTable(
  'view_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    shareLinkId: uuid('share_link_id').references(() => shareLinks.id, { onDelete: 'set null' }),
    viewerId: uuid('viewer_id').references(() => users.id, { onDelete: 'set null' }),
    // Generated by the client so repeated flushes of the same view collapse.
    sessionKey: text('session_key').notNull(),
    watchedMs: integer('watched_ms').notNull().default(0),
    maxPositionMs: integer('max_position_ms').notNull().default(0),
    completed: boolean('completed').notNull().default(false),
    referrer: text('referrer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('view_events_dedupe').on(t.recordingId, t.sessionKey),
    index('view_events_recording_created_idx').on(t.recordingId, t.createdAt.desc()),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    // Used when someone comments through a link share without signing in.
    authorName: text('author_name'),
    body: text('body').notNull(),
    // Position in the video this comment refers to; null means a general comment.
    atMs: integer('at_ms'),
    parentId: uuid('parent_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('comments_recording_created_idx').on(t.recordingId, t.createdAt)],
);
