# Weight Guard R2 Staging Config Checklist

This runbook covers the private Cloudflare R2 storage configuration for Weight Guard proof capture. Storage remains disabled by default and production enablement is blocked until explicit approval.

## Required Environment

- `WEIGHT_GUARD_PROOF_STORAGE_ENABLED=false` by default.
- `WEIGHT_GUARD_STORAGE_PROVIDER=disabled|mock|r2`.
- `WEIGHT_GUARD_UPLOAD_TTL_SECONDS=600`.
- `WEIGHT_GUARD_SIGNED_GET_TTL_SECONDS=300`.
- `WEIGHT_GUARD_MAX_IMAGE_BYTES=10485760`.
- `WEIGHT_GUARD_R2_ACCOUNT_ID`.
- `WEIGHT_GUARD_R2_ACCESS_KEY_ID`.
- `WEIGHT_GUARD_R2_SECRET_ACCESS_KEY`.
- `WEIGHT_GUARD_R2_BUCKET`.
- `WEIGHT_GUARD_R2_REGION=auto`.
- `WEIGHT_GUARD_R2_ENDPOINT` is optional when account id is present.

## R2 Bucket Rules

- Bucket must remain private.
- Do not enable a public r2.dev URL.
- Do not configure object ACLs.
- Do not use `public-read`.
- Do not log bucket names, credentials, presigned URLs, or object contents.
- Do not store public object URLs in seller-facing records.

## Upload Flow

1. Seller calls `POST /shipping/weight-proofs/init`.
2. API returns a short-lived presigned `PUT` URL and required `Content-Type` header.
3. Client uploads the proof image directly to the presigned `PUT` URL.
4. Seller calls `POST /shipping/weight-proofs/finalize`.
5. API verifies the object with HeadObject before creating the proof record.

## Test Mode

- `disabled` returns the safe `WEIGHT_GUARD_STORAGE_DISABLED` error.
- `mock` is for local or test-only proof flows.
- Tests must inject mocked S3 clients and presigners.
- Tests must not make real R2 calls.

## Staging Enablement

1. Configure a private staging R2 bucket.
2. Configure the staging-only R2 access key with the minimum bucket permissions required for PUT, GET, and HEAD.
3. Set `WEIGHT_GUARD_STORAGE_PROVIDER=r2`.
4. Set `WEIGHT_GUARD_PROOF_STORAGE_ENABLED=true`.
5. Verify `POST /shipping/weight-proofs/init` returns a presigned upload URL.
6. Upload only a safe internal test image.
7. Finalize and confirm proof metadata is seller-safe.
8. Confirm no signed GET URL appears in seller responses.
9. Confirm logs do not include signed URLs or credentials.

## Production Gate

Production enablement is blocked until explicit approval. Do not enable R2 storage in production until staging smoke, auth checks, storage permissions, retention, and rollback are approved.

## Rollback

- Set `WEIGHT_GUARD_PROOF_STORAGE_ENABLED=false`, or
- Set `WEIGHT_GUARD_STORAGE_PROVIDER=disabled`.

After rollback, proof init/finalize routes should fail safely without deleting existing proof metadata.
