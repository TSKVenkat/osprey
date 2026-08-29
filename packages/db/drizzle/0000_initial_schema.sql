CREATE TYPE "public"."asset_kind" AS ENUM('original', 'mp4_source', 'poster', 'sprite', 'hls_manifest', 'hls_segment');--> statement-breakpoint
CREATE TYPE "public"."connector_kind" AS ENUM('local', 's3', 'cloudinary', 'imagekit', 'gdrive');--> statement-breakpoint
CREATE TYPE "public"."recording_state" AS ENUM('draft', 'uploading', 'assembling', 'processing', 'ready', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."share_visibility" AS ENUM('private', 'authenticated', 'link', 'password');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"author_id" uuid,
	"author_name" text,
	"body" text NOT NULL,
	"at_ms" integer,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"bitrate_bps" integer,
	"provider_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"folder_id" uuid,
	"storage_config_id" uuid NOT NULL,
	"title" text DEFAULT 'Untitled recording' NOT NULL,
	"description" text,
	"state" "recording_state" DEFAULT 'draft' NOT NULL,
	"failure_reason" text,
	"source_mime" text,
	"duration_ms" integer,
	"width" integer,
	"height" integer,
	"bytes" bigint,
	"has_audio" boolean DEFAULT false NOT NULL,
	"recorded_with" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"visibility" "share_visibility" DEFAULT 'link' NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"allow_download" boolean DEFAULT true NOT NULL,
	"allow_comments" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "connector_kind" NOT NULL,
	"label" text NOT NULL,
	"config" jsonb NOT NULL,
	"secret_ct" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'untested' NOT NULL,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_parts" (
	"session_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"etag" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"acked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_parts_session_id_part_number_pk" PRIMARY KEY("session_id","part_number")
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"storage_config_id" uuid NOT NULL,
	"provider_ref" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"part_size" integer NOT NULL,
	"state" text DEFAULT 'uploading' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "view_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "view_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"recording_id" uuid NOT NULL,
	"share_link_id" uuid,
	"viewer_id" uuid,
	"session_key" text NOT NULL,
	"watched_ms" integer DEFAULT 0 NOT NULL,
	"max_position_ms" integer DEFAULT 0 NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"referrer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_storage_config_id_storage_configs_id_fk" FOREIGN KEY ("storage_config_id") REFERENCES "public"."storage_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_parts" ADD CONSTRAINT "upload_parts_session_id_upload_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."upload_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_storage_config_id_storage_configs_id_fk" FOREIGN KEY ("storage_config_id") REFERENCES "public"."storage_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_events" ADD CONSTRAINT "view_events_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_events" ADD CONSTRAINT "view_events_share_link_id_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_events" ADD CONSTRAINT "view_events_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_recording_created_idx" ON "comments" USING btree ("recording_id","created_at");--> statement-breakpoint
CREATE INDEX "folders_owner_id_idx" ON "folders" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "media_assets_recording_kind_idx" ON "media_assets" USING btree ("recording_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_unique" ON "media_assets" USING btree ("recording_id","kind","object_key");--> statement-breakpoint
CREATE INDEX "recordings_owner_created_idx" ON "recordings" USING btree ("owner_id","created_at" DESC NULLS LAST) WHERE "recordings"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "recordings_created_idx" ON "recordings" USING btree ("created_at" DESC NULLS LAST) WHERE "recordings"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "recordings_in_flight_idx" ON "recordings" USING btree ("state") WHERE "recordings"."state" in ('uploading', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_hash_key" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_links_recording_idx" ON "share_links" USING btree ("recording_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_configs_one_default" ON "storage_configs" USING btree ("is_default") WHERE "storage_configs"."is_default";--> statement-breakpoint
CREATE INDEX "upload_sessions_recording_idx" ON "upload_sessions" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_in_flight_idx" ON "upload_sessions" USING btree ("state","expires_at") WHERE "upload_sessions"."state" = 'uploading';--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "view_events_dedupe" ON "view_events" USING btree ("recording_id","session_key");--> statement-breakpoint
CREATE INDEX "view_events_recording_created_idx" ON "view_events" USING btree ("recording_id","created_at" DESC NULLS LAST);