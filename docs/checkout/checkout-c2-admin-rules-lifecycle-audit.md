# Checkout C2 Admin Rules, Lifecycle, and Audit APIs

C2 adds backend admin operations for Shipmastr Checkout. It is an internal/admin API phase only.

## Scope Added

- Admin checkout rules read/update APIs.
- Checkout rules version history.
- Rules rollback by creating a new active version from an older version.
- Admin checkout order list and detail APIs.
- Order lifecycle transitions:
  - `confirmed`
  - `packed`
  - `shipped`
  - `delivered`
  - `cancelled`
  - `expired`
  - `refund_due`
- COD collection capture during delivered transition.
- Checkout audit log read API.
- C5 hardening-parity smoke tests C2 together with C1 using the existing backend test harness convention. C5 is not a live-database end-to-end suite.

## Routes

All C2 routes are mounted under real admin auth:

`/api/admin/checkout`

Routes:

- `GET /rules`
- `POST /rules`
- `GET /rules/versions`
- `POST /rules/rollback`
- `GET /orders`
- `GET /orders/:orderId`
- `POST /orders/:orderId/transition`
- `GET /audit`

No C2 admin route is mounted on the public buyer checkout router.

## Rules Versioning

Every admin rules update creates a new `CheckoutRulesVersion` row and points `CheckoutMerchantSetting.activeRulesVersionId` at it.

Rollback does not mutate the old version. It creates a new active version whose rules JSON is copied from the selected historical version.

Rules update and rollback both write `CheckoutAuditLog` rows.

## Risk Notes Contract

C1 persisted quote `riskNotes` on `CheckoutQuote`. C2 rehydrates those persisted notes for internal/admin surfaces.

- Admin order detail can include `riskNotes` as an array.
- Buyer quote/order serializers remain buyer-safe and do not expose `riskNotes`.

## Lifecycle Rules

- `pending_payment` and `pending_advance` cannot become `packed`, `shipped`, or `delivered` until payment confirmation moves them to `confirmed`.
- `confirmed -> packed -> shipped -> delivered` is the normal admin path.
- `confirmed`, `packed`, and `shipped` can be cancelled before delivery.
- `delivered` cannot be cancelled in C2.
- `cancelled`, `expired`, and `refund_due` remain terminal for reconfirmation.
- Repeating the same already-applied transition is idempotent and does not add duplicate timeline, accounting, or audit rows.

## COD Collection Capture

If `payOnDeliveryMinor > 0`, a delivered transition requires COD collection details.

Required behavior:

- Collection amount must equal `payOnDeliveryMinor`.
- Cash may omit a reference.
- Non-cash collection methods require a reference.
- Collection is stored on the checkout order.
- The transition writes checkout timeline/audit rows and a checkout accounting event named `cod_collected`.

COD collection in C2 is an order/accounting event only. It does not create COD custody, does not credit a seller wallet or shipping balance, and does not execute seller/courier settlement.

## Explicit Non-Goals

C2 does not:

- add frontend UI
- activate live payment providers
- capture payment through Razorpay, Cashfree, or another provider
- create checkout split settlement
- create COD custody
- credit seller `shipping_balance`
- move wallet money
- post to wallet journal tables
- create payout, bank transfer, or cashout behavior
- settle couriers or sellers
- touch W0/W1/W2/W3 wallet behavior
- add n8n, GCP, Cloud Run, live DB, or deploy behavior

Live provider activation remains a later C6 gate.

## C5 Parity Notes

C5 adds combined backend smoke coverage for:

- rules-driven COD fee waiver behavior
- admin lifecycle transitions
- delivered COD collection validation
- admin audit log visibility
- buyer readback of collected COD status
- admin-only risk-note visibility

C5 does not change C2 scope. COD collection remains an order/accounting event only, not custody or settlement.
