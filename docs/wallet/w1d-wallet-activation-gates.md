# W1D Wallet Activation Gates

W1D is a gate and checklist only. It does not activate live wallet movement.

## Scope

Implemented:

- internal `W1ActivationGateService`
- local script: `scripts/wallet-w1d-activation-gate.mjs`
- machine-readable checklist grouped by legal, accounting, operations, technical, owner, and future W2/W3 requirements
- fail-closed live readiness status
- documentation of required approvals before live review

Not implemented:

- W2 or W3
- COD custody
- bank movement
- checkout split settlement
- lending
- payment provider calls
- public wallet mutation APIs
- top-up, hold, capture, refund, cashout, payout, or settlement routes
- live database or deployment work
- external workflow automation

## Command

Build first so the script can import compiled backend modules:

```bash
npm run build
```

Sandbox report:

```bash
node scripts/wallet-w1d-activation-gate.mjs --target sandbox --json
```

Live review report:

```bash
node scripts/wallet-w1d-activation-gate.mjs \
  --target live \
  --evidence CLOSED_LOOP_SCOPE_SIGNOFF=LEGAL-REF \
  --evidence NO_CASHOUT_POSITION_SIGNOFF=LEGAL-REF \
  --json
```

The command is read-only. It has no execute flag and writes no database rows.

## Status Model

- `blocked`: required evidence or runtime guard is missing.
- `sandbox_only`: sandbox posture is documented, but live movement is not approved.
- `review_ready`: live target has all required evidence. This is not activation.

Even `review_ready` does not change runtime flags, secrets, database state, or deployment posture.

## Required Legal Approvals

- `CLOSED_LOOP_SCOPE_SIGNOFF`
- `NO_CASHOUT_POSITION_SIGNOFF`
- `REFUND_TO_SOURCE_SOP_SIGNOFF`
- `TERMS_AND_USER_DISCLOSURE_SIGNOFF`
- `GRIEVANCE_AND_CLOSURE_SOP_SIGNOFF`

## Required Accounting And Tax Approvals

- `GST_FREIGHT_TREATMENT_SIGNOFF`
- `GST_PLATFORM_FEE_TREATMENT_SIGNOFF`
- `TDS_COURIER_PAYMENT_TREATMENT_SIGNOFF`
- `PRINCIPAL_VS_AGENT_SIGNOFF`
- `WALLET_LIABILITY_LEDGER_TREATMENT_SIGNOFF`
- `REFUND_AND_CREDIT_NOTE_TREATMENT_SIGNOFF`

## Required Operations SOPs

- `RECONCILIATION_SOP`
- `FAILED_TOPUP_SOP`
- `DUPLICATE_TOPUP_SOP`
- `WALLET_FREEZE_LOCK_CLOSE_SOP`
- `AUDIT_EXPORT_SOP`
- `SUPPORT_ESCALATION_SOP`

## Required Owner Approvals

- `OWNER_LIVE_ACTIVATION_APPROVAL`
- `ROLLBACK_PLAN_APPROVAL`
- `PILOT_LIMIT_APPROVAL`

## Technical Gate

The technical checklist documents that:

- W1 flags default to sandbox-safe values.
- production mutation guards remain present.
- no public mutating W1 routes are present.
- no live payment provider is wired.
- no bank cashout is wired.
- shadow balances are never spendable.
- ledger postings use `LedgerService` only.
- ledger fields reject public or private refs.

## Future W2/W3

W1D keeps future work blocked:

- COD custody is not approved.
- checkout split settlement is not approved.
- early COD lending partner flow is not approved.
- digital lending requires separate review.
- payment aggregator flow requires separate review.

These items are intentionally separate future gates. W1D does not implement or approve them.

## Boundary

Live W1 remains blocked until counsel, accountant, operations, and owner approvals are documented. W1D does not enable live wallet movement, cashout, payment, bank movement, COD custody, checkout settlement, or lending.
