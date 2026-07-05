# W3C Early COD Partner Prequalification

W3C adds an internal early COD partner rail for instruction/pre-qualification preview only.

It helps operators estimate whether a seller-period could be shared with a future partner review process. It does not approve credit, create obligations, move money, call any partner system, or alter checkout settlement.

## Scope

Implemented:

- additive preview tables for batches, items, and events
- preview formula using minor-unit strings and `BigInt`
- dry-run planning by default
- local/test execution only with explicit `--execute`
- JSON and CSV preview export
- deterministic smoke CLI
- review reasons for unsafe or high-risk rows

Not implemented:

- lending
- funding
- disbursement
- repayment
- loan accounts or contracts
- partner API calls
- payment capture
- payout execution
- checkout settlement execution
- COD custody
- live provider calls
- public seller mutation APIs
- shipping balance credit

Shadow dispute aging is intentionally separate future work.

## Formula

```text
eligibleBaseMinor =
  grossCodDueMinor
  - expectedDeductionMinor
  - riskReserveMinor
  - partnerFeeEstimateMinor

maxPreviewAdvanceMinor =
  floor(eligibleBaseMinor * maxAdvanceRateBps / 10000)

previewAdvanceMinor =
  min(requestedAdvanceMinor, maxPreviewAdvanceMinor)
```

All amount inputs and outputs are minor-unit strings. The implementation uses integer arithmetic only.

The clean fixture proves:

- `eligibleBaseMinor=78000`
- `maxPreviewAdvanceMinor=54600`
- `previewAdvanceMinor=50000`

## Inputs

Each row captures:

- seller org id
- period
- internal COD instruction batch id
- internal checkout preview batch id
- courier code
- gross COD due minor
- expected deduction minor
- risk reserve minor
- partner fee estimate minor
- max advance rate bps
- requested advance minor
- currency
- days since delivery
- dispute count
- RTO count
- review issue count

Only opaque internal refs are accepted. Public carrier refs and customer contact or location fields remain out of scope.

## Review Rules

Rows become `review_required` when W3C sees:

- negative eligible base
- requested amount above cap
- missing internal source ref
- unsupported currency
- invalid integer amount or bps
- high dispute, RTO, or review activity
- unsafe internal ref

Unsafe row refs are sanitized from output.

## Statuses

Allowed statuses:

- `draft`
- `review_required`
- `prequalification_preview`
- `exported_preview`
- `voided`

No status represents completed movement or partner approval.

## Output Policy

Every read result includes:

- `previewOnly=true`
- `partnerInstructionOnly=true`
- `creditApproved=false`
- `loanCreated=false`
- `disbursementExecuted=false`
- `repaymentCreated=false`
- `movementExecuted=false`
- `paymentCaptured=false`
- `payoutExecuted=false`
- `settlementExecuted=false`
- `custodyCreated=false`
- `partnerApiCalled=false`

## CLI

```bash
node scripts/wallet-w3c-early-cod-prequalification-smoke.mjs --json
```

Dry-run is the default and performs zero writes.

Local/test execution writes only W3C preview tables:

```bash
node scripts/wallet-w3c-early-cod-prequalification-smoke.mjs \
  --seller-org-id org_w3c_sandbox_seller \
  --period 2026-07 \
  --created-by usr_w3c_operator \
  --execute \
  --json
```

Execution is blocked for production, staging, and live runtime modes.

## Duplicate Handling

W3C uses `(sellerOrgId, period, sourceRef)` as an idempotency key.

- Same source ref with same source hash returns the existing batch.
- Same source ref with a changed source hash returns a conflict.

## Activation Boundary

W3C is not activation. It is an internal preview for a future partner-review decision. Real credit, custody, settlement, payout, provider, and public seller action workflows remain blocked by future approvals.
