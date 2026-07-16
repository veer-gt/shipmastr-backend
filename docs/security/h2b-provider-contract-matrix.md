# H2B provider contract matrix

This is a source-backed contract inventory for a future public ingress. It is
not a live provider registration and does not change any application route.
Sources were accessed 2026-07-16.

## Common contract

| Concern | Contract |
| --- | --- |
| Endpoint identity | Opaque per-connection identifier, digest-bound to one `PlatformConnection`; never a merchant ID or sequential database ID |
| Authentication | Provider HMAC over the exact bounded raw body; tenant-scoped vault credential; no global fallback |
| Admission | Provider allowlist, exact identifier lookup, connection enabled, bounded bytes, supported topic, then atomic dedupe reservation |
| Response | Stable, sanitized status; no raw body, credential, signature, authorization, or provider payload |
| Processing | Synchronous admission/ack only; asynchronous normalization/import preparation |
| Mutation boundary | No synchronous order, shipment, inventory, payment, wallet, ledger, settlement, or provider write |
| Disable/revoke | Connection and credential status are checked on every delivery; revocation invalidates future deliveries |

## Shopify

| Item | Initial contract |
| --- | --- |
| Topic allowlist | `orders/create`, `orders/updated` |
| Required evidence | `X-Shopify-Topic`, `X-Shopify-Hmac-Sha256`, `X-Shopify-Shop-Domain`, `X-Shopify-Webhook-Id`; retain event id where present for safe dedupe metadata |
| Verification | Base64 HMAC over raw bytes with the connection's current or still-valid previous secret |
| Timestamp | `X-Shopify-Triggered-At` is useful metadata only; it is not treated as a cryptographic freshness proof. Replay defense is persistent delivery-id dedupe. |
| Idempotency | Delivery id first; event hash fallback only where provider delivery id is absent, always scoped by merchant and connection |
| Ack rule | Acknowledge only after durable admission reservation; do not perform synchronous import |
| Registration/runtime allowlists | Registration may request only the two initial order topics; runtime rejects every topic outside the same allowlist. |
| Retry policy | Exact Shopify retry/backoff behavior requires provider-contract verification before implementation; do not infer a number from this matrix |
| Reference | [Shopify delivery structure](https://shopify.dev/docs/apps/build/webhooks/delivery-structure), [Shopify subscriptions](https://shopify.dev/docs/apps/build/webhooks/subscribe) |

## WooCommerce

| Item | Initial contract |
| --- | --- |
| Topic allowlist | `order.created`, `order.updated` |
| Required evidence | `X-WC-Webhook-Topic` or resource/event fields, `X-WC-Webhook-Signature`, and delivery id (`X-WC-Webhook-Delivery-Id` or supported fallback) |
| Verification | WooCommerce's signature is HMAC over the exact request body bytes with the connection's current or still-valid previous secret; do not reconstruct JSON before verification. |
| Delivery behavior | Provider delivery is background-oriented and can be disabled after consecutive non-2xx responses; the adapter must return a stable acknowledgement after reservation |
| Registration/runtime allowlists | Registration and runtime both allow only `order.created` and `order.updated`; resource/event combinations must normalize to those names. |
| Source uncertainty | Exact WooCommerce retry/backoff timing and deployment-specific header behavior require primary-source and compatibility testing before implementation. |
| Reference | [WooCommerce REST API webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks) |

Some WooCommerce versions, extensions, or store configurations may emit
`order.created` and `order.updated` close together for one newly created order.
Shipmastr must tolerate this compatibility behavior without treating it as a
universal provider guarantee. Delivery idempotency is
`provider + connectionId + deliveryId`; external-order import idempotency is
`merchantId + connectionId + externalOrderId`. `order.created` creates or
initializes one external-order import aggregate, while `order.updated` upserts
or merges into it. If updated arrives first, it creates or updates a
provisional aggregate; a later created converges on that aggregate, and
deterministic precedence prevents stale accepted state from overwriting newer
state. Both delivery records remain separately auditable, but only one
external-order aggregate exists and no event mutates inventory.

Required future tests cover created→updated, updated→created, concurrent
created/updated, replay of either delivery, distinct delivery IDs for one
external order, identical external IDs across connections and merchants, one
aggregate/no duplicate canonical order, both sanitized delivery references,
and no inventory effect.

## Magento / Adobe Commerce

| Item | Initial contract |
| --- | --- |
| Profile | `SHIPMASTR_MAGENTO_EXTENSION_V1` |
| Initial topics | `shipmastr.order.committed.v1` |
| Required evidence | `X-Magento-Topic: shipmastr.order.committed.v1`, `X-Magento-Event`, `X-Magento-Webhook-Id`, `X-Magento-Signature` |
| Verification | Base64 HMAC-SHA256 over raw bytes; extension owns local outbox/worker and must not make a synchronous provider-to-Shipmastr call during the originating Commerce transaction |
| Body and delivery | Deterministic serialization, unique delivery id, bounded retry/backoff, and dead-letter state are extension responsibilities. Secret rotation must preserve the key version needed for queued deliveries; disable/uninstall stops new sends and leaves evidence for reconciliation. |
| Registration/runtime allowlists | Installation enables only the single initial profile topic; runtime rejects all other topics. Registration is an explicit extension/configuration step, never an implicit Shipmastr provider write. |
| Current repository status | Validation and `PlatformOrderImport` foundation exist; a Shipmastr Magento extension, outbox, and worker are not present. Full order creation remains deferred. |
| Reference | Adobe [Webhooks](https://developer.adobe.com/commerce/extensibility/webhooks/), [I/O Events](https://developer.adobe.com/commerce/extensibility/events/), [consume events](https://developer.adobe.com/commerce/extensibility/events/consume-events) |

Adobe native Webhooks are synchronous and can affect an originating Commerce
operation; Adobe I/O Events are a separate asynchronous delivery path. Both
are deferred or a separate sub-phase rather than silently treated as the
Shipmastr extension protocol.

The existing `sales_order_place_after` and `sales_order_save_after` values are
legacy/internal foundation candidates only, not public H2B topics.

## Adobe Commerce profiles (separate from the extension profile)

| Profile | Compatibility and authentication | Registration / payload model | Decision |
| --- | --- | --- | --- |
| `ADOBE_COMMERCE_IO_EVENTS` | Adobe I/O Events and App Builder deployment compatibility must be verified per supported Commerce edition; authentication and signed delivery are Adobe-event infrastructure concerns, not the Shipmastr HMAC profile. | Event registration and journaling are configured in Adobe's event system; consumers may use a webhook URL, Runtime Action, or EventBridge and may fetch additional payload data. | `DEFERRED_OR_SEPARATE_SUBPHASE`; requires an App Builder and edition compatibility review. |
| `ADOBE_COMMERCE_NATIVE_WEBHOOK` | Synchronous Webhooks can affect the originating Commerce operation. | Registration and handler execution are Adobe Webhooks contracts, not the Shipmastr extension outbox. | `DEFERRED`; not the default order-ingestion path. |
| `UNSUPPORTED_OR_MANUAL_IMPORT` | No public callback or provider secret is assumed. | Operator-controlled import only. | Safe fallback until a profile is approved. |

See Adobe [Webhooks](https://developer.adobe.com/commerce/extensibility/webhooks/),
[I/O Events](https://developer.adobe.com/commerce/extensibility/events/),
[consume events](https://developer.adobe.com/commerce/extensibility/events/consume-events),
and [events tutorial](https://developer.adobe.com/commerce/extensibility/events/tutorial/)
(accessed 2026-07-16). These sources describe the App Builder dependency,
journaling/registration options, acknowledgement timing, and payload delivery;
they do not turn this Shipmastr extension profile into an Adobe universal
protocol.

## Current source comparison

The current authenticated ingestion routes are in
`src/modules/platformIntegrations/webhookIngestion/platform-webhook-ingestion.routes.ts:28-65`
and are mounted beneath `requireJwtAuth` at `src/routes/index.ts:140`. The
service recognizes the topic and delivery-id families above in
`src/modules/platformIntegrations/webhookIngestion/platform-webhook.service.ts:85-129`,
then resolves H2A credentials through the tenant-scoped vault at
`src/modules/credentialVault/platform-webhook-credential.service.ts:289-326`.
The existing route contract cannot be reused as public ingress without an
opaque identifier, pre-buffer size gate, and public-route redaction.

All providers use the same admission states (`PENDING`, `ACCEPTED`,
`PROCESSED`, `FAILED`, `DUPLICATE`) and the same tenant/connection dedupe
scope. No unsigned provider timestamp is accepted as freshness proof. Raw
bodies are verified in memory and then discarded; only sanitized metadata and
approved import references are retained.
