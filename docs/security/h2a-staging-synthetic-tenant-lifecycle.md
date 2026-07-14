# H2A staging-only synthetic tenant lifecycle

This document describes the disabled-by-default lifecycle used only for a
separately approved staging H2A cross-tenant verification. It is not a tenant
provisioning, onboarding, email, payment, order, shipment, wallet, ledger,
settlement, or provider-registration feature.

## Current contracts audited

- `prisma/schema.prisma:956-1040,4915-4931` keeps `Merchant.email` and
  `User.email` unique;
  `User.passwordHash` is the only password persistence field and the existing
  role/user-type contract uses `MERCHANT_OWNER` with `MERCHANT_ACCOUNT`.
- `src/modules/auth/auth.routes.ts:551-673,675-744` uses the centralized bcrypt policy from
  `src/modules/auth/password-hashing.ts`, signs the existing seven-day seller
  JWT, and resolves `/auth/me` from the database on every request.
- `src/middleware/jwtAuth.ts:28-57,59-117` verifies the existing JWT and resolves the user
  for admin checks. The only shared-auth change in this feature is the
  database-backed fixture-owner status check; it returns immediately for every
  user with no linked fixture.
- `src/modules/platformIntegrations/platform-integrations.service.ts:78-183` owns
  Merchant-scoped PlatformConnection creation/listing and disabled state.
`src/modules/credentialVault/platform-webhook-credential.service.ts:256-294` owns
  configure, resolve, rotate, and revoke semantics for
  `PLATFORM_WEBHOOK_SIGNATURE`; cleanup calls its existing revoke operation.
- `src/modules/auth/password-reset.service.ts`, invitation helpers, lead
  conversion, Firebase onboarding, mailers, notification workers, and n8n
  clients are deliberately not imported by the fixture module.
- `AuditLog` is append-only application evidence. Fixture audit metadata is
  limited to fixture kind and stable lifecycle status; no request body,
  password, token, email, or credential material is written.

## Threat model and gates

The feature is mounted only when `APP_ENV=staging` and
`H2A_SYNTHETIC_TENANT_LIFECYCLE_ENABLED=true`. The flag defaults to `false` in
`src/config/env.ts:17-25,200-205` and `.env.example:1-5`. Startup rejects a true flag outside
staging with `H2A_SYNTHETIC_TENANT_LIFECYCLE_FORBIDDEN`; production therefore
cannot register the routes. With the flag false, the router is not mounted and
normal route-not-found behavior is retained. The flag is server-only and is not
read by any frontend package.

Every lifecycle request additionally requires the normal JWT, exact canonical
`MASTER_ADMIN`/internal Shipmastr authorization, and the exact
`X-Shipmastr-Security-Fixture: h2a-staging-tenant-v1` header. No header-only or
request-body bypass exists.

## Route contract

The isolated router (`src/routes/index.ts:87-96` and
`src/modules/securityFixtures/h2a-staging-tenant.routes.ts:7-30`) exposes only:

- `POST /api/admin/security-fixtures/h2a-tenants`
- `GET /api/admin/security-fixtures/h2a-tenants/:fixtureId`
- `POST /api/admin/security-fixtures/h2a-tenants/:fixtureId/cleanup`

Creation validation (`src/modules/securityFixtures/h2a-staging-tenant.validation.ts:1-33`)
requires the exact synthetic fixture type, markers, `.invalid` email,
`.example` HTTPS URL, 24–128 character password, and 15–120 minute expiry.
Zod strict parsing rejects unknown fields and does not coerce malformed values.
The response contains only an opaque fixture ID, lifecycle status, expiry, and
`ownerReady`; it never returns Merchant/user IDs, email, password, hash, JWT,
or credential metadata. Status responses contain only the documented safe state
and aggregate counts.

## Persistence and concurrency

`SecurityFixtureTenant` (`prisma/schema.prisma:4936-4956`) is additive and has no plaintext credential fields. It
stores kind/status, a nullable unique `H2A_STAGING_TENANT_B` slot, optional
Merchant/owner references, creator internal-user reference, expiry, cleanup
time, stable error code, and timestamps. Foreign keys use `SET NULL` for the
synthetic Merchant/owner and `RESTRICT` for the creator; no cascade reaches
AuditLog, webhook evidence, journal, telemetry, orders, shipments, payments,
wallets, ledger, reconciliation, or settlements.

Creation (`src/modules/securityFixtures/h2a-staging-tenant.service.ts:109-164`)
claims the nullable unique slot inside a serializable Prisma
transaction, then creates exactly one synthetic Merchant and one owner. A
unique conflict maps to `H2A_SYNTHETIC_TENANT_ALREADY_ACTIVE`; losing
concurrent attempts cannot leave partial rows because the transaction rolls
back.

## Authentication and expiry

The normal Merchant login and `/auth/me` paths remain the contract. The
fixture check is at `src/modules/securityFixtures/h2a-staging-tenant.service.ts:95-107`
and its login integration is at `src/modules/auth/auth.routes.ts:623-626,714-715`.
A fixture
owner is accepted only while its fixture is `ACTIVE` and `expiresAt` is in the
future. `requireJwtAuth` performs the same lookup before accepting a request, so
an already-issued token fails immediately after expiry or when cleanup enters
`CLEANING`. Non-fixture users take the existing path without a fixture record.

## Cleanup state machine

Cleanup (`src/modules/securityFixtures/h2a-staging-tenant.service.ts:197-270`)
atomically claims `ACTIVE`, `EXPIRED`, or recoverable `FAILED` into
`CLEANING`. That state immediately disables fixture authentication. It then
finds only connections owned by the fixture Merchant whose exact store marker is
`H2A STAGING SYNTHETIC CROSS-TENANT — DO NOT USE`, revokes their webhook
credentials through the existing vault service, verifies the rows are revoked
and ciphertext fields are empty, and disables only those connections. Any
non-synthetic connection or unexpected order, shipment request, checkout, or
webhook-event state leaves the owner disabled, records a stable safe error, and
  keeps the fixture unavailable for slot reuse. Webhook security evidence is
  retained and is not treated as a deletion target. No unexpected row is deleted.

After safe cleanup, the Merchant is marked `BLOCKED`, the fixture is `CLEANED`,
the slot is cleared, and one PII-free AuditLog record is written. Repeated
cleanup of `CLEANED` returns the same safe state without another destructive
mutation. Cleanup failures use `H2A_SECOND_TENANT_CLEANUP_FAILED` (or the
stable unexpected-state code) and remain retryable.

## No-email and no-automation proof

The lifecycle module imports only the environment, Prisma, centralized password
hashing, existing webhook-credential revocation, and local validation/error
helpers. It does not import or call invitation, password-reset, lead,
mailer/notification, Firebase, n8n, or provider-client modules. Creation,
login, status, and cleanup contain no outbound automation call. Static tests
assert this import boundary and that safe responses omit credential fields.

## Migration and rollback compatibility

`20260714100000_h2a_synthetic_tenant_lifecycle/migration.sql` adds two enums,
one table, indexes, and optional foreign keys only. It has no drops, backfills,
rewrites, or changes to H2A credential columns. The prior revision can continue
to run because it does not reference the new table; the flag remains false until
the lifecycle-capable revision and migration are deliberately selected in
staging.

## Future staging runner

`/Users/mac/Downloads/h2a-second-tenant-runner.py` is compiled but not executed.
It uses only Python standard-library HTTP and `getpass`, pins a caller-supplied
HTTPS candidate origin, rejects redirects and origin changes, requires explicit
candidate revision/digest and 0%/100% traffic guard inputs, and requires H2B
public ingress to be disabled. Passwords, JWTs, IDs, secrets, and response
bodies remain in memory; the 0600 evidence file contains only statuses/counts.
The runner has no cloud, database, migration, deployment, traffic, email,
provider, or business-record code. Its green result is
`H2A_CROSS_TENANT_STAGING_GREEN_AWAITING_TRAFFIC_APPROVAL`; traffic approval is
outside this task. It scans raw candidate responses for registered passwords and
tokens before decoding them; no response body or candidate diagnostic is
written to evidence.

## Staging prerequisites and retirement

Before any future staging use, separately approve the migration and a tagged
candidate, confirm the candidate digest and traffic guards, confirm production
guards and H2B ingress state, and provide a dedicated staging Master Admin and
Tenant A login. No live tenant was created by this local implementation task.

After H2A cross-tenant verification is complete, clean the fixture, remove the
feature flag, remove the router and migration in a separately reviewed
deprecation change, and retain only the required PII-free security evidence.
