# Checkout C5 Hardening-Parity Smoke

C5 ports the fixed reference smoke and hardening guarantees into the Shipmastr backend test suite without changing checkout product scope.

## Scope Added

- Adds backend hardening-parity smoke coverage for C1 + C2 behavior together.
- Uses the existing backend in-memory/mocked checkout test harness convention.
- Proves the five reference hardening guarantees that are currently applicable to Shipmastr:
  - configurable cart-value COD fee waiver
  - late payment after cancelled/expired order becomes `refund_due` and never reconfirms as a sale
  - webhook cross-validation readiness fields are retained on `CheckoutPayment`
  - buyer order and payment actions require `x-order-token`
  - frontend/backend quote and order contracts remain stable
- Confirms admin serializer/detail can expose `riskNotes` as an array while buyer serializers omit them.
- Confirms admin lifecycle, COD collection, buyer readback, and audit log behavior together.

## Test Harness Boundary

C5 is not a live-database end-to-end suite.

The backend test suite currently uses mocked/in-memory harnesses for checkout C1/C2. C5 follows that established convention and does not introduce Docker, SQLite, or one-off live database orchestration.

If true live database end-to-end coverage is required, it remains a separate future phase and should be named separately.

## Webhook Boundary

C1/C2 do not include a checkout live-provider webhook route.

C5 does not add one. Instead, C5 proves the persisted `CheckoutPayment` row retains the values a future webhook validator must compare before capture:

- internal payment id
- amount
- currency
- gateway intent/order refs
- gateway payment ref when applicable

Actual live payment-provider webhook signature, replay, and amount/currency/order-ref cross-validation remain a C6 gate.

## Safety Boundaries

C5 does not:

- activate live Razorpay, Cashfree, or another payment provider
- add frontend UI
- create checkout settlement execution
- create COD custody
- credit seller `shipping_balance`
- move wallet money
- post to wallet journal tables
- add payout, bank transfer, or cashout behavior
- touch W0/W1/W2/W3 wallet behavior
- touch n8n, GCP, Cloud Run, secrets, live DB, or deployment behavior

## Validation

C5 should pass:

- `npx prisma validate`
- `npx prisma generate`
- `npm run build`
- `npm test`
- `git diff --check`

Safety greps should remain clean for money floats, live provider calls, settlement/custody/payout language, seller shipping-balance checkout credits, and wallet journal writes from checkout code.
