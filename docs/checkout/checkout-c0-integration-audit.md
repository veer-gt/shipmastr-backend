# Checkout C0 Integration Audit

C0 is docs/analysis only. It does not add migrations, routes, frontend code, runtime behavior, wallet behavior, payment provider calls, checkout settlement, COD custody, payout, bank movement, cashout, deployment, or live database work.

## References Inspected

- `docs/wallet/w0-implementation-status.md`
- `docs/wallet/w3d-final-activation-gate.md`
- `docs/wallet/wallet-future-backlog.md`: not present
- `docs/wallet/wallet-ledger-source-of-truth.md`: not present
- `prisma/schema.prisma`
- `src/routes/index.ts`
- `src/middleware/auth.ts`
- `src/middleware/jwtAuth.ts`
- `src/middleware/idempotency.ts`
- `src/modules/auth/roles.ts`
- `src/modules/auth/require-permission.ts`
- `src/modules/orders/orders.routes.ts`
- `src/modules/webhooks/webhook.security.ts`
- `src/modules/webhooks/webhooks.routes.ts`
- `src/modules/platformIntegrations/webhookIngestion/platform-webhook-ingestion.routes.ts`
- `src/modules/paymentHolds/payment-hold.service.ts`
- `src/modules/wallet/w3a-checkout-settlement-preview.service.ts`
- `src/modules/wallet/w3-checkout-settlement-read.routes.ts`
- `src/modules/wallet/w3c-early-cod-prequalification.service.ts`
- `src/modules/wallet/w3-activation-gate.service.ts`
- `/Users/mac/shipmastr-agent/partial-cod-server-fixed.zip`
- `/Users/mac/shipmastr-agent/checkout-components.zip`
- root seller-panel route/API conventions under `/Users/mac/shipmastr-fullstack/seller-panel`
- root storefront renderer under `/Users/mac/shipmastr-fullstack/storefront-renderer`

Do not use `/Users/mac/Downloads/partial-cod-server.zip` as a source of truth. The fixed reference is `/Users/mac/shipmastr-agent/partial-cod-server-fixed.zip`.

## Existing Backend Models Relevant To Checkout

### Order

Current `Order` is a merchant fulfillment/import/autonomy record, not a buyer checkout order:

- table model: `Order`
- payment enum: `PaymentMode` with `PREPAID | COD`
- unique key: `(merchantId, externalOrderId)`
- buyer fields are fulfillment-oriented and PII-bearing: name, phone, email, address lines, pincode, city/state/country
- fulfillment fields: weight, package dimensions, product description, HSN, pickup location, courier override
- risk/autonomy fields: COD/RTO risk scores, address quality, needs-attention reasons, seller notes
- relations: `RiskScore`, `WebhookEvent`, `ShipmentDetails`, `OrderIntelligence`, `PredictionOutcome`, `OrderDataSignals`, `AutonomousAction`, buyer communication events, action outcomes
- status enum: `OrderStatus` with fulfillment states such as `CREATED`, `RISK_SCORED`, `READY_TO_SHIP`, `SHIPPED`, `DELIVERED`, `NDR`, `RTO`, `CANCELLED`

The current `Order` model treats `paymentMode` as fulfillment payment mode, not buyer checkout mode. It does not support lowercase `prepaid | partial_cod | full_cod`.

### Shipment

There is a separate `Shipment` table for shipping network operations:

- table model: `Shipment`, mapped to `shipments`
- payment enum: `ShippingPaymentMode` with lowercase `prepaid | cod`
- fields include seller ID, order ID, external order ID, pickup location, courier partner refs, AWB/tracking, dimensions, COD amount, declared value, and tracking events
- relations include provider refs, rates, tracking events, and weight proof sessions

Checkout C1 should hand off confirmed orders to fulfillment/shipment creation only after buyer checkout state is final enough. It should not book couriers or create AWBs as part of C1.

### Payment And Payment Holds

There is no first-class buyer payment model for checkout today. Existing relevant finance/payment-adjacent models include:

- `PaymentHold`: finance hold against merchant/order/AWB/reconciliation result with `amount Decimal`, status, reason, metadata
- `FinanceApprovalRequest`
- `PaymentBlockNote`
- wallet ledger models under W0/W1/W2/W3

`PaymentHold` is not a checkout payment attempt table. It is a finance control/hold construct and should not be reused as buyer payment capture state.

### Wallet / Ledger

Wallet models exist and are deliberately gated:

- `WalletOwner`
- `WalletAccount`
- `AccountTypeConfig`
- `JournalEntry`
- `JournalPosting`
- `AccountBalance`
- `WalletHold`
- `WalletTopupIntent`
- `WalletEventsOutbox`

W0-W3D are not checkout implementation. They provide shadow/import, sandbox wallet, instruction-only COD, checkout-settlement preview, early-COD prequalification preview, and a final activation gate. Checkout C1 must not post directly to wallet ledger or activate W3.

### Webhook Events

There are two webhook concepts:

- Merchant subscription/outbox: `WebhookSubscription`, `WebhookEventOutbox`
- Carrier/platform ingestion: `WebhookEvent`, platform webhook ingestion routes

Existing carrier webhooks use raw-body HMAC verification through `verifyWebhookSignature`, replay uniqueness on `(provider, externalId)`, and safe order status updates.

Checkout provider webhook design in C1/C2 should reuse these conventions, but must have its own checkout payment event tables and must cross-validate amount, currency, gateway order ref, and gateway payment ref before capture.

### Idempotency

Current `IdempotencyKey` is scoped by `(merchantId, route, key)` and `requireIdempotency` stores the response for replay. It does not currently store a request hash. The fixed reference server requires:

- same idempotency key + same body -> replay response
- same idempotency key + different body -> conflict
- in-flight duplicate -> retry later

C1 should preserve the stronger fixed-reference behavior for buyer order creation, not rely blindly on response-only idempotency.

### Admin/Auth

Route conventions:

- admin routes use `requireAdminJwt`
- seller/merchant routes use `requireJwtAuth`
- internal routes use `requireInternalSecret`
- role constants and permissions live in `src/modules/auth/roles.ts`
- additional permission guard helpers live in `src/modules/auth/require-permission.ts`

Buyer checkout access cannot use seller/admin JWT by default because guest checkout is valid. The reference server requires signed order tokens for buyer reads/payment actions. C1 should introduce signed buyer order capability tokens or real buyer sessions, never public order ID access.

## Existing Route Conventions Found

`src/routes/index.ts` uses `/v1`-normalized API mounting at the frontend edge. Notable route groups:

- `/orders` guarded by `requireJwtAuth`
- `/webhooks` currently public router, with per-route signature checks
- `/admin/*` guarded by `requireAdminJwt`
- `/internal/*` guarded by `requireInternalSecret`
- `/seller/wallet/w3/checkout` guarded by `requireJwtAuth`
- `/admin/wallets/w3/checkout` guarded by `requireAdminJwt`
- `/internal/wallet/w3/checkout` guarded by `requireInternalSecret`

Existing order routes are seller/merchant-authenticated fulfillment routes. There is no buyer-public checkout route set yet.

Recommended future checkout route families, subject to owner review before C1:

- buyer quote/order/payment route family under a clearly named checkout prefix, not `/orders` directly
- admin checkout rules/lifecycle/audit route family under `/admin/checkout`
- provider webhook under `/webhooks/checkout/:provider` or similarly explicit path
- seller-safe read/config routes under `/seller/checkout` or `/merchant/checkout` only after auth, audit, and scope are defined

## Existing Razorpay / Payment Integration

No active backend Razorpay module was found in current Shipmastr source. Existing backend payment-related code is finance holds, wallet preview/sandbox docs, webhooks, and payment-mode fields.

The fixed reference zip contains a Razorpay adapter and webhook path:

- mock gateway by default
- production Razorpay order creation guarded by key presence
- checkout signature verification
- webhook signature verification over raw body
- replay protection
- payload cross-validation before capture

C1 should start mock/sandbox only and must not introduce live Razorpay calls until a later activation gate.

## Existing Seller/Admin Frontend Conventions

Root seller-panel conventions:

- API client normalizes `VITE_API_URL` to `/v1` in `seller-panel/src/services/api.js`
- auth tokens use local storage keys such as `shipmastr_token`
- admin/merchant/seller routes are React Router routes in `seller-panel/src/App.jsx`
- merchant layout already has a Business nav item for `/merchant/checkout`
- `/merchant/checkout` currently renders `MerchantFunctionPage page="checkout"` as a control-plane/workspace shell, not a buyer checkout host
- admin UI uses API service helpers and protected layouts

Seller-panel should host C4 merchant/admin configuration and monitoring surfaces. It should not be the primary buyer checkout surface unless Shipmastr intentionally serves hosted checkout from dashboard infrastructure.

## Buyer UI Host Inventory

### storefront-renderer

The root repo has a dedicated Next.js App Router `storefront-renderer`:

- host-header based SaaS storefront routing
- `SHIPMASTR_API_BASE_URL` for backend lookup
- active/pending/suspended storefront presentation
- no Prisma/provider SDKs in middleware
- current page is mostly a hero/storefront shell with "secure checkout" language but no cart/checkout runtime

Recommendation: primary C3 buyer checkout host should be `storefront-renderer` if storefront domains are the intended buyer traffic path. It already owns merchant storefront traffic and domain-based presentation. C3 can mount checkout under a path such as storefront checkout/product checkout once backend contracts exist.

### seller-panel

Seller-panel has `/merchant/checkout` and dashboard/admin shells. Recommendation: use seller-panel for seller/merchant/admin checkout management, rules, order lifecycle, and audit surfaces in C4, not buyer checkout.

### Dedicated checkout app

Use a dedicated checkout app only if storefront-renderer cannot safely host cart/session/token state or if checkout needs stronger isolation from storefront rendering. This is a product/infra decision for C3, not C0.

## Inventory: partial-cod-server-fixed.zip

Inspected path: `/Users/mac/shipmastr-agent/partial-cod-server-fixed.zip`.

Important files:

- `partial-cod-server/src/services/quoteEngine.js`
- `partial-cod-server/src/routes/quote.js`
- `partial-cod-server/src/routes/orders.js`
- `partial-cod-server/src/routes/payments.js`
- `partial-cod-server/src/routes/webhook.js`
- `partial-cod-server/src/routes/admin.js`
- `partial-cod-server/src/services/payments.js`
- `partial-cod-server/src/services/razorpay.js`
- `partial-cod-server/src/services/ledger.js`
- `partial-cod-server/src/middleware/idempotency.js`
- `partial-cod-server/src/middleware/orderAccess.js`
- `partial-cod-server/src/serializers.js`
- `partial-cod-server/test/smoke.mjs`

Behavior inventory:

- Quote engine produces exactly three lowercase modes: `prepaid`, `partial_cod`, `full_cod`.
- All money is integer paise.
- Every option has a stable shape whether available or unavailable.
- COD fee waiver exists above configurable cart threshold.
- Partial COD can waive COD fee independently.
- Full COD can be blocked on risky pincodes while partial COD remains available when policy forces advance.
- Blocked pincode can make COD options unavailable while prepaid remains available.
- Order creation is idempotent and uses server-side persisted quote amounts, not client-submitted amounts.
- Idempotency in the fixed server stores request hash and rejects reused key with changed body.
- Order creation returns a signed `orderToken`; buyer reads/payment actions require it.
- Payment capture is shared by mock endpoint and provider webhook.
- Late payment after cancellation/expiry becomes `refund_due` and never reconfirms the order.
- Webhook capture cross-validates amount, currency, and gateway order/payment ref before touching capture logic.
- Webhook replay protection acknowledges duplicates without reprocessing.
- Buyer serializers use lowercase `order.state`, `order.mode`, `codCollection`, and `timeline` fields.
- Buyer serializer intentionally excludes `riskNotes`; admin serializer includes them.
- Admin lifecycle transitions cover packing, shipping, delivery, cancellation, COD collection, rules versioning, rollback, and audit.
- Smoke coverage includes admin auth, rules, quote math, idempotent order creation, buyer token access, mock capture, ledger legs, lifecycle, COD collection, webhooks, late refund_due behavior, risky pincode, and expiry worker.

Non-negotiable hardening to preserve:

1. COD fee waiver above configurable cart threshold.
2. Late payment after cancellation/expiry becomes `refund_due` and never reconfirms the order.
3. Webhook payload cross-validates amount, currency, gateway order ref, and gateway payment ref before capture.
4. Buyer order/payment access requires signed token or real session, never ID alone.
5. Frontend contract uses lowercase modes and `order.state` / `order.mode`; buyer serializer never exposes `riskNotes`.

## Inventory: checkout-components.zip

Inspected path: `/Users/mac/shipmastr-agent/checkout-components.zip`.

Files:

- `PaymentOptions.jsx`
- `OrderStatus.jsx`
- `checkout.css`
- `CheckoutPage.example.jsx`
- `API-CONTRACT.md`

Contract inventory:

- `PaymentOptions.jsx` expects quote options for lowercase `prepaid`, `partial_cod`, `full_cod`.
- Disabled options render via `option.available=false`; `option.reason` is displayed.
- `option.badge` is displayed when available.
- CTA text is derived from `payNow` / `payOnDelivery`.
- `OrderStatus.jsx` expects lowercase `order.state` and `order.mode`.
- `codCollection` shape is `{ status, amount, method, reference, collectedAt }`.
- `timeline` rows are `{ at, type, message, actor }`.
- `riskNotes` must never appear in buyer UI.
- `CheckoutPage.example.jsx` shows plain fetch wiring and notes that `orderToken` must persist across refresh, e.g. `sessionStorage` keyed by order ID.
- `checkout.css` is designed to reuse seller-panel design tokens and should not introduce a second color system.

## Wallet W3 Overlap Analysis

Existing wallet W3 code is under `src/modules/wallet` and is not buyer checkout:

- W3A: checkout settlement shadow preview service. It calculates preview receivables/allocation buckets from string minor-unit inputs. It does not capture payments, create payouts, create custody, move money, credit shipping balance, or activate checkout settlement.
- W3B: protected read/export-preview routes for W3A preview batches under `/admin/wallets/w3/checkout`, `/seller/wallet/w3/checkout`, and `/internal/wallet/w3/checkout`. Export-preview is read-only.
- W3C: early COD partner prequalification preview only. It does not create loans, fund advances, call partners, capture payments, or create repayment obligations.
- W3D: final activation gate/checklist only. It returns preview-only, blocked, or review-ready; it does not enable anything.

New Shipmastr Checkout is buyer order/payment/COD choice flow:

- quote available payment modes
- create a buyer checkout order
- initiate/capture/mock payments
- expose buyer order status via signed token/session
- hand off confirmed orders to fulfillment/shipping
- provide admin/seller lifecycle and audit views

How C1-C6 should interact with W3:

- C1 should create checkout-domain records and mock/sandbox payment facts only.
- C1 should not post W3A preview batches.
- C1 should not post directly into wallet ledger without a separate owner-approved ledger decision.
- C2 can expose admin rules/lifecycle/audit for checkout, but must not call W3 execution.
- C3 buyer UI should use checkout quote/order/payment APIs only.
- C4 seller/admin UI can display checkout order/rule status and maybe link to W3 preview read surfaces, but not merge concepts.
- C5 should verify backend hardening parity using the established backend test harness.
- C6 should be a live provider activation gate, not activation. It should reconcile with W3D and keep payment/custody/settlement blocked until explicit approvals.

What must not be duplicated:

- Do not duplicate W3A settlement-preview tables or allocation buckets inside checkout C1.
- Do not treat checkout payment capture as W3 settlement execution.
- Do not credit W1 shipping balance from checkout C1.
- Do not create COD custody from checkout C1.
- Do not create early COD funding/loan/partner state from checkout C1.
- Do not expose seller-mutating W3 APIs as part of buyer checkout.

## Existing Order Model Fork Analysis

### Option A: Extend Existing Order Model And Enum

Description: add `partial_cod` and buyer checkout state fields to the current `Order` model.

Pros:

- fewer top-level order tables
- existing risk/autonomy/shipment relations can attach directly
- easier for current seller order list if one order row represents all order states

Cons:

- current `PaymentMode` is uppercase `PREPAID | COD`; buyer contract requires lowercase `prepaid | partial_cod | full_cod`
- current `OrderStatus` is fulfillment-oriented, not buyer checkout state
- current `Order` has many required PII/address/fulfillment fields that may not exist at quote stage
- high dependent relation risk across intelligence, autonomy, webhooks, shipment details, import batches, and reporting
- migration risk is high because adding buyer lifecycle semantics into a hot fulfillment model can break existing order imports and status logic
- idempotent checkout creation keyed by quote/order token does not map cleanly to `(merchantId, externalOrderId)`

### Option B: Separate Checkout Order Tables, Hand Off To Fulfillment Order After Confirmation

Description: add checkout-specific tables for quotes, checkout orders, payment attempts, checkout timeline, buyer token hash/session binding, COD collection state, and admin audit. Create or link to existing `Order` only after confirmation/handoff.

Pros:

- preserves current fulfillment `Order` semantics
- cleanly supports lowercase frontend contract
- isolates quote/payment hardening and buyer tokens
- lets guest checkout exist without forcing fulfillment records too early
- reduces risk to order intelligence/autonomy/import workflows
- makes late `refund_due`, payment attempt, webhook replay, and quote expiry easier to model

Cons:

- requires handoff/linking logic to fulfillment `Order`
- seller/admin UI must reconcile checkout order vs fulfillment order
- more migrations/tables
- reporting must join across checkout and fulfillment domains

### Option C: Hybrid / Linking Model

Description: create checkout tables but also add a nullable link from checkout order to fulfillment `Order`, and optionally a small back-reference on `Order`.

Pros:

- keeps checkout contract separate while enabling fulfillment handoff
- limits changes to existing `Order`
- supports future analytics and seller views across both domains
- can map confirmed checkout orders to fulfillment only when ready

Cons:

- still requires careful migration design
- needs clear ownership of status transitions before and after handoff
- duplicated display surfaces can confuse teams if naming is loose

### Recommendation

Recommend Option C: separate checkout domain tables with an explicit handoff/link to existing fulfillment `Order`.

Final decision: requires owner review before C1 schema is finalized.

Rationale: the current `Order` model appears to be post-import/fulfillment order infrastructure. Checkout needs buyer-facing modes, states, payment attempts, quote expiry, token access, and provider webhook replay semantics that are risky to graft into the existing model directly.

## Risk Areas

- Conflating W3 checkout settlement preview with buyer checkout.
- Reusing current uppercase `PaymentMode` in buyer contract.
- Public buyer reads by order ID without signed token/session.
- Using existing `PaymentHold` as buyer payment attempt state.
- Failing to hash/check request body for idempotency.
- Confirming cancelled/expired orders after late provider capture.
- Letting provider webhook signature alone authorize capture without amount/currency/ref cross-check.
- Exposing `riskNotes` to buyer UI.
- Creating fulfillment `Order` rows too early and triggering intelligence/autonomy/shipping side effects.
- Activating live Razorpay/payment provider calls before C6 gate.

## Exact Integration Seams For C1-C6

### C1

- Add checkout quote/order/payment mock foundation.
- Use separate checkout-domain tables unless owner approves otherwise.
- Preserve fixed reference hardening.
- Mock/sandbox only.

### C2

- Add admin checkout rules, lifecycle, audit APIs.
- Add rule versioning/rollback and admin-only COD collection lifecycle.
- No live provider calls.

### C3

- Integrate `PaymentOptions.jsx`, `OrderStatus.jsx`, `checkout.css`, and `CheckoutPage.example.jsx` mapping into chosen buyer host.
- Use lowercase API contract exactly.
- Persist `orderToken` in `sessionStorage` keyed by order ID for guest checkout.

### C4

- Add seller/admin checkout configuration and order monitoring surfaces in seller-panel.
- Keep buyer checkout separate from merchant control-plane shell.

### C5

- Backend hardening-parity smoke with fixed reference coverage.
- Verify idempotency, refund_due, token access, webhook-readiness fields, quote expiry, lifecycle, COD collection, and serializers.

### C6

- Live payment-provider activation gate only.
- Check legal/accounting/provider/ops/owner evidence.
- Must reconcile with W3D and still not activate settlement/custody/payout without separate approval.
