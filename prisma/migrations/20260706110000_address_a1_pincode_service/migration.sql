CREATE TABLE IF NOT EXISTS "address_pincodes" (
  "pincode" VARCHAR(6) NOT NULL,
  "city" VARCHAR(120) NOT NULL,
  "district" VARCHAR(120) NOT NULL,
  "state" VARCHAR(120) NOT NULL,
  "localities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lat" DECIMAL(10, 7),
  "lng" DECIMAL(10, 7),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "address_pincodes_pkey" PRIMARY KEY ("pincode"),
  CONSTRAINT "address_pincodes_pincode_digits_chk" CHECK ("pincode" ~ '^[0-9]{6}$')
);

CREATE INDEX IF NOT EXISTS "address_pincodes_state_idx" ON "address_pincodes"("state");
CREATE INDEX IF NOT EXISTS "address_pincodes_district_idx" ON "address_pincodes"("district");
