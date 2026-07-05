# W3B Checkout Settlement Read Surfaces

W3B exposes W3A checkout settlement preview batches through protected read and export-preview surfaces.

W3B is read/export-preview only. It does not move money.

## Routes

Internal readiness:

- `GET /api/internal/wallet/w3/checkout/readiness`

Admin reads:

- `GET /api/admin/wallets/w3/checkout/previews`
- `GET /api/admin/wallets/w3/checkout/previews/:batchId`
- `GET /api/admin/wallets/w3/checkout/previews/:batchId/export-preview`

Seller-safe reads:

- `GET /api/seller/wallet/w3/checkout/summary`
- `GET /api/seller/wallet/w3/checkout/previews`

No W3B route uses `POST`, `PUT`, `PATCH`, or `DELETE`.

## Access Boundary

- Internal readiness is protected by the internal secret guard.
- Admin preview reads are protected by admin auth.
- Seller preview reads derive seller scope from authenticated seller context.
- Seller reads cannot pass an arbitrary seller org.
- There is no unauthenticated W3 checkout route.

## Output Policy

Every response remains preview-only:

- `previewOnly=true`
- `movementExecuted=false`
- `paymentCaptured=false`
- `payoutExecuted=false`
- `settlementExecuted=false`
- `custodyCreated=false`

Allowed statuses remain:

- `draft`
- `review_required`
- `preview_ready`
- `exported_preview`
- `voided`

Money values are serialized as minor-unit strings.

## Export Preview

Export-preview supports JSON by default and CSV when requested.

Required disclaimer:

```text
Checkout settlement preview only. No payment capture, payout, settlement, custody, or money movement has been executed by Shipmastr.
```

Export-preview is not payment execution. It does not change batch status and does not create events.

## Explicit Non-Goals

W3B does not:

- move money
- capture payments
- create custody
- pay sellers
- settle couriers
- create bank/cashout movement
- implement lending or early COD funding
- activate payment aggregator behavior
- credit W1 shipping balance from checkout preview
- expose payment, payout, split execution, capture, or settlement execution routes

Live activation remains blocked by future W3D approvals.
