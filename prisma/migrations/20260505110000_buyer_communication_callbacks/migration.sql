CREATE TYPE "public"."BuyerCommunicationResponse" AS ENUM (
  'OTP_VERIFIED',
  'OTP_FAILED',
  'ADDRESS_CONFIRMED',
  'ADDRESS_CORRECTED',
  'PREPAID_CONVERTED',
  'BUYER_CONFIRMED_REATTEMPT',
  'BUYER_REFUSED',
  'NO_RESPONSE',
  'INVALID_RESPONSE'
);

CREATE TYPE "public"."CommunicationStatus" AS ENUM (
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'RESPONDED',
  'FAILED',
  'EXPIRED'
);

ALTER TABLE "public"."BuyerCommunicationEvent"
  ADD COLUMN "providerMessageId" TEXT;

ALTER TABLE "public"."BuyerCommunicationEvent"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "public"."CommunicationStatus" USING "status"::"public"."CommunicationStatus",
  ALTER COLUMN "status" SET DEFAULT 'QUEUED';

ALTER TABLE "public"."BuyerCommunicationEvent"
  ALTER COLUMN "response" TYPE "public"."BuyerCommunicationResponse" USING NULLIF("response", '')::"public"."BuyerCommunicationResponse";

CREATE INDEX "BuyerCommunicationEvent_providerMessageId_idx" ON "public"."BuyerCommunicationEvent"("providerMessageId");
