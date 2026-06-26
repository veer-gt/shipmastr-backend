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

GCS object keys are stored raw internally. Signed URL paths must encode each path segment separately and must preserve `/` separators; do not encode the full object key in a way that turns separators into `%2F`.

## Service Account Permissions

Grant the staging Cloud Run service account bucket-level access only for the staging bucket:

```text
shipmastr-runner@shipmastr-core-prod.iam.gserviceaccount.com
```

Minimum expected role:

- Storage Object User on the staging Weight Guard bucket.

For Cloud Run staging and production, set the explicit signing service account env var and grant only the narrow IAM permission required for that service account to call IAM Credentials `signBlob`. Do not grant broad owner/editor roles.

The backend signs V4 URLs by using:

- `WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT` as the signer email.
- Google-managed application default credentials or runtime metadata only to obtain an OAuth token for the IAM Credentials `signBlob` call.

No downloaded service account JSON key, private key, or credential file is required.

## Cloud Run Env

Set these on `shipmastr-api-staging` only after approval:

```text
WEIGHT_GUARD_PROOF_STORAGE_ENABLED=true
WEIGHT_GUARD_STORAGE_PROVIDER=gcs
WEIGHT_GUARD_GCS_BUCKET=<staging-private-bucket>
WEIGHT_GUARD_GCS_PROJECT_ID=shipmastr-core-prod
WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT=<staging-cloud-run-service-account-email>
WEIGHT_GUARD_UPLOAD_TTL_SECONDS=600
WEIGHT_GUARD_SIGNED_GET_TTL_SECONDS=300
WEIGHT_GUARD_MAX_IMAGE_BYTES=10485760
```

Do not set Cloudflare R2 credentials for the GCS path.

`WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT` is recommended for Cloud Run staging and production. When it is set, the backend uses that email directly for IAM Credentials `signBlob` and does not need the metadata service account email lookup. The runtime still needs Google-managed ADC/metadata access to obtain an OAuth token for the `signBlob` request.

Do not log, copy, screenshot, or store signed URLs, object keys, bucket names, OAuth tokens, private keys, or service account JSON credentials.

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
