# Shipmastr Magento extension protocol v1

Protocol name: `SHIPMASTR_MAGENTO_EXTENSION_V1`.

This document defines the first Shipmastr-specific Magento/Adobe Commerce
extension profile. It is not a claim that Adobe Commerce universally emits
these headers, and it does not publish a public endpoint or register a
provider.

## Delivery model

The extension observes the local Commerce order lifecycle and writes a local
outbox entry. A worker sends a bounded HTTPS request to the reviewed Shipmastr
endpoint after the originating Commerce transaction has committed. The
extension must not call Shipmastr synchronously from the Commerce save/checkout
transaction, and it must not block the transaction on a remote response.

The outbox record contains only the approved event envelope and delivery
metadata. It must not log or persist the HMAC secret, Authorization header,
raw credentials, or unredacted provider payload. Retry and backoff are owned by
the local worker; the event is dead-lettered after the reviewed limit.

The required flow is:

`Magento order committed -> local extension outbox entry -> checkout request
completes -> background worker/cron -> deterministic serialization -> HMAC over
exact bytes -> Shipmastr delivery -> bounded retries -> dead-letter state`.

Supported sender modes are `MAGENTO_MESSAGE_QUEUE`,
`DATABASE_OUTBOX_CRON`, and `DISABLED_MANUAL_IMPORT`. The order hook must make
zero outbound network calls to Shipmastr. A timeout, DNS failure, 5xx, or rate
limit in the worker must never fail or delay checkout.

## Header and signature contract

For the initial profile, the worker sends:

| Header | Meaning |
| --- | --- |
| `X-Magento-Topic` | `sales_order_place_after` or `sales_order_save_after` |
| `X-Magento-Event` | Stable extension event name |
| `X-Magento-Webhook-Id` | Unique delivery identifier |
| `X-Magento-Signature` | Base64 HMAC-SHA256 over the exact request bytes |

The current backend foundation validates these headers in
`src/modules/platformIntegrations/magento/magento-webhook-validation.ts:4-9`
and resolves delivery ids in `magento-order-ingestion.service.ts:49-58`.
Existing Adobe I/O Event header names may be accepted only by a separately
reviewed adapter; they are not silently interchangeable with this profile.

## Payload and acknowledgement

The first profile transports a bounded, versioned order-event envelope with
opaque identifiers, totals/currency, line-item references, and the minimum
shipping projection required for import preview. The extension must omit
credentials, customer secrets, authorization, and unnecessary PII. Shipmastr
acknowledges only after identifier, size, HMAC, topic, and atomic dedupe
reservation pass. The synchronous response does not create a canonical order,
shipment, inventory row, payment, wallet, ledger, or settlement.

The repository's current foundation creates `PlatformOrderImport` only and
marks `order_creation.status` as `deferred`
(`src/modules/platformIntegrations/magento/magento-order-ingestion.service.ts:79-128`).
Canonical import and inventory effects are future, separately approved phases.

Queued deliveries retain a key-version reference so a reviewed rotation can
verify already-queued records; no secret is copied into the outbox. Disable or
uninstall stops new sends, preserves sanitized delivery evidence, and leaves
manual import as the explicit fallback. A reconciliation job scans recent
committed orders for missing delivery records and idempotently creates the
missing outbox entries. Duplicate extension events reuse the delivery id.

Installation/registration is an explicit extension configuration action that
binds one Magento store to one Shipmastr connection-specific opaque endpoint.
It is not an application-side provider registration and must be separately
approved. The sender must support bounded retries and a dead-letter queue, but
the exact numeric retry limit is a reviewed extension policy rather than an
assumption about Adobe or Magento.

## Adobe relationship

Adobe Commerce [Webhooks](https://developer.adobe.com/commerce/extensibility/webhooks/)
are synchronous and can affect the originating Commerce operation. Adobe [I/O
Events](https://developer.adobe.com/commerce/extensibility/events/) provide a
separate asynchronous event route with journaling and delivery options described
in [consume events](https://developer.adobe.com/commerce/extensibility/events/consume-events)
(sources accessed 2026-07-16). Native Adobe Webhooks are deferred; I/O Events
are a separate integration sub-phase. Neither changes this extension profile.
