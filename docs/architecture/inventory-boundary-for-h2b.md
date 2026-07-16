# Inventory boundary for H2B

H2B public provider ingress is an event-admission and import-preparation
boundary. It is not an inventory or order-authority boundary.

## Existing repository evidence

`prisma/schema.prisma:1853-1875` defines `PlatformConnection` and its
merchant-scoped provider metadata. `:1878-1904` defines the
`PlatformWebhookCredential` vault row with current/previous encrypted values,
key version, rotation, and revocation state. `:2170-2195` defines
`PlatformWebhookEvent`; its unique `[merchantId, dedupeKey]` constraint and
indexes are useful for event history but do not provide an atomic reservation
by themselves.

The platform webhook foundation migration
`prisma/migrations/20260608090000_phase25_platform_webhook_ingestion_foundation/migration.sql`
is additive and explicitly does not register external webhooks, create orders,
create shipments, or run workers. The H2A credential migration
`prisma/migrations/20260712180000_h2a_platform_webhook_credentials/migration.sql`
adds encrypted credential storage and a connection/purpose uniqueness rule.

The current Magento foundation (`src/modules/platformIntegrations/magento/
magento-order-ingestion.service.ts:79-128`) creates `PlatformOrderImport` only;
its `order_creation.status` is `deferred`. This is intentionally not a
canonical order or inventory write.

Existing operational projections such as `MerchantPickupPoint`,
`MerchantWarehouse`, `PickupLocation`, and storefront/product models are not
new H2B inventory authorities. `OrderDataSignals.skuId` is a nullable signal,
not an inventory foreign key. H2B must not add a relation to any of these
models in its first ingress phase.

The location roles remain unchanged: `MerchantWarehouse` is the future
physical-stock anchor, `MerchantPickupPoint` is merchant compliance and
approved pickup identity, and `PickupLocation` is a seller/courier operational
projection. External event metadata may retain platform, external product and
variant ids, external SKU, and quantity, but `StorefrontProduct` is not a
canonical physical SKU and `externalSku` is not an inventory foreign key.
H2B creates no new relationship among these models.

## Required future persistence

MIGRATION_REQUIRED: YES. A public endpoint needs an opaque identifier digest
bound to exactly one `PlatformConnection`, with revocation/rotation semantics.
The current schema has no such public identifier. Concurrent deliveries also
need an atomic reservation/status model (or an equivalent transactional
constraint and insert path); the current `findFirst` then `create` sequence is
race-prone even though the final unique constraint rejects one duplicate.

The proposed migration must add only the reviewed H2B state: a non-secret
public identifier digest and lifecycle status/rotation metadata, plus an
admission reservation or outbox record with tenant/connection/dedupe
constraints. Do not add order, inventory, shipment, payment, wallet, ledger,
settlement, or provider-account tables for H2B ingress.

## Authority and processing boundary

The synchronous H2B transaction may record a sanitized event, dedupe
reservation, and async work item. A worker may normalize the event and create a
dry-run/import-preview representation. Canonical order, shipment, stock,
payment, wallet, ledger, settlement, and inventory mutations require separate
approved contracts and activation gates; they are outside H2B-1.

Every row and job must carry the resolved merchant and connection scope from
the opaque identifier. A caller never supplies a merchant scope. Credential
selection follows the existing H2A vault context rules in
`src/modules/credentialVault/platform-webhook-credential.service.ts:289-326`.

The future admission transaction must atomically persist its reservation and
outbox item. The asynchronous worker may normalize, import-preview, retry, and
dead-letter an event; it may not create canonical inventory, reserve/deduct or
restock stock, create suppliers or purchase documents, transfer warehouse
stock, or mutate order/checkout/payment/wallet/ledger/settlement state. A
separate approved contract is required for every such effect.
