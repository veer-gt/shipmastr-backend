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
| Topic allowlist | `orders/create`, `orders/update` |
| Required evidence | `X-Shopify-Topic`, `X-Shopify-Hmac-Sha256`, `X-Shopify-Shop-Domain`, `X-Shopify-Webhook-Id`; retain event id where present for safe dedupe metadata |
| Verification | Base64 HMAC over raw bytes with the connection's current or still-valid previous secret |
| Idempotency | Delivery id first; event hash fallback only where provider delivery id is absent, always scoped by merchant and connection |
| Ack rule | Acknowledge only after durable admission reservation; do not perform synchronous import |
| Retry policy | Exact Shopify retry/backoff behavior requires provider-contract verification before implementation; do not infer a number from this matrix |
| Reference | [Shopify delivery structure](https://shopify.dev/docs/apps/build/webhooks/delivery-structure), [Shopify subscriptions](https://shopify.dev/docs/apps/build/webhooks/subscribe) |

## WooCommerce

| Item | Initial contract |
| --- | --- |
| Topic allowlist | `order.created`, `order.updated` |
| Required evidence | `X-WC-Webhook-Topic` or resource/event fields, `X-WC-Webhook-Signature`, and delivery id (`X-WC-Webhook-Delivery-Id` or supported fallback) |
| Verification | HMAC over raw bytes with the connection's current or still-valid previous secret |
| Delivery behavior | Provider delivery is background-oriented and can be disabled after consecutive non-2xx responses; the adapter must return a stable acknowledgement after reservation |
| Reference | [WooCommerce REST API webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks) |

## Magento / Adobe Commerce

| Item | Initial contract |
| --- | --- |
| Profile | `SHIPMASTR_MAGENTO_EXTENSION_V1` |
| Initial topics | `sales_order_place_after`, `sales_order_save_after` |
| Required evidence | `X-Magento-Topic`, `X-Magento-Event`, `X-Magento-Webhook-Id`, `X-Magento-Signature` |
| Verification | Base64 HMAC-SHA256 over raw bytes; extension owns local outbox/worker and must not make a synchronous provider-to-Shipmastr call during the originating Commerce transaction |
| Current repository status | Validation and `PlatformOrderImport` foundation exist; a Shipmastr Magento extension, outbox, and worker are not present. Full order creation remains deferred. |
| Reference | Adobe [Webhooks](https://developer.adobe.com/commerce/extensibility/webhooks/), [I/O Events](https://developer.adobe.com/commerce/extensibility/events/), [consume events](https://developer.adobe.com/commerce/extensibility/events/consume-events) |

Adobe native Webhooks are synchronous and can affect an originating Commerce
operation; Adobe I/O Events are a separate asynchronous delivery path. Both
are deferred or a separate sub-phase rather than silently treated as the
Shipmastr extension protocol.

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
