# H2B-2 source implementation and scratch proof

Status: dormant source foundation. The public route is disabled by default and
was not deployed, registered with a provider, or exposed outside a local
loopback proof.

## Route gate and byte handling

`H2B_PUBLIC_PROVIDER_INGRESS_ENABLED` defaults to `false`. `src/server.ts`
reserves `/api/public/provider-webhooks` before the global `express.json`
parser. Every method and path under the prefix is terminal: disabled and
enabled unmatched requests return the same safe 404 shape. The disabled gate
does not read the request body, run the parser verification callback, load the
provider router, resolve an endpoint, access Prisma, decrypt a credential,
write telemetry, reserve a delivery, or enqueue work. The app factory used by
the normal server is exercised by loopback tests without starting a listener.

H2B uses `readH2BRawBody`, which checks a numeric `Content-Length` before
attaching data listeners, counts every streamed byte, removes its data listener
and drains/discards the transport on the first byte over the cap, and returns
a safe 413 without parsing partial JSON. The exact raw bytes are passed to HMAC
verification and are not persisted. HTTP parser errors that occur before
Express receives a request are transport rejections, not admissions.

The admission limits are conservative Shipmastr limits, not claims about
provider-wide webhook limits:

| Provider | Limit | Basis |
| --- | ---: | --- |
| Shopify | 262,144 bytes | Conservative Shipmastr cap; Shopify's delivery contract documents raw JSON/HMAC but does not publish a webhook request-body maximum in the reviewed source. |
| WooCommerce | 262,144 bytes | Conservative Shipmastr cap; the reviewed WooCommerce webhook guide documents delivery and retry behavior but no request-body maximum. |
| Shipmastr Magento Extension V1 | 65,536 bytes | Conservative Shipmastr admission limit for SHIPMASTR_MAGENTO_EXTENSION_V1. This custom extension protocol is controlled by Shipmastr and does not inherit Adobe Commerce Webhooks, Adobe I/O Events or Adobe Experience Platform payload limits. |

Sources reviewed 2026-07-16: Shopify [webhook delivery structure](https://shopify.dev/docs/apps/build/webhooks/delivery-structure)
and WooCommerce [webhooks](https://woocommerce.com/document/webhooks/). The
Magento value is an internal Shipmastr policy; it is not an official Adobe
Commerce, Adobe I/O Events, or Adobe Experience Platform payload limit. The
body-reader tests cover declared oversize, exact limit, one byte over,
chunked input, and the no-listener-before-declared-rejection path.

The enabled request sequence validates the exact route and untrusted hint,
checks bounded headers and the hinted `Content-Length`, reads the bounded raw
stream once, then performs exactly one endpoint digest lookup. A declared or
streamed over-limit request is rejected before Prisma, credential lookup, HMAC,
or persistence. The resolved endpoint is passed as an immutable scope to the
admission service, which does not resolve it again.

## Endpoint lifecycle

`H2BConnectionEndpoint` binds a `shp_`, `woo_`, or `mag_` provider-hint prefix
and a 256-bit-plus base64url token to one
merchant and one `PlatformConnection`. Only a SHA-256 digest is stored; the
raw token is returned only from create/rotate. Status returns only provider,
state, activation/grace timestamps, a short non-reversible fingerprint, and
revocation state. Current and previous digests are supported for a bounded
seven-day grace period, and revoke invalidates both immediately. Create,
rotate, and public resolution require an ACTIVE connection; status and revoke
remain available to the owner when a connection is DRAFT, ERROR or DISABLED.
Re-enable does not undo a prior revoke. Authenticated merchant-scoped
lifecycle routes create, read status, rotate, and revoke the endpoint without
provider registration.

The provider hint is untrusted routing syntax used only to select the
pre-lookup byte/header cap. It is never authorization; persisted platform must
match it after the single endpoint resolution. Malformed or unsupported hints
return the same safe 404 without Prisma, while a well-formed unknown token
performs one digest lookup and returns the same safe 404 shape. No artificial
delay is used. The public path is routing only. Merchant and connection scope are derived
from the persisted endpoint; there is no request-supplied merchant ID or
cross-tenant fallback. A small in-process limiter uses a hashed source address
and endpoint fingerprint for malformed/unknown, resolved, invalid-signature,
and oversized-request pressure. It is intentionally not a globally
authoritative multi-instance rate limiter; a later rollout must add a shared
control if that guarantee is required.

## Admission and persistence

`H2BWebhookAdmission` has an atomic unique reservation on
`(platform, connectionId, deliveryId)`. The reservation and one
`H2BWebhookOutbox` row are created in one serializable transaction. Only a
bounded, provider-neutral safe envelope, payload SHA-256, topic, delivery ID,
status, and timestamps are persisted. Raw bodies, HMACs, endpoint tokens,
credentials, authorization, cookies, and buyer PII are not persisted. A
duplicate delivery returns a safe duplicate acknowledgement and cannot create
another outbox item. Reusing a delivery ID with a different topic, scope, or
payload hash is a safe 409 collision and does not create an outbox or aggregate.
The safe envelope converts provider major-unit decimal totals to canonical
minor-unit strings using the reviewed exponent map (INR/USD/EUR/GBP/AED/SGD=2,
JPY/KRW=0, KWD/BHD/OMR=3); it rejects malformed, negative, exponential,
over-precision, unsupported-currency, and unsafe values without floating point.
Header lengths, JSON depth/scalars, line items, and final envelope size are
bounded before persistence.

The initial topic matrix is frozen: Shopify `orders/create` and
`orders/updated`; WooCommerce `order.created` and `order.updated`; and the
semantic Magento topic `shipmastr.order.committed.v1`. Magento internal hook
work remains `TBD_AFTER_MAGENTO_EXTENSION_EVENT_AUDIT`; Magento observer names
such as `sales_order_place_after` are not public topics. Unsupported events are
authenticated first, then acknowledged as ignored without an outbox or
aggregate.

## Worker and convergence aggregate

`H2BWebhookOutbox` is claimed transactionally with a lease, monotonically
increasing claim version, and attempt count. Completion, retry, failure and
admission updates require the exact claim version, so a stale worker is fenced
before it can mutate an aggregate. `H2BWebhookAdmission` has a database
generated monotonic `ingestionSequence` used for total ordering, not the
millisecond receive timestamp. Created/updated topic precedence preserves
accepted update fields when a late create arrives; sanitized admission
references are unioned exactly once.
Expired claims are recoverable. Transient failures remain retryable with a
bounded backoff; after five attempts the item is `DEAD_LETTER`. The worker
only updates the H2B import-preparation state and never creates canonical
Shipmastr orders, shipments, inventory records, provider calls, checkout,
payment, wallet, ledger, or settlement state.

`H2BExternalOrderAggregate` converges one external order by the unique key
`(merchantId, connectionId, externalOrderId)`. Created/updated events retain
sanitized admission references and use database ingestion-sequence precedence,
not arrival timestamps. The aggregate is intentionally separate from the
existing `PlatformOrderImport` rows because this phase is an import-preparation
foundation, not canonical-order creation.

## Scratch proof procedure

The proof uses one uniquely named local PostgreSQL database matching
`shipmastr_scratch_h2b2_<suffix>`, applies every migration from zero, and
rejects non-loopback or non-scratch `DATABASE_URL` values. It creates two
synthetic merchants and Shopify/WooCommerce/Magento connections, encrypts
fixture credentials in memory, exercises the loopback router with raw HTTP,
and deletes every selected row before disconnecting. It covers provider HMACs,
unsupported and forged topics, current/previous credential grace, endpoint
rotation and revocation, active-state and disabled-revoke rules, concurrent
endpoint operations, exact/oversize/chunked body handling before endpoint
lookup, a 16-request duplicate race and delivery collision, transaction
rollback/retry, lease recovery and claim fencing, Woo created/updated
convergence in both orders, cross-tenant rejection, and safe-envelope leakage
checks. The runner prints
only aggregate PASS counts and never prints generated secrets or endpoint
tokens. The scratch database is dropped after the proof and checked absent.

Focused source tests cover the disabled prefix, route ordering/dynamic import,
raw-byte bounds, topic contracts, PII-free envelopes, endpoint fingerprints,
and hashed limiter keys. Full backend tests and existing H2A/auth/security
regressions remain part of the pre-PR validation.

## Deferred items

No provider registration, public ingress, Cloud Run deployment, canary,
shared distributed rate limiter, Magento extension, Magento checkout
replacement, inventory integration, canonical order creation, or staging/
production change is included. The in-process source-network plus provider-hint
limiter is bounded but is not globally authoritative across Cloud Run
instances. Before any H2B-3 canary, reviewed edge/shared abuse controls for
syntactically valid unknown-token traffic are required. Those changes require a
separate review and explicit authorization.
