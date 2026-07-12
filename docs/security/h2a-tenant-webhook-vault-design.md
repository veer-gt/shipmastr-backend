# H2A Tenant-Scoped Platform Webhook Secret Vault Design

## Scope and decision

H1 leaves the platform webhook routes authenticated and merchant-scoped, but
their verifier still accepts an optional caller-supplied secret and the
existing generic platform credential vault does not bind ciphertext to a
merchant, connection, platform, or purpose. H2A adds one purpose-specific
credential-vault path for `PLATFORM_WEBHOOK_SIGNATURE`. It extends the existing
credential-vault module rather than introducing a second generic provider
registry.

No production or staging secret is created by this change. The staging key
binding remains a separate approval gate.

## Current architecture audit

- `PlatformConnection` is owned by `merchantId` and carries a `StorePlatform`,
  connection status, and legacy `credentialsRef`/`credentialsMeta` fields.
- The existing `PlatformCredential`/`PlatformCredentialSecret` tables store
  generic API credentials. Their local AES-GCM envelope is not AAD-bound to a
  connection and historically derives key material from the application
  pepper, so it is not sufficient for H2A webhook-signing isolation.
- Existing credential routes are merchant-authenticated under the shipping
  router. Existing serializers redact secret-shaped fields, but generic
  credential metadata can still include fingerprints/prefixes.
- Shopify, WooCommerce, and Magento foundation validators already perform
  HMAC-SHA256 over raw request bytes with constant-time comparison. Runtime
  ingestion currently accepts an optional `signatureSecret` and otherwise
  reports `NOT_CONFIGURED`; there is no tenant-scoped resolver.
- `PlatformWebhookEvent` currently stores a safe summary that includes a
  staged order preview. H2A changes rejected or unconfigured deliveries to a
  PII-free security summary; valid deliveries retain the existing staged
  import behavior.
- Cloud Run deploy scripts bind existing application secrets only. H2A adds no
  staging or production Secret Manager resource in this phase.

## Provider secret semantics

- Shopify webhook verification uses the app/webhook signing secret and the
  raw body for `X-Shopify-Hmac-SHA256`.
- WooCommerce verification uses the webhook signing secret for
  `X-WC-Webhook-Signature`; REST consumer keys are API credentials, not the
  H2A signing secret.
- Magento/Adobe Commerce verification uses the configured integration/webhook
  signing secret for `X-Magento-Signature`.

Each value is stored against exactly one merchant, one `PlatformConnection`,
one platform, and the `PLATFORM_WEBHOOK_SIGNATURE` purpose. No provider-wide or
global fallback is permitted.

## Encrypted envelope

The new envelope is versioned `h2a-aes-256-gcm-v1` and stores ciphertext,
nonce, and authentication tag separately. It uses AES-256-GCM with a random
96-bit nonce. The key is exactly 32 random bytes supplied by
`PLATFORM_CREDENTIAL_ENCRYPTION_KEY` (hex or base64 representation); local
tests inject a random in-memory key. Missing or malformed key material fails
closed and is never generated silently.

AAD is a canonical representation of:

```text
schemaVersion, merchantId, connectionId, platform, purpose
```

Changing any identity field therefore makes decryption fail. The key version is
stored as metadata only and is never returned with secret material.

## Rotation and revocation

Configuration replaces the current value and clears previous material.
Rotation is transactional: the current encrypted envelope becomes previous,
the replacement becomes current, and `previousValidUntil` is bounded by the
server maximum (seven days). Resolution returns the current secret internally
and the previous secret only while its grace window is valid. Revocation clears
all encrypted current/previous material and marks the credential revoked.

The status API exposes only configured/platform/purpose/timestamps/key version
and revoked state. It never exposes ciphertext, nonce, tag, lengths,
fingerprints, prefixes, or hashes.

## Threat model and failure behavior

The design protects against cross-merchant and cross-connection lookups,
database disclosure without the encryption key, AAD identity swapping, stale
rotation use, and accidental serializer/log leakage. Decryption or tag
failure returns a stable safe error and never falls back to `WEBHOOK_SECRET`,
`JWT_SECRET`, `APP_SECRET_PEPPER`, `ADDRESS_PHONE_PEPPER`, or any provider
global.

Invalid and unconfigured webhooks persist only timestamp/scope/topic/status,
dedupe/security hash, and stable safe error metadata. Raw bodies, raw headers,
customer/order fields, staged payloads, and secret values are not persisted.

## Migration and rollback compatibility

The migration is additive and creates an empty `platform_webhook_credentials`
table with a restrictive connection foreign key, merchant/connection indexes,
and one active-purpose uniqueness constraint. H1 application revisions continue
to run because the new table is unused until the H2A image is deployed. A
future application rollback does not require database rollback; the empty or
populated table remains inert to H1.

## H2B boundary

H2A keeps the current authenticated merchant route boundary. It does not make
Shopify, WooCommerce, or Magento ingress public, register live provider
webhooks, or create real credentials. Public provider ingress, replay/rate
limiting, and provider registration belong to H2B after staging fixture proof.
