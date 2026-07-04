# W0C-1 Staging To Shadow Ledger

W0C-1 converts validated W0B staging rows into W0 shadow-scope journal entries through `LedgerService.postEntry`. It is still a shadow accounting phase. It does not move money, create custody claims, run recovery reports, call providers, expose public APIs, or touch n8n.

## What W0C-1 Implements

- Internal staging-row posting service.
- Internal event-class to ledger-command mapper.
- Internal shadow account provisioning for supported seller and courier accounts.
- Deterministic opaque `entry_ref` generation.
- Deterministic `command_hash` generation through the W0A ledger command hash.
- Dry-run mapping mode.
- Replay-safe posting by `entry_ref` + `command_hash`.
- `staging_rows.posted_entry_ref` update after successful ledger posting.
- Stable unpostable-row result codes.

No HTTP controller or public seller-facing API is added.

## Why Shadow Only

W0 remains a reconciliation and visibility layer. Courier and seller files are hostile inputs, so W0C-1 posts only shadow entries that describe expected commercial positions. Custodial movement, bank settlement, provider settlement, payment capture, PA split settlement, and lending remain outside this phase.

Every W0C-1 ledger command uses:

- `ledger_scope = shadow`
- shadow wallet accounts only
- no platform custody account
- no bank/gateway account
- no payment-provider action

## Shadow Balance Semantics

W0 `shipping_balance`, `cod_receivable`, `dispute_hold`, `courier_payable`, and `courier_cod_due` balances are audit-position balances only. A freight charge can debit seller `shipping_balance` even when the seller has not topped up a spendable wallet, because W0 is reconstructing a net settlement position from import files.

These balances must not be exposed as available wallet funds, withdrawal eligibility, top-up balance, or spendable checkout balance. W1 custodial wallet availability must be computed only from custodial accounts and production wallet movement rules, not from W0 shadow accounts.

## Supported Event Mapping

| Staging `event_class` | Entry type | Behavior |
| --- | --- | --- |
| `freight_charged` | `shipment_charge` | Seller owes courier freight. |
| `rto_freight_charged` | `rto_freight_charge` | Seller owes courier RTO freight. |
| `return_freight_charged` | `return_freight_charge` | Seller owes courier return freight. |
| `shipment_refund` | `shipment_refund` | Courier liability reduces seller shipping balance. |
| `weight_dispute_debit` | `weight_dispute_hold` | Move disputed weight amount into seller dispute hold. |
| `weight_dispute_credit` | `weight_dispute_release` | Release existing dispute hold back to seller shipping balance. |
| `cod_collected` | `cod_collected` | Courier owes seller COD receivable in shadow. |
| `cod_remitted` | `cod_remittance_in` | Direct courier-to-seller COD remittance in shadow. |
| `deduction_unattributed` | none | Not posted until classified. |
| `unknown` | none | Not posted. |

## Posting Legs

| Event class | Debit | Credit |
| --- | --- | --- |
| `freight_charged` | seller `shipping_balance` | courier `courier_payable` |
| `rto_freight_charged` | seller `shipping_balance` | courier `courier_payable` |
| `return_freight_charged` | seller `shipping_balance` | courier `courier_payable` |
| `shipment_refund` | courier `courier_payable` | seller `shipping_balance` |
| `weight_dispute_debit` | seller `shipping_balance` | seller `dispute_hold` |
| `weight_dispute_credit` | seller `dispute_hold` | seller `shipping_balance` |
| `cod_collected` | courier `courier_cod_due` | seller `cod_receivable` |
| `cod_remitted` | seller `cod_receivable` | courier `courier_cod_due` |

`weight_dispute_credit` requires sufficient existing seller `dispute_hold` balance. If the hold balance is not enough, W0C-1 returns `INSUFFICIENT_DISPUTE_HOLD` and does not post.

## Account Provisioning Rules

W0C-1 provisions only these shadow account types:

Seller:

- `shipping_balance`
- `cod_receivable`
- `dispute_hold`

Courier:

- `courier_payable`
- `courier_cod_due`

The seller owner is derived from `import_files.brand_org_id`. The courier owner is derived from `import_files.counterparty`. Missing owner references block posting.

Provisioning:

- creates or finds `wallet_owner`
- creates or finds `wallet_account`
- uses `LedgerService.createOwner`
- uses `LedgerService.createAccount`
- validates `account_type_config`
- forces `ledger_scope = shadow`
- stamps `account_class` from account type config
- is idempotent on retries

W0C-1 does not provision checkout, platform, gateway, tax, suspense, leakage, escrow, revenue, or custody accounts.

## Deterministic Entry Refs

W0C-1 entry refs are opaque and deterministic:

```text
W0IMP-{EVENT}-{opaque-sha256-token}
```

Examples:

- `W0IMP-SHIP-bcafedbacefacebdcafedbac`
- `W0IMP-RTO-cdabfedcabedfacebcafedba`
- `W0IMP-COD-fadebacedcabfeebacdeface`
- `W0IMP-WD-acbdfecabedfacecafedbaca`

The hash input includes:

- staging row id
- import file id
- event class
- canonical parsed payload hash

The visible token is 24 hexadecimal characters of SHA-256-derived entropy. LedgerService accepts only strict W0 internal opaque ref shapes for these long hex refs; other long numeric or buyer-resolvable refs remain blocked by the readable-reference guard.

The visible ref never includes:

- AWB
- courier docket
- marketplace order number
- buyer name
- phone
- email
- address
- courier cycle names
- business-readable dates

`source_ref` is also opaque. It is derived from the internal shipment id by hashing into a 24-character `shp_...` ref so raw shipment, order, or buyer-resolvable references never enter journal fields.

## Command Hash And Idempotency

The ledger command includes:

- `entry_ref`
- `entry_type`
- `ledger_scope`
- `source_type`
- `source_ref`
- postings
- safe narrative
- metadata with staging row id, import file id, format-pack version id, and parsed hash

The command hash is computed from canonical JSON with sorted object keys. W0C-1 never places raw parsed rows, raw staging rows, raw carrier/customer references, timestamps, or nondeterministic object key order into the command hash input.

`LedgerService.computeCommandHash` creates the command hash from canonical JSON.

Replay behavior:

- Same staging row and same parsed payload yields the same `entry_ref` and `command_hash`.
- If the ledger entry already exists with the same hash, `LedgerService.postEntry` returns the original entry idempotently.
- If the same `entry_ref` exists with a different command hash, W0C-1 reports `LEDGER_POST_CONFLICT`.
- If `posted_entry_ref` update fails after ledger success, retry calls the same ledger command and then marks the row posted.

## Dry Run

`dryRun` mode:

- validates rows
- validates required shadow owners/accounts by read-only lookup
- builds ledger commands
- returns safe command summaries
- does not create wallet owners
- does not create wallet accounts
- does not call `LedgerService.postEntry`
- does not set `posted_entry_ref`
- does not update staging rows
- does not create journal entries
- does not create postings
- does not create outbox events

## Unpostable Row Codes

| Code | Meaning |
| --- | --- |
| `ROW_NOT_READY` | Row status is not postable or is already an exception. |
| `MISSING_SHIPMENT_ID` | Row has no internal shipment id. |
| `MISSING_AMOUNT` | Parsed amount is absent. |
| `BAD_AMOUNT` | Parsed amount is not a minor-unit integer string. |
| `ZERO_AMOUNT` | Parsed amount is zero. |
| `NEGATIVE_AMOUNT_UNSUPPORTED` | Negative amount appeared for an event that does not allow signed reversal semantics. |
| `UNKNOWN_EVENT_CLASS` | Event class is not supported for posting. |
| `UNATTRIBUTED_DEDUCTION_NOT_POSTED` | Unclassified deduction must be reconciled before posting. |
| `INSUFFICIENT_DISPUTE_HOLD` | Dispute release exceeds existing dispute hold balance. |
| `ACCOUNT_PROVISIONING_FAILED` | Required shadow owner/account could not be safely provisioned. |
| `LEDGER_POST_CONFLICT` | `entry_ref` exists with a different command hash. |
| `LEDGER_POST_FAILED` | Ledger rejected or failed the post. |

## I17 Rules

W0C-1 journal fields are safe by construction:

- `entry_ref` is generated by W0C-1 and opaque.
- `source_ref` is an opaque internal shipment hash.
- `narrative` is one of a small set of generic strings.
- raw parsed fields remain quarantined in staging only.

No AWB, buyer-resolvable order ref, courier docket, buyer name, phone, email, pincode, or address is copied into ledger journal fields, postings, holds, balances, or outbox payloads by W0C-1.

`created_by` must be an internal service principal or internal user id such as `import_pipeline_w0`, `system:w0c1`, or `usr_...`. Human contact identifiers are rejected before LedgerService is called.

## W0C-2 Remaining Work

W0C-2 should add:

- recovery report generation
- report views and query services
- reversal and correction workflow
- exception report surfaces
- n8n transport integration later

## Out Of Scope

W0C-1 does not implement:

- custody
- bank payout
- payment movement
- PA split settlement
- provider settlement
- lending
- public wallet APIs
- public seller-facing import APIs
- W1/W2/W3 production wallet flows
- production deployment
- live DB changes

## Validation

Run from `backend`:

```sh
npx prisma validate
npx prisma generate
npm run build
npm test
```

Run from repo root:

```sh
git diff --check
grep -R "parseFloat\\|Math.round\\|Number(" backend/src/modules/importPipeline backend/src/modules/walletLedger 2>/dev/null || true
grep -R "journalEntry\\.create\\|journalPosting\\.create\\|accountBalance\\.update\\|walletEventOutbox\\.create" backend/src/modules/importPipeline 2>/dev/null || true
grep -R "platform_escrow\\|gateway_clearing\\|platform_revenue\\|fee_expense\\|tax_payable\\|courier_suspense\\|courier_leakage" backend/src/modules/importPipeline 2>/dev/null || true
```
