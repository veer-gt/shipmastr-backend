# Weight Guard GCS Staging Config Checklist

This runbook prepares Google Cloud Storage as the staging object-storage provider for Weight Guard proof capture. It is an alternative to Cloudflare R2 and keeps proof images private.

## Scope

- Staging only until production approval is explicit.
- Backend remains the source of truth for proof sessions, proof metadata, seller ownership, and seller-safe responses.
- n8n remains inactive unless a separate staging HTTP test approval is given.
- Do not store public object URLs in application records.

## Private Bucket Requirements

- Create a dedicated staging GCS bucket for Weight Guard proof images.
- Enable public access prevention.
- Enable uniform bucket-level access.
- Do not grant public IAM principals.
- Do not enable object ACLs.
- Do not store proof images in a production bucket during staging tests.
- Use the existing private object key format:

```text
weight-proofs/{sellerOrMerchantId}/{yyyy}/{mm}/{awbNumber}/{captureSessionId}.jpg
```

PNG proofs use the same path shape with a `.png` suffix.

## Service Account Permissions

Grant the staging Cloud Run service account bucket-level access only for the staging bucket:

```text
shipmastr-runner@shipmastr-core-prod.iam.gserviceaccount.com
```

Minimum expected role:

- Storage Object User on the staging Weight Guard bucket.

If signed URL generation requires service account signing permissions in the active runtime, grant only the narrow IAM permission required for the staging service account and document the grant before testing.

## Cloud Run Env

Set these on `shipmastr-api-staging` only after approval:

```text
WEIGHT_GUARD_PROOF_STORAGE_ENABLED=true
WEIGHT_GUARD_STORAGE_PROVIDER=gcs
WEIGHT_GUARD_GCS_BUCKET=<staging-private-bucket>
WEIGHT_GUARD_GCS_PROJECT_ID=shipmastr-core-prod
WEIGHT_GUARD_UPLOAD_TTL_SECONDS=600
WEIGHT_GUARD_SIGNED_GET_TTL_SECONDS=300
WEIGHT_GUARD_MAX_IMAGE_BYTES=10485760
```

Do not set Cloudflare R2 credentials for the GCS path.

## Staging Smoke Sequence

1. Confirm migration `20260622133000_weight_guard_proof_capture_foundation` is applied to staging.
2. Confirm an approved staging seller token is available through secure local handling.
3. Confirm a staging shipment and AWB owned by that seller.
4. Call `POST /v1/shipping/weight-proofs/init`.
5. Upload a safe internal test image directly to the signed `PUT` target returned by the backend.
6. Call `POST /v1/shipping/weight-proofs/finalize`.
7. Call `GET /v1/shipping/weight-proofs/:awbNumber`.
8. Confirm the seller-safe response contains no object key and no signed URL.
9. Confirm logs contain no credentials, object contents, object keys, or signed URLs.

## Rollback

Set storage back to disabled on `shipmastr-api-staging`:

```text
WEIGHT_GUARD_PROOF_STORAGE_ENABLED=false
WEIGHT_GUARD_STORAGE_PROVIDER=disabled
```

Rollback should stop new proof init/finalize operations without deleting existing proof metadata.

## Safety Notes

- Do not deploy production from this checklist.
- Do not call courier APIs.
- Do not send email, SMS, WhatsApp, or webhook messages.
- Do not expose provider/courier names through seller Weight Guard responses.
- Do not publish proof images through public URLs.
- Do not paste secrets into docs, source files, n8n workflow JSON, screenshots, or logs.
