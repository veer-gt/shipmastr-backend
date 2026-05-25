ALTER TABLE "public"."CommunicationLog"
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "CommunicationLog_merchantId_idempotencyKey_key"
  ON "public"."CommunicationLog"("merchantId", "idempotencyKey");

CREATE INDEX "CommunicationLog_idempotencyKey_idx"
  ON "public"."CommunicationLog"("idempotencyKey");
