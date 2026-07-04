# W0A Wallet Ledger Foundation

## Scope

This document describes the W0A backend foundation for the Shipmastr shadow wallet ledger. W0A is shadow-scope only. It creates the ledger schema, account type rule seed table, and an internal `LedgerService.postEntry` foundation that can post balanced journal entries in paise without activating custody, payment movement, payouts, COD custody, PA split settlement, or lending.

The ledger is the audit layer expressed in money. It is designed to support future wallet/custody architecture, but W0A does not expose a seller-facing wallet UI or any public money-movement endpoint.

## Migration

Migration name:

`20260704120000_w0a_wallet_ledger_foundation`

The migration adds these tables:

- `wallet_owners`
- `wallet_accounts`
- `account_type_config`
- `journal_entries`
- `journal_postings`
- `account_balances`
- `wallet_holds`
- `settlement_batches`
- `settlement_batch_items`
- `external_transactions`
- `external_transaction_matches`
- `recon_exceptions`
- `wallet_events_outbox`

It also adds enums for owner type, account class, account type, account status, ledger scope, entry type, posting direction, and hold status.

## Account Type Rules

`account_type_config` is seeded with the frozen W0A account type rules:

- `shipping_balance` -> liability / credit / seller / shadow,custodial
- `cod_receivable` -> liability / credit / seller / shadow,custodial
- `dispute_hold` -> liability / credit / seller / shadow,custodial
- `seller_shortfall` -> asset / debit / seller / shadow,custodial
- `checkout_balance` -> liability / credit / seller / shadow only
- `courier_payable` -> liability / credit / courier / shadow,custodial
- `courier_cod_due` -> asset / debit / courier / shadow,custodial
- `courier_suspense` -> asset / debit / courier / custodial
- `platform_escrow` -> asset / debit / platform / custodial
- `gateway_clearing` -> asset / debit / platform,gateway / custodial
- `platform_revenue` -> revenue / credit / platform / custodial
- `fee_expense` -> expense / debit / platform / custodial
- `tax_payable` -> liability / credit / platform / custodial
- `courier_leakage` -> expense / debit / platform / custodial

W0A does not require runtime creation of custodial accounts. The config records future allowed scopes exactly so later wallet phases can build on the same rules without changing the taxonomy.

## Service Added

Files:

- `src/modules/walletLedger/ledger.service.ts`
- `src/modules/walletLedger/index.ts`
- `src/modules/walletLedger/wallet-ledger.module.ts`

`LedgerService` is the only intended writer for:

- `journal_entries`
- `journal_postings`
- `account_balances`
- `wallet_holds`

W0A implements `postEntry(command)` for journal entries and account balance updates. Hold lifecycle helpers are intentionally not implemented yet, but the `wallet_holds` table exists for future W0 flows.

## Invariants Enforced in W0A

Service-level guardrails enforce:

- all posting writes happen inside one Prisma transaction
- journal entries are append-only
- `entry_ref + command_hash` idempotency
- same `entry_ref` with different `command_hash` returns conflict
- concurrent same `entry_ref + command_hash` unique-insert races are recovered as idempotent reads
- balance rows are inserted if missing, then locked in deterministic account-id order before journal writes and balance updates
- debit total equals credit total
- all amounts are integer BIGINT paise only; JS numbers and decimal strings are rejected
- one entry, one currency
- one entry, one ledger scope
- account classes are stamped from `account_type_config`
- account owner type is allowed for the account type
- ledger scope is allowed for the account type
- no posting to preview, locked, frozen, or closed accounts
- refs reject obvious PII, direct contact values, provider tracking identifiers, and buyer-resolvable marketplace references
- `wallet_events_outbox` is written only after a successful ledger transaction

DB trigger hardening is not implemented in W0A. A future DB-hardening pass should add database-level checks for append-only journal semantics, immutable postings, and balance-write restrictions. W0A deliberately does not fake trigger enforcement.

## Shadow-only W0A Behavior

W0A defaults account creation and posting to `shadow` scope. Custodial scope exists in enum/config for future phases, but this task does not activate custodial accounts, bank settlement, gateway clearing movement, payout movement, or PA split settlement.

## Intentionally Not Implemented

W0A does not implement:

- W1/W2/W3 wallet flows
- payment gateway integration
- bank payout integration
- COD custody
- checkout split settlement
- revenue posting
- tax-leg posting
- wallet UI
- public money movement endpoints
- courier/provider API calls
- outbound notification or webhook side effects
- import parser/reconciliation pipeline

## Tests

Tests added:

`src/modules/walletLedger/ledger.service.test.ts`

The tests cover:

- balanced entry posts successfully
- required account type config rows stay exact
- balance rows are inserted/locked before journal writes and balance updates
- unbalanced entry is rejected
- same `entry_ref + command_hash` is idempotent
- concurrent duplicate insert race for same `entry_ref + command_hash` is recovered as idempotent
- same `entry_ref` with different hash conflicts
- cross-scope posting is rejected
- cross-currency posting is rejected
- every non-active account status is rejected
- caller-forged account class is replaced by config stamping
- seller cannot create courier-only account type
- `checkout_balance` cannot be custodial
- PII-like/buyer-resolvable refs are rejected
- BIGINT paise path rejects JS numbers/floats
- balances are re-derivable from postings
- outbox writes happen only after successful ledger transaction

Suggested validation commands:

```bash
cd /Users/mac/shipmastr-fullstack/backend
npx prisma validate
npx prisma generate
npm test
npm run build
```

## Rollback Notes

This migration is additive. If rolled back before use, drop the W0A tables and enum types introduced by `20260704120000_w0a_wallet_ledger_foundation`. Once journal entries exist, do not delete or mutate rows manually; append-only correction semantics require reversal entries instead of edits.

## Remaining W0B Scope

W0B remains out of scope here and should cover import and dry-run foundations:

- `ImportModule`
- `import_files`
- `staging_rows`
- `format_packs`
- `format_pack_versions`
- `format_pack_fixtures`
- `format_pack_test_runs`
- dry-run parser
- maker-checker pack activation
- recovery reports
