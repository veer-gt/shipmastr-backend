# COD Automation Smoke Callback Reconciliation

## Purpose

This document records the production backend reconciliation for the COD automation smoke callback route.

The live `shipmastr-api` Cloud Run service is backed by this production backend repository. A temporary production-backend-compatible patch was used for the successful smoke deploy, and this source change makes that route/env gate durable for future backend deploys.

## Smoke Result Being Reconciled

```text
Cloud Run revision: shipmastr-api-00146-xfr
Image: asia-south1-docker.pkg.dev/shipmastr-core-prod/shipmastr/shipmastr-api:cod-smoke-callback-20260529-0910
Smoke route: POST /v1/internal/automation/callback/smoke
Production route: POST /v1/internal/automation/callback
SM_11_COD_RISK_HIGH: SENT / HTTP 200
SM_12_ADDRESS_CONFIRMATION: SENT / HTTP 200
SM_14_NDR_RECOVERY: SENT / HTTP 200
```

The smoke used synthetic payloads only. No OTP code, real buyer data, real order data, or secret value was printed or committed.

## Routes

Production callback route:

```text
POST /v1/internal/automation/callback
```

Smoke-only callback route:

```text
POST /v1/internal/automation/callback/smoke
```

The production route remains strict. Unknown real event IDs must continue to fail, and smoke-only IDs must not update real automation events.

## Smoke Env Gate

The smoke callback route is disabled unless the runtime explicitly sets:

```text
SHIPMASTR_AUTOMATION_SMOKE_CALLBACKS_ENABLED=true
```

The default is disabled:

```text
SHIPMASTR_AUTOMATION_SMOKE_CALLBACKS_ENABLED=false
```

Disable or remove this env var after each approved smoke window.

## Callback Authentication Contract

Both callback routes use the same internal task-secret middleware and signed callback verification.

Required headers:

```text
Content-Type: application/json
X-Shipmastr-Task-Secret
X-Shipmastr-Timestamp
X-Shipmastr-Signature
```

Signature:

```text
HMAC_SHA256_HEX(<signing secret>, <timestamp>.<JSON callback body>)
```

Task secret chain:

```text
SHIPMASTR_INTERNAL_PROVISIONING_SECRET
SHIPMASTR_INTERNAL_SECRET
WEBHOOK_SECRET
```

Signing secret chain:

```text
N8N_AUTOPILOT_SIGNING_SECRET
SHIPMASTR_INTERNAL_SECRET
WEBHOOK_SECRET
```

Do not commit, echo, screenshot, or log any secret value.

## Smoke-Only Payload Rules

The smoke callback route accepts only synthetic callbacks:

```json
{
  "synthetic": true,
  "eventId": "SMOKE_SM_11_COD_RISK_HIGH",
  "event": {
    "id": "SMOKE_SM_11_COD_RISK_HIGH"
  },
  "status": "PROCESSED"
}
```

The smoke route rejects:

- smoke gate disabled
- missing or bad task secret
- missing or bad timestamp
- missing or bad signature
- body tampering after signing
- `synthetic` not equal to `true`
- missing event ID
- event IDs not prefixed with `SMOKE_`
- OTP code fields anywhere in the body

## n8n Callback Node Contract

For normal production operation, each COD workflow should point to:

```text
https://shipmastr-api-525178961393.asia-south1.run.app/v1/internal/automation/callback
```

For controlled synthetic smoke only, temporarily point to:

```text
https://shipmastr-api-525178961393.asia-south1.run.app/v1/internal/automation/callback/smoke
```

Required callback node settings:

```text
Method: POST
Authentication: None
Body: {{ JSON.stringify($json.callbackBody) }}
```

Required headers:

```text
Content-Type: application/json
X-Shipmastr-Task-Secret: {{ $json.callbackTaskSecret || $json.taskSecret }}
X-Shipmastr-Timestamp: {{ $json.callbackTimestamp }}
X-Shipmastr-Signature: {{ $json.callbackSignature }}
```

## Safety Notes

- This reconciliation does not deploy.
- This reconciliation does not run migrations.
- This reconciliation does not weaken callback auth.
- The smoke route is env-gated and synthetic-only.
- OTP code fields are rejected.
- Production callback behavior remains strict.
- Unknown real event IDs remain rejected.
