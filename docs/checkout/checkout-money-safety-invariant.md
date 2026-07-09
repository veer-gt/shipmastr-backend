# Checkout Money Safety Invariant

## Frozen Platform Invariant P1

No monetary amount in any client request is ever an input to pricing, order creation, wallet posting, settlement, shipping charge, COD amount, or ledger entry. Clients send identifiers and quantities only. All money is computed server-side in BIGINT paise.

## Blocker 3 Audit

- `/v1/checkout/quote` and `/api/checkout/quote` are the legacy generic quote routes. In `QUOTE_PRICE_SOURCE=catalog_strict`, they require a checkout session token and resolve each item price from `StorefrontProduct` by `(merchantId, productId)`. Client `priceMinor` is accepted only as ignored tamper evidence.
- `/v1/storefront/checkout/quote` and `/api/storefront/checkout/quote` are the buyer storefront quote-by-reference route. The request carries `storefrontId`, `productId`, quantity, and pincode. The merchant is derived from the storefront row, never from the body, and price is resolved from `StorefrontProduct`.
- `POST /v1/checkout/orders` accepts `quoteId`, mode, customer, and address fields. It re-reads `CheckoutQuote` and writes order, payment, accounting event, COD, discount, and grand total amounts from the persisted quote only.
- Checkout order/payment services do not write seller wallet ledgers, settlement ledgers, payout records, custody ledgers, Razorpay, Cashfree, or courier charge records.
- In production/staging, `QUOTE_PRICE_SOURCE=client_allowed` is a boot-time error. Local/demo test harnesses may use `client_allowed` only outside protected runtime.

## Tamper Handling

If a client sends `priceMinor` or another client-side money echo into the legacy quote/order surface, the value is ignored for computation. Legacy quote emits `checkout_quote_client_money_ignored` telemetry with `delta_minor` so operators can inspect attempted tampering without changing buyer-visible totals.
