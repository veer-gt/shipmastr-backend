# Checkout C1 Backend Foundation

C1 adds the backend quote/order/payment foundation for Shipmastr Checkout. It is mock/sandbox only and does not activate live payment collection, checkout split settlement, COD custody, wallet money movement, seller payouts, courier settlement, bank transfer, cashout, GCP, n8n, or deployment behavior.

## Scope Added

- Public checkout routes under `/api/checkout` and `/v1/checkout`.
- Server-side quote engine for lowercase modes:
  - `prepaid`
  - `partial_cod`
  - `full_cod`
- Persisted checkout quotes with TTL.
- Buyer checkout orders stored in separate checkout tables, not the existing fulfillment/import `Order` model.
- Nullable `fulfillmentOrderId` handoff field for a later explicit fulfillment phase.
- Dedicated `CheckoutIdempotencyKey` table with request-hash replay semantics.
- Signed buyer order token for order read and mock payment actions.
- Mock/sandbox payment intent and capture flow.
- Separate checkout accounting events for auditability.
- Buyer-safe serializers that omit `riskNotes`.
- Persisted quote `riskNotes` are intentionally internal. C2 admin detail can read them, but buyer serializers continue omitting them.
- C5 adds hardening-parity smoke coverage for this C1 behavior using the existing backend in-memory/mocked checkout test harness. C5 is not a live-database end-to-end suite.

## Database Shape

Migration:

`20260705160000_checkout_partial_cod_foundation`

Tables:

- `checkout_rules_versions`
- `checkout_merchant_settings`
- `checkout_quotes`
- `checkout_orders`
- `checkout_order_timeline`
- `checkout_payments`
- `checkout_accounting_events`
- `checkout_idempotency_keys`
- `checkout_audit_logs`

The migration is additive. It does not create checkout wallet, custody, settlement, payout, or bank-transfer tables.

## Idempotency

C1 intentionally does not reuse the existing `IdempotencyKey` table because that table does not store a request/body hash.

`CheckoutIdempotencyKey` is unique by:

- `merchantId`
- `operation`
- `idempotencyKey`

Behavior:

- Same merchant + operation + key + same request hash replays the original result.
- Same merchant + operation + key + different request hash returns conflict.
- Order creation and mock payment capture use this dedicated table.
- Stored idempotency response payloads are PII-safe replay pointers, not full buyer/customer responses.

## Payment Modes

### Prepaid

- `payNow > 0`
- `payOnDelivery = 0`
- order state: `pending_payment`
- mock payment purpose: `full_payment`

### Partial COD

- `payNow > 0`
- `payOnDelivery > 0`
- order state: `pending_advance`
- mock payment purpose: `advance`
- captured advance confirms the order

### Full COD

- `payNow = 0`
- `payOnDelivery > 0`
- order state: `confirmed`
- no payment intent is created in C1

## Late Payment Behavior

If a mock payment capture arrives after an order is `cancelled` or `expired`:

- the order becomes `refund_due`
- the payment becomes `refund_due`
- the order is never reconfirmed
- checkout accounting records both the capture and refund-due marker

## Webhook Cross-Validation Boundary

C1 stores payment fields needed for future webhook cross-validation:

- internal checkout payment id
- amount
- currency
- gateway intent/order refs
- gateway payment ref when applicable

C1 does not add a live payment-provider webhook route. C5 proves these fields are retained for readiness. Actual live webhook signature, replay, and amount/currency/order-ref cross-validation remain a C6 gate.

## Explicit Non-Goals

C1 does not:

- call Razorpay, Cashfree, or any live payment provider
- add live payment webhooks
- move money
- create COD custody
- credit seller `shipping_balance`
- post to wallet `JournalEntry` / `JournalPosting`
- activate W3 checkout settlement
- create fulfillment/import `Order` rows automatically
- book couriers, create AWBs, labels, manifests, or payouts
- add buyer UI
- add admin/seller UI
- add n8n, GCP secret, Cloud Run, live DB, or deploy behavior

Live payment provider activation and live webhook validation remain gated for later phase C6.

## C2 Follow-Up Boundary

C2 adds admin rules, lifecycle, COD collection recording, and audit APIs on top of the C1 tables.

C2 still does not:

- add frontend UI
- activate live payment
- create COD custody
- move wallet money
- credit seller `shipping_balance`
- settle sellers or couriers
- call payment providers
