ALTER TABLE "public"."CourierGstinRecord"
  ADD COLUMN "source" TEXT,
  ALTER COLUMN "verificationStatus" SET DEFAULT 'PENDING_REVIEW';

ALTER TABLE "public"."CourierOperationalLocation"
  ADD COLUMN "email" TEXT,
  ALTER COLUMN "status" SET DEFAULT 'PENDING_REVIEW';
