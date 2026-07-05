# Checkout Phase Plan

C0 is complete when this plan, the integration audit, and the ledger decision memo exist. Later phases require separate approval.

## C1 - Backend Quote / Order / Payment Foundation, Mock/Sandbox Only

Status: implemented as backend foundation in `20260705160000_checkout_partial_cod_foundation`. Live provider activation, settlement execution, COD custody, buyer UI, admin UI, and fulfillment handoff remain separate later phases.

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

- `POST /api/checkout/quote` and `/v1/checkout/quote`
- `POST /api/checkout/orders` and `/v1/checkout/orders`
- `GET /api/checkout/orders/:id` and `/v1/checkout/orders/:id`
- `POST /api/checkout/payments/:id/initiate` and `/v1/checkout/payments/:id/initiate`
- `POST /api/checkout/payments/:id/mock-complete` and `/v1/checkout/payments/:id/mock-complete`

No live provider webhook route is added in C1.

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
- backend tests pass
- no wallet behavior changed
- no public buyer order access by ID alone
- dedicated checkout idempotency records store request hashes and PII-safe replay pointers
- late mock capture after cancelled/expired orders becomes `refund_due`

## C2 - Admin Rules / Order Lifecycle / Audit APIs

Status: implemented as backend/admin APIs only. C2 uses the C1 checkout tables and does not require a new migration.

### Scope

- Add admin checkout rule management.
- Add versioning/rollback/audit for rules.
- Add admin order detail and lifecycle transition APIs.
- Add COD collection recording on delivery.
- Add refund_due review visibility.
- Keep buyer serializers free of `riskNotes` while allowing admin order detail to read persisted quote risk notes.

### Files Likely Touched

- `src/modules/checkout/checkout-admin.routes.ts`
- `src/modules/checkout/checkout-rules.service.ts`
- `src/modules/checkout/checkout-lifecycle.service.ts`
- `src/modules/audit/*` if shared audit helper is reused
- `src/routes/index.ts`

### Migrations Likely Required

C2 uses C1 tables:

- `checkout_rules_versions`
- `checkout_merchant_settings`
- `checkout_order_timeline`
- `checkout_accounting_events`
- `checkout_audit_logs`

No new C2 migration is required.

### Routes Likely Added

- `GET /api/admin/checkout/rules`
- `POST /api/admin/checkout/rules`
- `GET /api/admin/checkout/rules/versions`
- `POST /api/admin/checkout/rules/rollback`
- `GET /api/admin/checkout/orders`
- `GET /api/admin/checkout/orders/:id`
- `POST /api/admin/checkout/orders/:id/transition`
- `GET /api/admin/checkout/audit`

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
- no COD custody
- no seller shipping balance credit
- no frontend or buyer UI

### Acceptance Checklist

- admin-only lifecycle mutation
- audit trail present
- COD collection captured without COD custody claim
- no buyer-visible `riskNotes`
- repeated same transition is idempotent and does not duplicate timeline/accounting/audit rows
- live provider activation remains later C6 gate

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

## C5 - Backend Hardening-Parity Smoke

### Scope

- Port the fixed reference smoke and hardening guarantees into Shipmastr backend tests.
- Follow the existing backend checkout test harness convention, which is mocked/in-memory for C1/C2.
- Harden C1/C2 parity edges before the live-provider gate.
- Do not present this phase as a live-database end-to-end suite.

### Files Likely Touched

- `src/modules/checkout/*.test.ts`
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
- webhook cross-validation readiness fields on `CheckoutPayment`
- late payment refund_due
- admin lifecycle and COD collection
- buyer serializer excludes risk notes
- no W3 settlement activation

### Safety Boundaries

- backend test/docs only
- no live provider
- no frontend
- no live DB or production DB
- no deploy
- no COD custody
- no checkout settlement execution
- no wallet money movement

### Acceptance Checklist

- all fixed-reference hardening covered in tests
- no false live-database end-to-end claim
- no generated artifacts left in diff
- docs updated with exact C6 blockers, including live webhook cross-validation

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
