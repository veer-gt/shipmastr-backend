-- Scope idempotency keys to the authenticated merchant and route so two
-- merchants can safely reuse the same client-generated key.
ALTER TABLE "IdempotencyKey" ADD COLUMN "merchantId" TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE "IdempotencyKey" DROP CONSTRAINT IF EXISTS "IdempotencyKey_key_key";

CREATE UNIQUE INDEX "IdempotencyKey_merchantId_route_key_key"
  ON "IdempotencyKey"("merchantId", "route", "key");

CREATE INDEX "IdempotencyKey_merchantId_idx" ON "IdempotencyKey"("merchantId");

ALTER TABLE "IdempotencyKey" ALTER COLUMN "merchantId" DROP DEFAULT;
