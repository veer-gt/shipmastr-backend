CREATE UNIQUE INDEX IF NOT EXISTS "format_pack_versions_one_active_per_pack_idx"
  ON "format_pack_versions"("pack_id")
  WHERE "status" = 'active';
