-- Share links keep the token encrypted alongside its hash, so the owner can be
-- shown the link again without the database alone being enough to replay it.
--
-- Added with a default and then stripped of it, so the statement also works on a
-- table that already has rows. Any pre-existing link keeps an empty ciphertext and
-- simply cannot be re-displayed; it still resolves by hash.
ALTER TABLE "share_links" ADD COLUMN "token_ct" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "token_iv" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "token_tag" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "share_links" ALTER COLUMN "token_ct" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "share_links" ALTER COLUMN "token_iv" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "share_links" ALTER COLUMN "token_tag" DROP DEFAULT;
