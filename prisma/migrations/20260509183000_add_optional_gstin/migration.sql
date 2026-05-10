ALTER TABLE "public"."Merchant" ADD COLUMN "gstin" TEXT;
ALTER TABLE "public"."CourierPartner" ADD COLUMN "gstin" TEXT;

CREATE INDEX "Merchant_gstin_idx" ON "public"."Merchant"("gstin");
CREATE INDEX "CourierPartner_gstin_idx" ON "public"."CourierPartner"("gstin");
