CREATE TYPE "PlatformCredentialProvider" AS ENUM ('SHOPIFY', 'WOOCOMMERCE', 'MAGENTO', 'CUSTOM');

CREATE TYPE "PlatformCredentialType" AS ENUM ('SHOPIFY_CUSTOM_APP_TOKEN', 'SHOPIFY_OAUTH_PLACEHOLDER', 'WOOCOMMERCE_REST_KEYS', 'MAGENTO_INTEGRATION_TOKEN', 'CUSTOM_API_KEY', 'WEBHOOK_SECRET');

CREATE TYPE "PlatformCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ROTATED', 'EXPIRED');

CREATE TABLE "platform_credentials" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "platform" "PlatformCredentialProvider" NOT NULL,
  "credential_type" "PlatformCredentialType" NOT NULL,
  "name" TEXT NOT NULL,
  "status" "PlatformCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
  "secret_ref" TEXT NOT NULL,
  "secret_fingerprint" TEXT NOT NULL,
  "safe_metadata" JSONB,
  "last_used_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotated_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),

  CONSTRAINT "platform_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_credential_secrets" (
  "id" TEXT NOT NULL,
  "credential_id" TEXT NOT NULL,
  "encrypted_value" TEXT NOT NULL,
  "encryption_version" TEXT NOT NULL DEFAULT 'local-aes-256-gcm-v1',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_credential_secrets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_credentials_secret_ref_key" ON "platform_credentials"("secret_ref");
CREATE INDEX "platform_credentials_merchant_id_platform_idx" ON "platform_credentials"("merchant_id", "platform");
CREATE INDEX "platform_credentials_merchant_id_status_idx" ON "platform_credentials"("merchant_id", "status");
CREATE INDEX "platform_credentials_credential_type_idx" ON "platform_credentials"("credential_type");
CREATE INDEX "platform_credentials_expires_at_idx" ON "platform_credentials"("expires_at");

CREATE UNIQUE INDEX "platform_credential_secrets_credential_id_key" ON "platform_credential_secrets"("credential_id");
CREATE INDEX "platform_credential_secrets_credential_id_idx" ON "platform_credential_secrets"("credential_id");
