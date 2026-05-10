ALTER TABLE "CourierPartner" ADD COLUMN "serviceCodeType" TEXT NOT NULL DEFAULT 'SAC';
ALTER TABLE "CourierPartner" ADD COLUMN "serviceCode" TEXT NOT NULL DEFAULT '996812';
ALTER TABLE "CourierPartner" ADD COLUMN "serviceDescription" TEXT NOT NULL DEFAULT 'Courier services';
ALTER TABLE "CourierPartner" ADD COLUMN "gstRate" INTEGER NOT NULL DEFAULT 18;

CREATE INDEX "CourierPartner_serviceCode_idx" ON "CourierPartner"("serviceCode");
