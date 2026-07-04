CREATE TABLE "import_correction_batches" (
  "id" TEXT NOT NULL,
  "import_file_id" TEXT NOT NULL,
  "old_format_pack_version_id" TEXT,
  "new_format_pack_version_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'planned',
  "dry_run_result" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "approved_by" TEXT,
  "applied_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_at" TIMESTAMP(3),
  "applied_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  CONSTRAINT "import_correction_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "import_correction_items" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "old_staging_row_id" BIGINT,
  "proposed_row_no" INTEGER,
  "old_posted_entry_ref" TEXT,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'planned',
  "old_fingerprint" TEXT,
  "new_fingerprint" TEXT,
  "diff" JSONB NOT NULL,
  "error_code" TEXT,
  "error_detail" JSONB,
  "reversal_entry_ref" TEXT,
  "corrected_entry_ref" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_correction_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "import_correction_batches_import_file_id_status_idx" ON "import_correction_batches"("import_file_id", "status");
CREATE INDEX "import_correction_batches_new_format_pack_version_id_idx" ON "import_correction_batches"("new_format_pack_version_id");
CREATE INDEX "import_correction_batches_old_format_pack_version_id_idx" ON "import_correction_batches"("old_format_pack_version_id");
CREATE INDEX "import_correction_batches_created_at_idx" ON "import_correction_batches"("created_at");

CREATE INDEX "import_correction_items_batch_id_action_idx" ON "import_correction_items"("batch_id", "action");
CREATE INDEX "import_correction_items_old_staging_row_id_idx" ON "import_correction_items"("old_staging_row_id");
CREATE INDEX "import_correction_items_old_posted_entry_ref_idx" ON "import_correction_items"("old_posted_entry_ref");

ALTER TABLE "import_correction_batches" ADD CONSTRAINT "import_correction_batches_import_file_id_fkey" FOREIGN KEY ("import_file_id") REFERENCES "import_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_correction_batches" ADD CONSTRAINT "import_correction_batches_old_format_pack_version_id_fkey" FOREIGN KEY ("old_format_pack_version_id") REFERENCES "format_pack_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "import_correction_batches" ADD CONSTRAINT "import_correction_batches_new_format_pack_version_id_fkey" FOREIGN KEY ("new_format_pack_version_id") REFERENCES "format_pack_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_correction_items" ADD CONSTRAINT "import_correction_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_correction_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "import_correction_items" ADD CONSTRAINT "import_correction_items_old_staging_row_id_fkey" FOREIGN KEY ("old_staging_row_id") REFERENCES "staging_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;
