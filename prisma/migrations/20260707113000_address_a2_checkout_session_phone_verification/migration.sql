CREATE TABLE "checkout_address_sessions" (
  "id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "cart_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'created',
  "provider" TEXT,
  "verification_handle_hash" TEXT,
  "verification_expires_at" TIMESTAMP(3),
  "verification_attempts" INTEGER NOT NULL DEFAULT 0,
  "phone_hash" TEXT,
  "phone_last2" TEXT,
  "profile_name" TEXT,
  "verified_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "checkout_address_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "checkout_address_sessions_status_chk"
    CHECK ("status" IN ('created', 'verification_started', 'verified', 'expired')),
  CONSTRAINT "checkout_address_sessions_provider_chk"
    CHECK ("provider" IS NULL OR "provider" IN ('otp', 'truecaller'))
);

CREATE UNIQUE INDEX "checkout_address_sessions_token_hash_key"
  ON "checkout_address_sessions"("token_hash");
CREATE INDEX "checkout_address_sessions_merchant_id_idx"
  ON "checkout_address_sessions"("merchant_id");
CREATE INDEX "checkout_address_sessions_cart_id_idx"
  ON "checkout_address_sessions"("cart_id");
CREATE INDEX "checkout_address_sessions_status_idx"
  ON "checkout_address_sessions"("status");
CREATE INDEX "checkout_address_sessions_provider_idx"
  ON "checkout_address_sessions"("provider");
CREATE INDEX "checkout_address_sessions_phone_hash_idx"
  ON "checkout_address_sessions"("phone_hash");
CREATE INDEX "checkout_address_sessions_expires_at_idx"
  ON "checkout_address_sessions"("expires_at");
CREATE INDEX "checkout_address_sessions_verification_expires_at_idx"
  ON "checkout_address_sessions"("verification_expires_at");

ALTER TABLE "checkout_address_sessions"
  ADD CONSTRAINT "checkout_address_sessions_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
