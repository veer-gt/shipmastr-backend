CREATE TYPE "SecurityFixtureKind" AS ENUM ('H2A_STAGING_CROSS_TENANT');

CREATE TYPE "SecurityFixtureStatus" AS ENUM ('CREATING', 'ACTIVE', 'CLEANING', 'CLEANED', 'FAILED', 'EXPIRED');

CREATE TABLE "security_fixture_tenants" (
    "id" TEXT NOT NULL,
    "fixture_kind" "SecurityFixtureKind" NOT NULL,
    "status" "SecurityFixtureStatus" NOT NULL DEFAULT 'CREATING',
    "active_slot" TEXT,
    "merchant_id" TEXT,
    "owner_user_id" TEXT,
    "creator_internal_user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "cleanup_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_fixture_tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "security_fixture_tenants_active_slot_key" ON "security_fixture_tenants"("active_slot");
CREATE UNIQUE INDEX "security_fixture_tenants_merchant_id_key" ON "security_fixture_tenants"("merchant_id");
CREATE UNIQUE INDEX "security_fixture_tenants_owner_user_id_key" ON "security_fixture_tenants"("owner_user_id");
CREATE INDEX "security_fixture_tenants_fixture_kind_status_idx" ON "security_fixture_tenants"("fixture_kind", "status");
CREATE INDEX "security_fixture_tenants_expires_at_idx" ON "security_fixture_tenants"("expires_at");

ALTER TABLE "security_fixture_tenants"
  ADD CONSTRAINT "security_fixture_tenants_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "security_fixture_tenants"
  ADD CONSTRAINT "security_fixture_tenants_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "security_fixture_tenants"
  ADD CONSTRAINT "security_fixture_tenants_creator_internal_user_id_fkey"
  FOREIGN KEY ("creator_internal_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
