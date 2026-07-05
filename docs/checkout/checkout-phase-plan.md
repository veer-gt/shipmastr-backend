# Checkout Phase Plan

C0 is complete when this plan, the integration audit, and the ledger decision memo exist. Later phases require separate approval.

## C1 - Backend Quote / Order / Payment Foundation, Mock/Sandbox Only

### Scope

- Add checkout quote engine.
- Add buyer checkout order foundation.
- Add payment attempt records in mock/sandbox mode.
- Add signed buyer order token access.
- Add idempotent order creation with request-hash replay semantics.
- Add provider-webhook-shaped mock flow and raw-body verification design.
- Preserve fixed reference hardening.

### Files Likely Touched

- `prisma/schema.prisma`
- new migration under `prisma/migrations/*_checkout_foundation`
- `src/modules/checkout/*`
- `src/routes/index.ts`
- `src/middleware/*` if buyer token middleware is shared
- tests under `src/modules/checkout/*.test.ts`

### Migrations Likely Required

Additive checkout-domain tables, likely:

- checkout quotes
- checkout orders
- checkout payment attempts
- checkout provider events
- checkout timeline
- checkout idempotency/request hash records if existing `IdempotencyKey` is not sufficient

Owner review is required before final schema.

### Routes Likely Added

Mock/sandbox only, naming subject to owner review:

- `POST /v1/checkout/quote`
- `POST /v1/checkout/orders`
- `GET /v1/checkout/orders/:id`
- `POST /v1/checkout/payments/:id/initiate`
- `POST /v1/checkout/payments/:id/mock-complete`
- `POST /v1/webhooks/checkout/:provider` or equivalent provider-specific path

### Tests Required

- quote returns stable option shape for all three lowercase modes
- COD fee waiver above threshold
- risky pincode blocks full COD and allows partial COD when configured
- blocked pincode disables COD modes
- idempotent order creation same key/body replays
- same idempotency key/different body conflicts
- order read/payment mutation requires signed token/session
- late payment after cancellation/expiry becomes `refund_due`
- webhook cross-validates amount, currency, gateway order ref, and gateway payment ref
- buyer serializer excludes `riskNotes`
- no wallet ledger writes
- no live provider calls

### Safety Boundaries

- mock/sandbox only
- no live Razorpay/Cashfree/provider calls
- no checkout settlement
- no COD custody
- no wallet W3 activation
- no fulfillment shipment booking
- no seller shipping balance credit

### Acceptance Checklist

- fixed reference hardening preserved
- all money values are integer paise
- lowercase modes and buyer contract preserved
- Postgres tests pass
- no wallet behavior changed
- no public buyer order access by ID alone

## C2 - Admin Rules / Order Lifecycle / Audit APIs

### Scope

- Add admin checkout rule management.
- Add versioning/rollback/audit for rules.
- Add admin order detail and lifecycle transition APIs.
- Add COD collection recording on delivery.
- Add refund_due review visibility.

### Files Likely Touched

- `src/modules/checkout/checkout-admin.routes.ts`
- `src/modules/checkout/checkout-rules.service.ts`
- `src/modules/checkout/checkout-lifecycle.service.ts`
- `src/modules/audit/*` if shared audit helper is reused
- `src/routes/index.ts`

### Migrations Likely Required

- checkout rule versions
- checkout admin audit/lifecycle metadata if not covered by C1 tables

### Routes Likely Added

- `GET /v1/admin/checkout/rules`
- `PUT /v1/admin/checkout/rules`
- `GET /v1/admin/checkout/rules/versions`
- `POST /v1/admin/checkout/rules/rollback`
- `GET /v1/admin/checkout/orders/:id`
- `POST /v1/admin/checkout/orders/:id/transition`
- `GET /v1/admin/checkout/audit`

### Tests Required

- admin JWT required
- rule validation rejects invalid values
- rollback creates a new version
- lifecycle transition matrix
- delivery with COD requires collection method/reference policy
- audit rows are written
- buyer token cannot call admin lifecycle routes

### Safety Boundaries

- no provider calls
- no shipment booking
- no wallet posting
- no payout/cashout

### Acceptance Checklist

- admin-only lifecycle mutation
- audit trail present
- COD collection captured without COD custody claim
- no buyer-visible `riskNotes`

## C3 - Buyer Checkout UI Integration Using Provided Components

### Scope

- Integrate buyer checkout components into the chosen buyer host.
- Preserve backend contract exactly.
- Persist buyer `orderToken`.
- No live provider invocation until later gate.

### Buyer UI Host Recommendation

Primary recommendation: mount buyer checkout in `storefront-renderer` because it owns merchant storefront traffic and custom-domain routing.

Secondary use: seller-panel `/merchant/checkout` should manage merchant checkout configuration/order operations, not buyer checkout.

Dedicated checkout app: keep as fallback if storefront-renderer cannot safely own checkout state, routing, and token persistence.

### Files From checkout-components To Copy

From `/Users/mac/shipmastr-agent/checkout-components.zip`:

- `PaymentOptions.jsx`
- `OrderStatus.jsx`
- `checkout.css`
- `CheckoutPage.example.jsx` as a mapping reference, not necessarily final component name
- `API-CONTRACT.md` as implementation contract reference

### Mapping CheckoutPage.example.jsx To Shipmastr

- Replace `API_BASE = "/api"` with the host app's API base convention.
- `POST /api/quote` maps to the future C1 checkout quote endpoint.
- `POST /api/orders` maps to future C1 checkout order creation.
- `POST /api/payments/:id/mock-complete` remains mock/sandbox only.
- Real provider handoff waits for later gated phase.

### orderToken Persistence

- Guest checkout: store `orderToken` in `sessionStorage` keyed by order ID, e.g. `shipmastr:checkout:order:<orderId>`.
- Logged-in buyer, if supported later: bind to real session/JWT and still avoid ID-only access.
- On refresh, retrieve token and pass it as `x-order-token`.

### Contract To Preserve

- modes: `prepaid`, `partial_cod`, `full_cod`
- `order.state`
- `order.mode`
- `codCollection.status`
- `codCollection.amount`
- `codCollection.method`
- `codCollection.reference`
- `codCollection.collectedAt`
- timeline rows: `at`, `type`, `message`, `actor`
- buyer UI must never reference `riskNotes`

### CSS / Design Token Plan

- Use `checkout.css` as-is where possible.
- Reuse seller-panel design tokens when hosted inside seller-panel.
- If hosted in storefront-renderer, import compatible tokens from seller-panel rather than inventing a new color system.
- Keep checkout accessible and mobile-safe.

### Files Likely Touched

- `storefront-renderer/app/**`
- `storefront-renderer/components/**` if components directory is introduced
- or seller-panel buyer-host files only if owner rejects storefront-renderer host

### Migrations Likely Required

None in C3 if C1/C2 already created backend schema.

### Routes Likely Added

Frontend route only, likely storefront checkout path. Exact path depends on storefront product/cart routing.

### Tests Required

- component renders all three options
- disabled options use `option.available=false`
- `option.reason` and `option.badge` display correctly
- order status uses correct contract
- token survives refresh
- no `riskNotes` read
- no live provider invocation

### Safety Boundaries

- no backend schema changes in C3
- no live provider calls
- no checkout settlement activation
- no W3 changes

### C3 Acceptance Checklist

- components integrated directly, not rebuilt from scratch
- unavailable quote options rendered disabled using `option.available`
- `option.reason` and `option.badge` displayed
- buyer order status reads correct order contract
- `orderToken` survives refresh
- no live Razorpay invocation until later gated phase

## C4 - Seller/Admin Panel Checkout UI

### Scope

- Merchant checkout settings workspace.
- Admin rules/versioning/lifecycle screens.
- Checkout order list/detail views.
- Refund_due review and audit visibility.
- Links to fulfillment order after handoff.

### Files Likely Touched

- `seller-panel/src/pages/*`
- `seller-panel/src/services/api.js` or new checkout API service
- `seller-panel/src/layouts/MerchantLayout.jsx`
- `seller-panel/src/App.jsx`

### Migrations Likely Required

None if backend C1/C2 schema is complete.

### Routes Likely Added

- `/merchant/checkout`
- `/admin/checkout`
- maybe `/merchant/checkout/orders/:id`

### Tests Required

- auth redirects
- API error states
- no fake counts/orders
- admin-only controls hidden from merchant
- no provider call buttons until activation gate

### Safety Boundaries

- no live payment provider calls
- no settlement execution
- no custody/payout
- no direct wallet mutation

### Acceptance Checklist

- merchant can view checkout readiness/configuration
- admin can view lifecycle/audit data
- actions are guarded and backend-backed
- no fake checkout success states

## C5 - Postgres E2E Smoke And Hardening Parity

### Scope

- Run real Postgres local/test E2E over C1-C4.
- Prove parity with fixed reference smoke.
- Harden edge cases before live-provider gate.

### Files Likely Touched

- `src/modules/checkout/*.test.ts`
- scripts under `scripts/checkout-*` if local smoke CLI is needed
- docs under `docs/checkout/*`

### Migrations Likely Required

No new migration expected unless C5 finds schema gaps.

### Routes Likely Added

None expected.

### Tests Required

- quote math parity
- idempotent order create parity
- token-gated buyer access
- mock capture idempotency
- webhook replay and payload mismatch
- late payment refund_due
- expired advance
- admin lifecycle and COD collection
- buyer serializer excludes risk notes
- no W3 settlement activation

### Safety Boundaries

- local/test only
- no live provider
- no production DB
- no deploy

### Acceptance Checklist

- all fixed-reference hardening covered in tests
- no generated artifacts left in diff
- docs updated with exact C6 blockers

## C6 - Live Payment-Provider Activation Gate, Not Activation

### Scope

- Add a read-only live-provider readiness report.
- Check legal, accounting, provider, webhook, refund, operations, owner, and rollback evidence.
- Confirm no W3 settlement/custody/payout activation occurs by accident.

### Files Likely Touched

- `src/modules/checkout/checkout-activation-gate.service.ts`
- `scripts/checkout-activation-gate.mjs`
- `docs/checkout/*`
- tests for activation gate

### Migrations Likely Required

Prefer none. If evidence is stored, additive evidence/audit tables may be required after owner review.

### Routes Likely Added

Prefer none for C6 unless an internal/admin read-only readiness route is explicitly approved.

### Tests Required

- defaults blocked
- missing provider evidence blocks
- missing webhook/refund evidence blocks
- production-like runtime warns/blocks
- complete evidence returns review-ready, not activated
- `--execute` unavailable or rejected
- no provider calls

### Safety Boundaries

- not activation
- no live payment capture
- no checkout settlement
- no COD custody
- no payout/bank movement
- no W3D bypass

### Acceptance Checklist

- activation report is machine-readable
- all live provider blockers explicit
- owner review required before any live key/env/provider rollout

