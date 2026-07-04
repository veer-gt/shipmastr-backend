CREATE TABLE "format_packs" (
  "id" TEXT NOT NULL,
  "pack_key" TEXT NOT NULL,
  "courier_code" TEXT,
  "source" TEXT NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "format_packs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "format_pack_versions" (
  "id" TEXT NOT NULL,
  "pack_id" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "definition" JSONB NOT NULL,
  "definition_hash" TEXT NOT NULL,
  "min_engine_version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "created_by" TEXT NOT NULL,
  "approved_by" TEXT,
  "activated_at" TIMESTAMP(3),
  "retired_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "format_pack_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "import_files" (
  "id" TEXT NOT NULL,
  "file_hash" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "counterparty" TEXT,
  "brand_org_id" TEXT,
  "period" TEXT,
  "storage_path" TEXT NOT NULL,
  "format_pack_id" TEXT,
  "format_pack_version_id" TEXT,
  "stated_total_minor" BIGINT,
  "status" TEXT NOT NULL DEFAULT 'landed',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "staging_rows" (
  "id" BIGSERIAL NOT NULL,
  "file_id" TEXT NOT NULL,
  "row_no" INTEGER NOT NULL,
  "raw" JSONB NOT NULL,
  "parsed" JSONB,
  "event_class" TEXT,
  "shipment_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'staged',
  "exception_code" TEXT,
  "exception_detail" JSONB,
  "posted_entry_ref" TEXT,
  CONSTRAINT "staging_rows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "format_pack_fixtures" (
  "id" TEXT NOT NULL,
  "pack_version_id" TEXT NOT NULL,
  "fixture_name" TEXT NOT NULL,
  "storage_path" TEXT NOT NULL,
  "expected_summary" JSONB NOT NULL,
  "expected_rows_path" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "format_pack_fixtures_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "format_pack_test_runs" (
  "id" TEXT NOT NULL,
  "pack_version_id" TEXT NOT NULL,
  "runner_version" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "format_pack_test_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "format_packs_pack_key_key" ON "format_packs"("pack_key");

CREATE UNIQUE INDEX "format_pack_versions_pack_id_version_key" ON "format_pack_versions"("pack_id", "version");
CREATE INDEX "format_pack_versions_pack_id_status_idx" ON "format_pack_versions"("pack_id", "status");
CREATE INDEX "format_pack_versions_definition_hash_idx" ON "format_pack_versions"("definition_hash");

CREATE UNIQUE INDEX "import_files_file_hash_key" ON "import_files"("file_hash");
CREATE INDEX "import_files_file_hash_idx" ON "import_files"("file_hash");
CREATE INDEX "import_files_status_idx" ON "import_files"("status");
CREATE INDEX "import_files_source_counterparty_period_idx" ON "import_files"("source", "counterparty", "period");
CREATE INDEX "import_files_format_pack_id_idx" ON "import_files"("format_pack_id");
CREATE INDEX "import_files_format_pack_version_id_idx" ON "import_files"("format_pack_version_id");

CREATE UNIQUE INDEX "staging_rows_file_id_row_no_key" ON "staging_rows"("file_id", "row_no");
CREATE INDEX "staging_rows_file_id_status_idx" ON "staging_rows"("file_id", "status");
CREATE INDEX "staging_rows_file_id_row_no_idx" ON "staging_rows"("file_id", "row_no");

CREATE INDEX "format_pack_fixtures_pack_version_id_idx" ON "format_pack_fixtures"("pack_version_id");
CREATE INDEX "format_pack_test_runs_pack_version_id_idx" ON "format_pack_test_runs"("pack_version_id");

ALTER TABLE "format_pack_versions" ADD CONSTRAINT "format_pack_versions_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "format_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_format_pack_id_fkey" FOREIGN KEY ("format_pack_id") REFERENCES "format_packs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_format_pack_version_id_fkey" FOREIGN KEY ("format_pack_version_id") REFERENCES "format_pack_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "staging_rows" ADD CONSTRAINT "staging_rows_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "import_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "format_pack_fixtures" ADD CONSTRAINT "format_pack_fixtures_pack_version_id_fkey" FOREIGN KEY ("pack_version_id") REFERENCES "format_pack_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "format_pack_test_runs" ADD CONSTRAINT "format_pack_test_runs_pack_version_id_fkey" FOREIGN KEY ("pack_version_id") REFERENCES "format_pack_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
