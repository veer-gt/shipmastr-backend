ALTER TYPE "public"."AccountGstinVerificationStatus" ADD VALUE IF NOT EXISTS 'PENDING_REVIEW';
ALTER TYPE "public"."AccountGstinVerificationStatus" ADD VALUE IF NOT EXISTS 'HOLD';
ALTER TYPE "public"."AccountGstinVerificationStatus" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW';

ALTER TYPE "public"."PickupPointStatus" ADD VALUE IF NOT EXISTS 'PENDING_REVIEW';
ALTER TYPE "public"."PickupPointStatus" ADD VALUE IF NOT EXISTS 'HOLD';
