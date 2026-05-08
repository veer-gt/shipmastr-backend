ALTER TABLE "Lead" ADD COLUMN "merchantId" TEXT;

CREATE INDEX "Lead_merchantId_idx" ON "Lead"("merchantId");

ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_merchantId_fkey"
  FOREIGN KEY ("merchantId")
  REFERENCES "Merchant"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
