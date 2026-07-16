# H2B public provider ingress architecture

Status: source-backed design only. This document does not enable a route, add
an ingress binding, change traffic, or create a migration.

## Scope and non-goals

H2B is a future, provider-facing webhook boundary for Shopify and WooCommerce,
with a separately specified Shipmastr Magento extension profile. It must be
tenant-scoped, authenticated by a per-connection HMAC secret, bounded before a
request body is buffered, and asynchronous after a small synchronous admission
transaction. It must not create orders, shipments, inventory writes, payments,
wallet entries, ledger entries, settlements, or provider-side registrations in
the first release.

The current repository has no public H2B route. A future feature flag,
`H2B_PUBLIC_PROVIDER_INGRESS_ENABLED`, must be false by default. When false,
the router import and mount must be absent, rather than merely returning an
application-level denial after a public route has already been exposed.

## Current source boundary

`src/server.ts:24-67` creates the Express app, enables the configured trusted
proxy hop count, Helmet, compression, CORS, a global rate limiter, request
logging, target validation, and `express.json({ limit: "256kb" })`. The JSON
parser buffers and parses a body before route dispatch and stores `rawBody` in
its verify callback. That is suitable for existing authenticated APIs, but is
not a sufficient H2B admission boundary: provider-specific size enforcement
must happen before full buffering.

`src/routes/index.ts:139-140` mounts the seller API separately and mounts all
existing platform integration routes below `/shipping` behind `requireJwtAuth`.
`src/modules/platformIntegrations/platform-integrations.routes.ts:87-104`
mounts the current authenticated Shopify, WooCommerce, Magento, credential,
and ingestion routers. `src/modules/platformIntegrations/webhookIngestion/
platform-webhook-ingestion.routes.ts:28-65` therefore is not public ingress:
each provider route depends on `req.auth!.merchantId` and the enclosing JWT
router.

`src/middleware/jwtAuth.ts:28-57` derives the merchant scope from a verified
JWT; a future public identifier must never accept a caller-supplied
`merchantId`. `src/modules/platformIntegrations/webhookIngestion/
platform-webhook.service.ts:71-82` currently finds a connection with both
`id` and `merchantId`; H2B must preserve that ownership invariant after
resolving its opaque public identifier.

The current topology is:

| Mount | Current routes | Protection / scope |
| --- | --- | --- |
| `/api/shipping` | platform connections, credential management, Shopify/WooCommerce/Magento ingestion, event list/detail, and dry-run import staging | `requireJwtAuth` at `src/routes/index.ts:140`; merchant comes from the verified JWT |
| `/api/shipping/seller-api` | seller API | its own seller API-key middleware at `src/routes/index.ts:139` |
| `/api/admin` | connection administration and security-fixture routes | admin/master-admin middleware at `src/routes/index.ts:75-96` |
| `/api/webhooks` | existing generic webhook router | separate router at `src/routes/index.ts:152`; not H2B public ingress |

`src/modules/platformIntegrations/platform-integrations.routes.ts:94-135`
contains the authenticated platform-connection create/list/detail/disable and
health paths. `platform-webhook-ingestion.routes.ts:67-82` contains the
authenticated event list/detail and stage-import paths. None of these routes
is a public provider callback.

H2A credential ownership is explicit: `PlatformConnection` is keyed by its
merchant owner (`prisma/schema.prisma:1853-1875`), while
`PlatformWebhookCredential` is unique by connection and purpose
(`:1878-1904`). Encryption AAD binds merchant, connection, platform, and
`PLATFORM_WEBHOOK_SIGNATURE` in
`src/modules/credentialVault/platform-webhook-credential.crypto.ts:54-61`.
`platform-webhook-credential.service.ts:289-326` resolves only the owned,
enabled connection and decrypts current plus an unexpired previous secret;
revoked, disabled, mismatched, missing, or expired candidates are rejected.
There is no global fallback. Safe status responses expose booleans/status and
dates only (`:100-117`); a tenant mismatch is not disclosed.

The current global request logger (`src/server.ts:50`) and error handler
(`src/server.ts:77`, implementation in `src/middleware/errorHandler.ts`) are
not a safe place for raw provider bodies or signature material. The future
route must install redaction and safe error mapping before any H2B request is
logged.

## Exact pre-parser middleware order

The reserved prefix is `/api/public/provider-webhooks` and must be handled
before the global JSON parser. Security middleware that does not read bodies
may run first only when it cannot log raw H2B headers, signatures, or bodies.

When `H2B_PUBLIC_PROVIDER_INGRESS_ENABLED=false`, install only a constant-time
prefix 404 guard. This guard is not the provider router: it does not read or
buffer a body, parse JSON, execute `express.json` or its raw-body verify
callback, import/construct/mount the provider router, resolve an identifier,
look up a connection, resolve/decrypt a credential, verify a signature or
topic, access the database, write telemetry, reserve dedupe state, enqueue
work, or invoke inventory logic. Route absence is structural and zero H2B
business dependencies are mounted while disabled.

When the flag is true, mount the bounded raw-byte H2B router at this same
pre-parser position. It rejects oversized declared `Content-Length` before
buffering, independently enforces a streaming byte ceiling for absent,
false, malformed, or chunked lengths, aborts immediately after crossing the
ceiling, verifies HMAC over exact bounded bytes, discards those bytes after
admission, and never forwards the request into the global JSON parser. Mount
the existing `express.json({ limit: "256kb" })` only after reserved-prefix
handling for all remaining API routes. Disabling H2B therefore cannot rely on
a handler check that runs after body parsing.

Required future tests use spies or direct assertions to prove the disabled
guard invokes none of: request-body data consumption, global parser or verify
callback, provider-router factory, identifier/connection/credential service,
database client, queue publisher, telemetry writer, or inventory service.

## Proposed request flow

1. Route selection is gated by the flag and a dedicated provider ingress
   router. The router accepts only the exact provider path shape and never
   forwards a request to a different origin.
2. A route-specific byte gate rejects an explicit `Content-Length` above the
   reviewed provider limit before buffering. For missing, malformed, or
   chunked lengths, a streaming reader enforces the same cap and aborts as the
   cap is crossed. The response is 413; no body fragment is parsed, persisted,
   queued, or logged.
3. The adapter resolves the opaque public identifier to exactly one active
   `PlatformConnection`, checks the provider, status, and tenant binding, and
   selects the H2A `PLATFORM_WEBHOOK_SIGNATURE` credential through the existing
   tenant-scoped vault rules. No global credential fallback is permitted.
4. Provider headers are normalized and the provider-specific HMAC is checked
   over the exact bounded raw bytes. Signature failures, unknown identifiers,
   disabled connections, unsupported topics, and malformed envelopes return
   stable safe statuses without revealing whether another tenant has a
   connection.
5. The synchronous transaction reserves a dedupe key and records a safe event
   or outbox item. It returns a provider-appropriate success acknowledgement
   only after the reservation is durable. It does not perform canonical order,
   shipment, inventory, payment, wallet, ledger, settlement, or provider API
   work.
6. An asynchronous worker performs normalization, preview/import preparation,
   retry policy, and dead-letter handling. The worker remains tenant-scoped and
   emits only sanitized operational metadata.

The current service performs a `findFirst` followed by `create` for
`PlatformWebhookEvent` (`src/modules/platformIntegrations/webhookIngestion/
platform-webhook.service.ts:433-497`). The schema has a unique
`[merchantId, dedupeKey]` constraint, but the check/create sequence is not an
atomic reservation. This is a required design gap before public ingress is
implemented.

The current event row stores a safe summary, warnings, errors, event hash,
external delivery id, and import-job references (`prisma/schema.prisma:2170-2195`).
The current serializer removes unsafe keys/strings and marks raw payload and
headers as absent (`src/modules/platformIntegrations/webhookIngestion/
platform-webhook.serializer.ts:5-22,24-73`). Rejected or unknown events are
recorded only as sanitized status metadata by the current foundation; H2B must
not persist raw bodies, authorization, signatures, credentials, buyer PII, or
provider payloads. Stage-import creates a DRY_RUN import job only after a
verified event (`platform-webhook.service.ts:499-606`).

The recommended public URL shape is
`/api/public/provider-webhooks/{opaqueConnectionEndpoint}`. The final path
segment is a high-entropy, non-enumerable routing hint whose digest is bound to
exactly one `PlatformConnection`; provider is inferred from that connection,
not trusted from a caller field. The HMAC credential authenticates the request.
An unknown, stale, disabled, revoked, or platform-mismatched identifier has a
stable safe response and performs no cross-tenant lookup.

The admission state machine is `PENDING -> ACCEPTED -> PROCESSED` with
`FAILED` and `DUPLICATE` terminal outcomes. The reservation key is scoped by
merchant, connection, provider topic, and delivery id (event hash only as a
documented fallback). A transaction must reserve the key and enqueue an
outbox item atomically. Crash before reservation is retryable; crash after
reservation leaves a pending item for a worker; duplicate delivery returns a
safe duplicate acknowledgement without a second business action. Retention
is a provider-reviewed policy decision and must cover the provider replay
window; it is not an unsigned timestamp guarantee.

## Provider profiles and first topics

The initial allowlists are deliberately narrow:

| Provider | Initial topics | Signature / delivery evidence |
| --- | --- | --- |
| Shopify | `orders/create`, `orders/updated` | `X-Shopify-Topic`, `X-Shopify-Hmac-Sha256`, `X-Shopify-Shop-Domain`, `X-Shopify-Webhook-Id` |
| WooCommerce | `order.created`, `order.updated` | `X-WC-Webhook-Topic` or resource/event, `X-WC-Webhook-Signature`, delivery id |
| Magento extension profile | `shipmastr.order.committed.v1` | `X-Magento-Topic`, `X-Magento-Event`, `X-Magento-Webhook-Id`, `X-Magento-Signature` |

Shopify's delivery contract documents the topic, base64 HMAC, shop domain,
API version, delivery id, and event id. See the [Shopify delivery
structure](https://shopify.dev/docs/apps/build/webhooks/delivery-structure)
and [subscription guidance](https://shopify.dev/docs/apps/build/webhooks/subscribe)
(accessed 2026-07-16). WooCommerce documents HMAC delivery headers, core order
topics, background delivery, logging, and automatic disable after consecutive
non-2xx responses in the [WooCommerce webhook
API](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks)
(accessed 2026-07-16). Exact Shopify retry/backoff numbers are not fixed here;
they require provider-contract verification before implementation.

WooCommerce installations may emit `order.created` and `order.updated` close
together for one newly created order. This is compatibility behavior to
tolerate, not a universal provider guarantee. Delivery idempotency is scoped
to `provider + connectionId + deliveryId`; external-order import idempotency is
scoped to `merchantId + connectionId + externalOrderId`. The first event
creates or initializes one import aggregate; later updates upsert that same
aggregate. An update arriving first creates a provisional aggregate, and a
later create converges on it without duplication. Deterministic version/event
ordering prevents stale accepted state from overwriting newer state. Both
deliveries remain separately auditable and neither mutates inventory. The
required tests cover created→updated, updated→created, concurrency, replay,
distinct delivery IDs for one order, same external ID across connections and
merchants, one aggregate/no duplicate canonical order, retained sanitized
delivery references, and no inventory effect.

The existing Magento foundation currently recognizes
`sales_order_place_after` and `sales_order_save_after` as legacy/internal
foundation values only (`src/modules/platformIntegrations/magento/
magento-webhook-validation.ts:4-9`). They are not approved public H2B topics.
The first public Shipmastr semantic event is `shipmastr.order.committed.v1`,
emitted after a durable local order commit and transported asynchronously from
the extension outbox. It is stable across internal Magento hook changes and
unrelated to Adobe universal webhook contracts. The existing code creates only
a `PlatformOrderImport` with `order_creation.status: "deferred"`
(`magento-order-ingestion.service.ts:79-128`). Adobe Commerce's synchronous
Webhooks and asynchronous I/O Events are separate products; see [Adobe Commerce
Webhooks](https://developer.adobe.com/commerce/extensibility/webhooks/), [I/O
Events](https://developer.adobe.com/commerce/extensibility/events/), and
[consume events](https://developer.adobe.com/commerce/extensibility/events/consume-events)
(accessed 2026-07-16). Native Adobe webhooks are deferred; I/O Events are a
separate future sub-phase.

## Security and observability invariants

- Use an opaque, per-connection public endpoint identifier. Store only a
  one-way digest bound to exactly one connection, and support revocation and
  rotation. It is a routing hint, not authorization; HMAC remains mandatory.
- Apply limits by provider, identifier, source network, signature failure, and
  unknown identifier in addition to the current global limiter
  (`src/server.ts:43-48`).
- Never place raw bodies, authorization, signatures, credentials, payloads,
  cookie values, or provider responses in logs or API responses. The existing
  serializer's unsafe-key/string filters are in
  `src/modules/platformIntegrations/webhookIngestion/platform-webhook.serializer.ts:5-22`.
- Preserve the current safe summaries and mutation flags
  (`platform-webhook.service.ts:389-416`) and tenant-scoped dedupe key
  (`:418-430`).
- Add provider-specific metrics with redacted identifiers, admission status,
  latency, queue outcome, and retry/DLQ counts only.

The current limiter is global (240 requests per 60 seconds). H2B needs
additional provider-, endpoint-identifier-, source-network-, size-,
signature-failure-, and unknown-identifier controls. Responses must be stable
enough to avoid provider retry storms without acknowledging unverified business
processing as successful.

## Required approval evidence

Before a canary is approved, evidence must show flag-off route absence, exact
route matching, pre-buffer size rejection (including chunked and misleading
lengths), current/previous HMAC behavior, ownership/disable/revoke isolation,
atomic concurrent dedupe, safe acknowledgement/enqueue, complete log/response
redaction, and no synchronous business or provider mutation. Before staging
activation, repeat those checks on the exact pinned digest with synthetic
fixtures, a verified rollback digest, health/auth smoke, and a bounded
observation window. Before production promotion, add a reviewed production
flag/digest/rollback record, provider-contract sign-off, no-secrets leakage
scan, and an explicit owner approval; no public registration is implicit.

## Cloud Run deployment boundary

H2B must be deployed as a separate `shipmastr-api-h2b-canary` candidate with a
pinned image digest, no unauthenticated invocation, restrictive ingress, and an
explicit invoker. It must not use the public custom domain or register a
provider endpoint until a reviewed production cutover. Cloud Run ingress and
IAM controls are described in the [official Cloud Run security
documentation](https://docs.cloud.google.com/run/docs/securing/security?hl=en)
(accessed 2026-07-16). Staging canary data must be synthetic and use reviewed
staging-only secrets and databases.

Rollback is a guarded promotion to a pre-verified digest/revision. Capture
pre-change evidence, run smoke checks and an observation window, and restore
the previous revision automatically only within the approved release control
plane when a check fails. This document authorizes no deployment, traffic
shift, migration, or ingress change.
