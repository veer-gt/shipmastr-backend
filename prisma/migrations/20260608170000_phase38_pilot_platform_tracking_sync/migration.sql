-- Add pilot-gated platform tracking sync attempt metadata.
-- This remains public-safe metadata only; no raw platform responses, headers, or credentials are stored.

ALTER TABLE "platform_tracking_syncs"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'DRY_RUN',
  ADD COLUMN "safe_meta" JSONB;
