CREATE TABLE "shopper_identities" (
  "id" TEXT NOT NULL,
  "phone_hash" TEXT NOT NULL,
  "phone_last2" TEXT NOT NULL,
  "tc_verified" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shopper_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shopper_addresses" (
  "id" TEXT NOT NULL,
  "shopper_id" TEXT NOT NULL,
  "full_name" TEXT NOT NULL,
  "line1" TEXT NOT NULL,
  "line1_norm" TEXT NOT NULL,
  "line2" TEXT,
  "landmark" TEXT,
  "pincode" VARCHAR(6) NOT NULL,
  "city" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "lat" DECIMAL(10,7),
  "lng" DECIMAL(10,7),
  "place_id" TEXT,
  "source" TEXT NOT NULL,
  "quality" INTEGER NOT NULL DEFAULT 0,
  "use_count" INTEGER NOT NULL DEFAULT 1,
  "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "first_merchant_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "shopper_addresses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "shopper_addresses_pincode_chk" CHECK ("pincode" ~ '^[0-9]{6}$'),
  CONSTRAINT "shopper_addresses_source_chk"
    CHECK ("source" IN ('manual', 'places', 'truecaller', 'network_prefill')),
  CONSTRAINT "shopper_addresses_quality_chk" CHECK ("quality" BETWEEN 0 AND 3)
);

CREATE TABLE "address_consents" (
  "id" TEXT NOT NULL,
  "shopper_id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT 'checkout_prefill',
  "consent_text_version" TEXT NOT NULL,
  "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),

  CONSTRAINT "address_consents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "address_consents_scope_chk" CHECK ("scope" IN ('merchant', 'network'))
);

CREATE UNIQUE INDEX "shopper_identities_phone_hash_key"
  ON "shopper_identities"("phone_hash");
CREATE INDEX "shopper_addresses_shopper_id_last_used_at_idx"
  ON "shopper_addresses"("shopper_id", "last_used_at");
CREATE INDEX "shopper_addresses_shopper_id_pincode_idx"
  ON "shopper_addresses"("shopper_id", "pincode");
CREATE INDEX "shopper_addresses_first_merchant_id_idx"
  ON "shopper_addresses"("first_merchant_id");
CREATE INDEX "address_consents_shopper_id_scope_idx"
  ON "address_consents"("shopper_id", "scope");
CREATE INDEX "address_consents_merchant_id_idx"
  ON "address_consents"("merchant_id");
CREATE INDEX "address_consents_revoked_at_idx"
  ON "address_consents"("revoked_at");

ALTER TABLE "shopper_addresses"
  ADD CONSTRAINT "shopper_addresses_shopper_id_fkey"
  FOREIGN KEY ("shopper_id") REFERENCES "shopper_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "address_consents"
  ADD CONSTRAINT "address_consents_shopper_id_fkey"
  FOREIGN KEY ("shopper_id") REFERENCES "shopper_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
