CREATE TABLE "wallet_topup_intents" (
  "id" TEXT NOT NULL,
  "topup_ref" TEXT NOT NULL,
  "seller_org_id" TEXT NOT NULL,
  "amount_paise" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" TEXT NOT NULL DEFAULT 'created',
  "source_ref_hash" TEXT NOT NULL,
  "created_by" TEXT,
  "confirmed_by" TEXT,
  "journal_entry_id" TEXT,
  "metadata" JSONB,
  "confirmed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_topup_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_topup_intents_topup_ref_key" ON "wallet_topup_intents"("topup_ref");
CREATE INDEX "wallet_topup_intents_seller_org_id_idx" ON "wallet_topup_intents"("seller_org_id");
CREATE INDEX "wallet_topup_intents_status_idx" ON "wallet_topup_intents"("status");
CREATE INDEX "wallet_topup_intents_source_ref_hash_idx" ON "wallet_topup_intents"("source_ref_hash");
