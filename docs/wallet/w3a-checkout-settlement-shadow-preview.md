# W3A Checkout Settlement Shadow Preview

W3A adds a checkout split settlement preview engine. It calculates what a split could look like for review, but it does not activate checkout settlement.

## Scope

Implemented:

- preview-only batch planning
- local/test execution into preview tables only
- per-item split calculation
- allocation buckets for review
- JSON and CSV preview export
- deterministic smoke CLI

Not implemented:

- live checkout settlement
- payment capture
- seller payout
- courier settlement
- custody creation
- bank/cashout movement
- lending or early COD funding
- payment aggregator behavior
- public mutating seller APIs

## Formula

```text
sellerPreviewReceivableMinor =
  grossAmountMinor
  - paymentFeeMinor
  - platformFeeMinor
  - shippingChargeMinor
  - taxMinor
  - discountMinor
  - refundMinor
  + adjustmentMinor
```

All amounts enter and leave the service as minor-unit strings. The implementation uses integer `BigInt` arithmetic.

## Allocation Buckets

- `seller_preview_receivable`
- `payment_fee_preview`
- `platform_fee_preview`
- `shipping_charge_preview`
- `tax_preview`
- `discount_preview`
- `refund_preview`
- `adjustment_preview`

Allocations are preview rows only. They are not ledger postings and cannot become spendable balance.

## Review Rules

Rows become `review_required` when W3A sees:

- negative seller preview
- missing checkout reference
- duplicate checkout reference in the same batch
- invalid amount
- unsupported currency
- unsafe internal reference

Unsafe source data is not serialized back into preview output. Public carrier refs, consumer contact data, and consumer location data remain out of scope.

## Statuses

Allowed statuses:

- `draft`
- `review_required`
- `preview_ready`
- `exported_preview`
- `voided`

No status indicates completed money movement.

## CLI

```bash
node scripts/wallet-w3a-checkout-settlement-preview-smoke.mjs --json
```

Dry-run is the default and performs zero writes.

Local/test execution writes only W3A preview tables:

```bash
node scripts/wallet-w3a-checkout-settlement-preview-smoke.mjs \
  --seller-org-id org_w3a_sandbox_seller \
  --period 2026-07 \
  --created-by usr_w3a_operator \
  --execute \
  --json
```

Execution is blocked for production, staging, and live runtime modes.

## Output Policy

Every W3A read result includes:

- `movementExecuted=false`
- `paymentCaptured=false`
- `payoutExecuted=false`
- `settlementExecuted=false`
- `custodyCreated=false`
- `previewOnly=true`

## Activation Boundary

W3A is shadow/preview only. It does not capture payments, pay sellers, settle couriers, create custody, implement lending, or activate payment aggregator behavior.

Live activation remains blocked by future W3D approvals.

## W3B Read Surfaces

W3B adds protected read and export-preview surfaces over W3A preview batches:

- internal readiness read
- admin preview list/detail reads
- admin JSON/CSV export-preview
- seller-scoped preview summary/list reads

W3B does not change W3A planning or persistence behavior. Export-preview remains read-only: it does not change batch status, does not create events, and is not payment execution.

W3B still does not move money, capture payments, create custody, pay sellers, settle couriers, implement lending or early COD funding, or activate payment aggregator behavior. Live activation remains blocked by future W3D approvals.
