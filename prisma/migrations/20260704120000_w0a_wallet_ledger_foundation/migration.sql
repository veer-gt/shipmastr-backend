CREATE TYPE "owner_type" AS ENUM ('seller', 'courier', 'platform', 'gateway');
CREATE TYPE "account_class" AS ENUM ('asset', 'liability', 'revenue', 'expense');
CREATE TYPE "account_type" AS ENUM (
  'shipping_balance',
  'cod_receivable',
  'dispute_hold',
  'seller_shortfall',
  'checkout_balance',
  'courier_payable',
  'courier_cod_due',
  'courier_suspense',
  'platform_escrow',
  'gateway_clearing',
  'platform_revenue',
  'fee_expense',
  'tax_payable',
  'courier_leakage'
);
CREATE TYPE "account_status" AS ENUM ('active', 'preview', 'locked', 'frozen', 'closed');
CREATE TYPE "ledger_scope" AS ENUM ('custodial', 'shadow');
CREATE TYPE "entry_type" AS ENUM (
  'topup',
  'topup_refund',
  'gateway_settlement',
  'shipment_charge',
  'shipment_refund',
  'rto_freight_charge',
  'return_freight_charge',
  'weight_dispute_hold',
  'weight_dispute_release',
  'weight_dispute_capture',
  'cod_collected',
  'cod_remittance_in',
  'cod_payout',
  'courier_net_settlement',
  'checkout_capture',
  'checkout_split_settlement',
  'success_fee',
  'platform_fee',
  'adjustment',
  'suspense_recovery',
  'suspense_writeoff',
  'closure_refund_to_source',
  'closure_bank_settlement'
);
CREATE TYPE "posting_direction" AS ENUM ('debit', 'credit');
CREATE TYPE "hold_status" AS ENUM ('active', 'released', 'captured', 'expired');

CREATE TABLE "wallet_owners" (
  "id" TEXT NOT NULL,
  "owner_type" "owner_type" NOT NULL,
  "external_id" TEXT,
  "display_name" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_owners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "account_type_config" (
  "account_type" "account_type" NOT NULL,
  "account_class" "account_class" NOT NULL,
  "normal_side" "posting_direction" NOT NULL,
  "allowed_owner_types" "owner_type"[] NOT NULL,
  "allowed_ledger_scopes" "ledger_scope"[] NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_type_config_pkey" PRIMARY KEY ("account_type")
);

CREATE TABLE "wallet_accounts" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "owner_type" "owner_type" NOT NULL,
  "account_type" "account_type" NOT NULL,
  "account_class" "account_class" NOT NULL,
  "status" "account_status" NOT NULL DEFAULT 'active',
  "ledger_scope" "ledger_scope" NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "label" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journal_entries" (
  "id" TEXT NOT NULL,
  "entry_ref" TEXT NOT NULL,
  "command_hash" TEXT NOT NULL,
  "entry_type" "entry_type" NOT NULL,
  "ledger_scope" "ledger_scope" NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "source_type" TEXT NOT NULL,
  "source_ref" TEXT NOT NULL,
  "narrative" TEXT,
  "created_by" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journal_postings" (
  "id" TEXT NOT NULL,
  "entry_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "direction" "posting_direction" NOT NULL,
  "amount_paise" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_postings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "account_balances" (
  "account_id" TEXT NOT NULL,
  "ledger_scope" "ledger_scope" NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "balance_paise" BIGINT NOT NULL DEFAULT 0,
  "last_journal_entry_id" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_balances_pkey" PRIMARY KEY ("account_id")
);

CREATE TABLE "wallet_holds" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "entry_id" TEXT NOT NULL,
  "hold_ref" TEXT NOT NULL,
  "amount_paise" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" "hold_status" NOT NULL DEFAULT 'active',
  "source_type" TEXT NOT NULL,
  "source_ref" TEXT NOT NULL,
  "released_by_entry_id" TEXT,
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_holds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "settlement_batches" (
  "id" TEXT NOT NULL,
  "batch_ref" TEXT NOT NULL,
  "ledger_scope" "ledger_scope" NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "batch_type" TEXT NOT NULL,
  "total_paise" BIGINT NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settlement_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "settlement_batch_items" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "owner_id" TEXT,
  "account_id" TEXT,
  "amount_paise" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "source_type" TEXT NOT NULL,
  "source_ref" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "journal_entry_id" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settlement_batch_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "external_transactions" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "transaction_type" TEXT NOT NULL,
  "external_ref" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3),
  "amount_paise" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "raw_payload" JSONB,
  "normalized_payload" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "external_transaction_matches" (
  "id" TEXT NOT NULL,
  "external_transaction_id" TEXT NOT NULL,
  "journal_entry_id" TEXT,
  "match_status" TEXT NOT NULL DEFAULT 'pending',
  "confidence" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_transaction_matches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recon_exceptions" (
  "id" TEXT NOT NULL,
  "scope" "ledger_scope" NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_ref" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'medium',
  "status" TEXT NOT NULL DEFAULT 'open',
  "reason_code" TEXT NOT NULL,
  "details" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recon_exceptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_events_outbox" (
  "id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "aggregate_type" TEXT NOT NULL,
  "aggregate_id" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  CONSTRAINT "wallet_events_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_owners_owner_type_external_id_key" ON "wallet_owners"("owner_type", "external_id");
CREATE INDEX "wallet_owners_owner_type_idx" ON "wallet_owners"("owner_type");

CREATE INDEX "wallet_accounts_owner_id_idx" ON "wallet_accounts"("owner_id");
CREATE INDEX "wallet_accounts_owner_type_idx" ON "wallet_accounts"("owner_type");
CREATE INDEX "wallet_accounts_account_type_idx" ON "wallet_accounts"("account_type");
CREATE INDEX "wallet_accounts_ledger_scope_idx" ON "wallet_accounts"("ledger_scope");
CREATE INDEX "wallet_accounts_status_idx" ON "wallet_accounts"("status");
CREATE UNIQUE INDEX "wallet_accounts_owner_id_account_type_ledger_scope_currency_key" ON "wallet_accounts"("owner_id", "account_type", "ledger_scope", "currency");

CREATE UNIQUE INDEX "journal_entries_entry_ref_key" ON "journal_entries"("entry_ref");
CREATE INDEX "journal_entries_entry_type_idx" ON "journal_entries"("entry_type");
CREATE INDEX "journal_entries_ledger_scope_idx" ON "journal_entries"("ledger_scope");
CREATE INDEX "journal_entries_source_type_source_ref_idx" ON "journal_entries"("source_type", "source_ref");
CREATE INDEX "journal_entries_created_at_idx" ON "journal_entries"("created_at");

CREATE INDEX "journal_postings_entry_id_idx" ON "journal_postings"("entry_id");
CREATE INDEX "journal_postings_account_id_idx" ON "journal_postings"("account_id");
CREATE INDEX "journal_postings_currency_idx" ON "journal_postings"("currency");

CREATE INDEX "account_balances_ledger_scope_idx" ON "account_balances"("ledger_scope");
CREATE INDEX "account_balances_currency_idx" ON "account_balances"("currency");

CREATE UNIQUE INDEX "wallet_holds_hold_ref_key" ON "wallet_holds"("hold_ref");
CREATE INDEX "wallet_holds_account_id_idx" ON "wallet_holds"("account_id");
CREATE INDEX "wallet_holds_entry_id_idx" ON "wallet_holds"("entry_id");
CREATE INDEX "wallet_holds_status_idx" ON "wallet_holds"("status");
CREATE INDEX "wallet_holds_source_type_source_ref_idx" ON "wallet_holds"("source_type", "source_ref");

CREATE UNIQUE INDEX "settlement_batches_batch_ref_key" ON "settlement_batches"("batch_ref");
CREATE INDEX "settlement_batches_ledger_scope_idx" ON "settlement_batches"("ledger_scope");
CREATE INDEX "settlement_batches_status_idx" ON "settlement_batches"("status");
CREATE INDEX "settlement_batches_created_at_idx" ON "settlement_batches"("created_at");

CREATE INDEX "settlement_batch_items_batch_id_idx" ON "settlement_batch_items"("batch_id");
CREATE INDEX "settlement_batch_items_owner_id_idx" ON "settlement_batch_items"("owner_id");
CREATE INDEX "settlement_batch_items_account_id_idx" ON "settlement_batch_items"("account_id");
CREATE INDEX "settlement_batch_items_source_type_source_ref_idx" ON "settlement_batch_items"("source_type", "source_ref");
CREATE INDEX "settlement_batch_items_status_idx" ON "settlement_batch_items"("status");

CREATE UNIQUE INDEX "external_transactions_provider_external_ref_key" ON "external_transactions"("provider", "external_ref");
CREATE INDEX "external_transactions_transaction_type_idx" ON "external_transactions"("transaction_type");
CREATE INDEX "external_transactions_occurred_at_idx" ON "external_transactions"("occurred_at");
CREATE INDEX "external_transactions_created_at_idx" ON "external_transactions"("created_at");

CREATE INDEX "external_transaction_matches_external_transaction_id_idx" ON "external_transaction_matches"("external_transaction_id");
CREATE INDEX "external_transaction_matches_journal_entry_id_idx" ON "external_transaction_matches"("journal_entry_id");
CREATE INDEX "external_transaction_matches_match_status_idx" ON "external_transaction_matches"("match_status");

CREATE INDEX "recon_exceptions_scope_idx" ON "recon_exceptions"("scope");
CREATE INDEX "recon_exceptions_source_type_source_ref_idx" ON "recon_exceptions"("source_type", "source_ref");
CREATE INDEX "recon_exceptions_status_idx" ON "recon_exceptions"("status");
CREATE INDEX "recon_exceptions_created_at_idx" ON "recon_exceptions"("created_at");

CREATE INDEX "wallet_events_outbox_event_type_idx" ON "wallet_events_outbox"("event_type");
CREATE INDEX "wallet_events_outbox_aggregate_type_aggregate_id_idx" ON "wallet_events_outbox"("aggregate_type", "aggregate_id");
CREATE INDEX "wallet_events_outbox_status_created_at_idx" ON "wallet_events_outbox"("status", "created_at");

ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "wallet_owners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_postings" ADD CONSTRAINT "journal_postings_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_postings" ADD CONSTRAINT "journal_postings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "wallet_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "wallet_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_holds" ADD CONSTRAINT "wallet_holds_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "wallet_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement_batch_items" ADD CONSTRAINT "settlement_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "settlement_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_transaction_matches" ADD CONSTRAINT "external_transaction_matches_external_transaction_id_fkey" FOREIGN KEY ("external_transaction_id") REFERENCES "external_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "account_type_config" ("account_type", "account_class", "normal_side", "allowed_owner_types", "allowed_ledger_scopes") VALUES
  ('shipping_balance', 'liability', 'credit', ARRAY['seller']::"owner_type"[], ARRAY['shadow','custodial']::"ledger_scope"[]),
  ('cod_receivable', 'liability', 'credit', ARRAY['seller']::"owner_type"[], ARRAY['shadow','custodial']::"ledger_scope"[]),
  ('dispute_hold', 'liability', 'credit', ARRAY['seller']::"owner_type"[], ARRAY['shadow','custodial']::"ledger_scope"[]),
  ('seller_shortfall', 'asset', 'debit', ARRAY['seller']::"owner_type"[], ARRAY['shadow','custodial']::"ledger_scope"[]),
  ('checkout_balance', 'liability', 'credit', ARRAY['seller']::"owner_type"[], ARRAY['shadow']::"ledger_scope"[]),
  ('courier_payable', 'liability', 'credit', ARRAY['courier']::"owner_type"[], ARRAY['shadow','custodial']::"ledger_scope"[]),
  ('courier_cod_due', 'asset', 'debit', ARRAY['courier']::"owner_type"[], ARRAY['shadow','custodial']::"ledger_scope"[]),
  ('courier_suspense', 'asset', 'debit', ARRAY['courier']::"owner_type"[], ARRAY['custodial']::"ledger_scope"[]),
  ('platform_escrow', 'asset', 'debit', ARRAY['platform']::"owner_type"[], ARRAY['custodial']::"ledger_scope"[]),
  ('gateway_clearing', 'asset', 'debit', ARRAY['platform','gateway']::"owner_type"[], ARRAY['custodial']::"ledger_scope"[]),
  ('platform_revenue', 'revenue', 'credit', ARRAY['platform']::"owner_type"[], ARRAY['custodial']::"ledger_scope"[]),
  ('fee_expense', 'expense', 'debit', ARRAY['platform']::"owner_type"[], ARRAY['custodial']::"ledger_scope"[]),
  ('tax_payable', 'liability', 'credit', ARRAY['platform']::"owner_type"[], ARRAY['custodial']::"ledger_scope"[]),
  ('courier_leakage', 'expense', 'debit', ARRAY['platform']::"owner_type"[], ARRAY['custodial']::"ledger_scope"[]);
