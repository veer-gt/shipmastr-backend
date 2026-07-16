# H2B canary and rollout plan

This plan is a release gate, not an instruction to deploy. No staging or
production state is changed by this document.

## Gate 0: source and contract readiness

- Keep `H2B_PUBLIC_PROVIDER_INGRESS_ENABLED=false` and omit the route import
  while the feature is not approved.
- Complete the public identifier and atomic reservation migration before any
  provider-facing endpoint exists. The current `PlatformWebhookEvent` unique
  constraint is not enough because the service performs `findFirst` then
  `create` (`src/modules/platformIntegrations/webhookIngestion/
  platform-webhook.service.ts:433-497`).
- Define the reviewed provider byte limits, exact Shopify retry behavior, HMAC
  canonicalization, and redaction tests.
- Add tests for unknown identifier, cross-tenant identifier, disabled/revoked
  credential, replay, concurrent delivery, chunked body overflow, oversized
  `Content-Length`, malformed topic, and secret/PII leakage.

## Gate 1: isolated canary

Deploy only `shipmastr-api-h2b-canary` with a pinned digest. It must use a
dedicated service account, restrictive ingress, and explicit invoker; it must
not have unauthenticated invocation or a custom-domain route. The Cloud Run
security controls are documented in the [official Cloud Run security
guide](https://docs.cloud.google.com/run/docs/securing/security?hl=en)
(accessed 2026-07-16).

Use a staging-only database and reviewed staging-only HMAC keys. Use synthetic
connections and provider-like signed payloads generated locally. No real
provider account, webhook subscription, email, order, payment, inventory, or
settlement path is allowed.

The canary must prove:

1. flag-off route absence;
2. exact provider route matching;
3. byte cap before buffering, including chunked/misleading-length cases;
4. HMAC verification against current and grace-period previous keys;
5. identifier ownership and disabled/revoked behavior;
6. atomic dedupe reservation under concurrency;
7. safe acknowledgement and asynchronous enqueue;
8. no raw body, signature, authorization, credential, PII, or provider payload
   leakage in response, logs, metrics, traces, or error paths;
9. no synchronous order, inventory, shipment, payment, wallet, ledger,
   settlement, or provider write.

Canary traffic is zero until the owner reviews the evidence. If a canary must
be exercised, invoke only through the explicit private/test identity path; do
not register a provider callback or publish the custom domain.

After proof, delete or disable the canary route/service and revoke synthetic
fixtures unless a separately approved staging observation requires retention.
The public H2B service is never made public merely because a revision has zero
traffic or an unadvertised URL.

## Gate 2: guarded promotion

Promotion requires the exact digest to be rechecked, a rollback revision to be
pre-verified, and all smoke checks to pass. The guarded promotion changes one
control-plane value at a time, records evidence, and opens a bounded
observation window. Any failed readiness, leakage, ownership, dedupe, or
latency gate restores the previous revision and leaves the public provider
endpoint disabled.

The first public provider registration is a separately approved action after
the observation window. Registration must be per connection, HTTPS only, and
use the opaque identifier. It is not part of application deployment.

## Dormant staging and production packages

The dormant staging revision uses the exact reviewed digest,
`H2B_PUBLIC_PROVIDER_INGRESS_ENABLED=false`, no H2B route mount, zero traffic,
and no traffic tag. Control-plane verification does not make it private; the
service remains protected by service-level ingress and IAM. Activation requires
the canary evidence, exact digest, rollback digest, one guarded promotion,
immediate provider security smoke, and automatic restoration on failure.

Production is a separate package: prepare a no-traffic revision with the flag
false, verify the exact digest and rollback revision, obtain explicit approval,
promote once, run security smoke and an observation window, and roll back on
any failed condition. Production remains unchanged by this plan.

## Required test matrix

The implementation gate must include, at minimum:

- flag disabled: 404 and structurally absent route with no parser, body,
  lookup, decrypt, database, queue, telemetry, or inventory activity;
- request size: oversized, absent, misleading, chunked, exact-boundary, and
  one-byte-over-cap bodies, with no fragments logged;
- authentication/isolation: valid/invalid/current/previous/expired/revoked
  secrets, wrong tenant, platform mismatch, unknown/disabled/stale identifier;
- topics: each approved order topic plus inventory/product/customer/fulfilment
  and malformed topics, all unsupported events producing no import or queue;
- dedupe: duplicate and concurrent delivery, crash before/after reservation,
  crash after enqueue, retry, and retention expiry;
- data safety: no secret, authorization, buyer PII, raw body, inventory FK,
  warehouse mutation, or provider payload leakage;
- Magento: zero checkout-time network calls, DNS/timeout/5xx/rate-limit
  isolation, worker retry/DLQ, duplicate delivery-id reuse, reconciliation,
  rotation of queued deliveries, disable/uninstall, and no inventory topics.

The evidence must record only sanitized test names, statuses, stable error
classes, digest/revision identifiers, route/flag assertions, and bounded
timings. It must not contain credentials, raw bodies, tokens, or buyer data.

## Rollback

Rollback uses the previously verified digest/revision and is triggered by any
5xx/error spike, signature anomaly, cross-tenant response, duplicate mutation,
leakage finding, queue/DLQ growth, body-limit bypass, or provider retry storm.
After rollback, disable the H2B flag/route, preserve sanitized evidence, and
re-run health and auth smoke checks. No rollback should create a database
mutation outside the already-reviewed admission records.

## Async processing design

Synchronous work: bounded read, identifier lookup, connection/credential
status, HMAC verification, topic allowlist, atomic dedupe reservation, safe
event/outbox enqueue, and acknowledgement.

Asynchronous work: normalization, preview/import preparation, provider retry
coordination, status transitions, and dead-letter processing. It must remain
tenant-scoped and must not synchronously create orders or update inventory,
payments, wallets, ledgers, shipments, or settlements.
