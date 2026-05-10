ALTER TABLE "MerchantAutomationPolicy"
  ADD COLUMN "communicationEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "dailyWhatsappLimit" INTEGER,
  ADD COLUMN "dailySmsLimit" INTEGER,
  ADD COLUMN "buyerMessageQuietHoursStart" TEXT,
  ADD COLUMN "buyerMessageQuietHoursEnd" TEXT;
