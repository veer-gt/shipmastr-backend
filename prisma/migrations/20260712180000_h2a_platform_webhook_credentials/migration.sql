CREATE TYPE "PlatformCredentialPurpose" AS ENUM ('PLATFORM_WEBHOOK_SIGNATURE');

CREATE TABLE "platform_webhook_credentials" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "platform" "StorePlatform" NOT NULL,
  "purpose" "PlatformCredentialPurpose" NOT NULL,
  "encrypted_current_value" TEXT,
  "current_nonce" TEXT,
  "current_auth_tag" TEXT,
  "encryption_key_version" TEXT,
  "configured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotated_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "encrypted_previous_value" TEXT,
  "previous_nonce" TEXT,
  "previous_auth_tag" TEXT,
  "previous_valid_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_webhook_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_webhook_credentials_connection_id_purpose_key"
  ON "platform_webhook_credentials"("connection_id", "purpose");
CREATE INDEX "platform_webhook_credentials_merchant_id_idx"
  ON "platform_webhook_credentials"("merchant_id");
CREATE INDEX "platform_webhook_credentials_connection_id_idx"
  ON "platform_webhook_credentials"("connection_id");
CREATE INDEX "platform_webhook_credentials_merchant_id_platform_idx"
  ON "platform_webhook_credentials"("merchant_id", "platform");

ALTER TABLE "platform_webhook_credentials"
  ADD CONSTRAINT "platform_webhook_credentials_connection_id_fkey"
  FOREIGN KEY ("connection_id") REFERENCES "platform_connections"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
