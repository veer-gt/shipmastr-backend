# Weight Guard Local Mock Smoke

## Purpose

This runbook verifies the Weight Guard proof-capture service path against local Postgres using in-memory mock storage. It does not add HTTP helper routes, does not use Cloudflare R2, and does not exercise n8n.

## Safety Gates

The smoke script refuses to run unless all gates are true:

- `NODE_ENV` is not `production`.
- `DATABASE_URL` points to local Postgres on `localhost` or `127.0.0.1`.
- `SHIPMASTR_WEIGHT_GUARD_LOCAL_SMOKE=YES_I_APPROVE_LOCAL_DB_MUTATION`.
- `WEIGHT_GUARD_PROOF_STORAGE_ENABLED=true`.
- `WEIGHT_GUARD_STORAGE_PROVIDER=mock`.
- The runtime is not Cloud Run.

The script creates or reuses only local fixture rows:

- Merchant: `wg_local_mock_merchant`
- Shipment: `wg_local_mock_shipment`
- AWB: `WGLOCALMOCK001`

No auth token is created. No seller, courier, R2, notification, webhook, or production API call is made.

## Start Local Postgres

```bash
cd /Users/mac/shipmastr-fullstack/backend
docker compose up -d postgres
```

## Check DB Readiness

```bash
cd /Users/mac/shipmastr-fullstack/backend
docker compose exec postgres pg_isready -U postgres -d shipmastr
```

The local database schema must already be migrated before the smoke can insert fixture rows.

## Required Env Vars

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/shipmastr"
NODE_ENV=development
SHIPMASTR_WEIGHT_GUARD_LOCAL_SMOKE=YES_I_APPROVE_LOCAL_DB_MUTATION
WEIGHT_GUARD_PROOF_STORAGE_ENABLED=true
WEIGHT_GUARD_STORAGE_PROVIDER=mock
WEIGHT_GUARD_UPLOAD_TTL_SECONDS=600
WEIGHT_GUARD_MAX_IMAGE_BYTES=5242880
```

## Smoke Command

Build first so the CommonJS smoke script can import the compiled service modules:

```bash
cd /Users/mac/shipmastr-fullstack/backend
npm run build
```

Then run:

```bash
cd /Users/mac/shipmastr-fullstack/backend
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/shipmastr" \
NODE_ENV=development \
SHIPMASTR_WEIGHT_GUARD_LOCAL_SMOKE=YES_I_APPROVE_LOCAL_DB_MUTATION \
WEIGHT_GUARD_PROOF_STORAGE_ENABLED=true \
WEIGHT_GUARD_STORAGE_PROVIDER=mock \
WEIGHT_GUARD_UPLOAD_TTL_SECONDS=600 \
WEIGHT_GUARD_MAX_IMAGE_BYTES=5242880 \
npm run smoke:weight-guard:local-mock
```

## Expected Output

The output is a safe JSON summary. It should show:

- `ok: true`
- `local_only: true`
- `capture_session_created: true` on the first run, or safe idempotent reuse on later runs.
- `object_key_present: true` when a new capture session is created.
- `proof_logged: true`
- `awb: WGLOCALMOCK001`
- declared, volumetric, and chargeable weight values
- `seller_safe_response_hides_storage_internals: true`
- no live external, R2, courier, or notification calls

The script intentionally does not print signed URLs, object keys, credentials, tokens, or secrets.

## Cleanup Guidance

Cleanup is optional. Only run cleanup against a verified local `DATABASE_URL`.

```sql
DELETE FROM shipping_weight_proofs
WHERE merchant_id = 'wg_local_mock_merchant'
  AND awb_number = 'WGLOCALMOCK001';

DELETE FROM shipping_weight_proof_capture_sessions
WHERE merchant_id = 'wg_local_mock_merchant'
  AND awb_number = 'WGLOCALMOCK001';

DELETE FROM shipments
WHERE id = 'wg_local_mock_shipment'
  AND seller_id = 'wg_local_mock_merchant';

DELETE FROM "Merchant"
WHERE id = 'wg_local_mock_merchant'
  AND email = 'weight-guard-local-smoke@shipmastr.test';
```

Do not run cleanup against staging or production.

## Limits

This is local-only and does not test R2 presigned upload behavior. It proves the Weight Guard service path with mock storage by calling `initWeightProofCapture`, placing an in-memory mock object, calling `finalizeWeightProofCapture`, and reading with `getWeightProofByAwb`.

n8n remains inactive. Do not run n8n HTTP nodes until staging API URL, staging auth, staging R2 config, and a test shipment/AWB are explicitly approved.
