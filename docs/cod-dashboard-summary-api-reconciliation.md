# COD Dashboard Summary API Reconciliation

## Why This Gate Exists

The dashboard Cloud Run service successfully deployed and served `/admin/cod-automation`, but the page showed `Local demo fallback` because the production API returned `404` for:

```text
GET /cod/dashboard/summary
```

The Hostinger monorepo API already exposes a safe COD dashboard summary endpoint. The live `shipmastr-api` service is backed by this production backend repo, so the endpoint needed to be reconciled here as well.

## Endpoint Added

The production backend now exposes a read-only dashboard summary route:

```text
GET /cod/dashboard/summary
```

The same router is also available through the existing API prefixes:

```text
GET /v1/cod/dashboard/summary
GET /api/cod/dashboard/summary
```

The deployed dashboard currently requests:

```text
https://shipmastr-api-525178961393.asia-south1.run.app/cod/dashboard/summary
```

## Response Mode

This reconciliation intentionally returns `API demo fallback data`.

It does not query production order, buyer, OTP, automation, or event-log tables. This keeps the endpoint safe until durable COD dashboard persistence is explicitly designed and approved.

The response shape is compatible with the dashboard DTO:

```json
{
  "success": true,
  "data": {
    "dataMode": "DEMO_FALLBACK",
    "sourceLabel": "API demo fallback data",
    "rows": []
  },
  "meta": {
    "mode": "demo-preview",
    "timestamp": "2026-05-29T00:00:00.000Z"
  }
}
```

## Safety Rules

- Read-only endpoint.
- No database migration required.
- No production data queried.
- No OTP code fields returned.
- No webhook secrets, task secrets, tokens, or API keys returned.
- No raw buyer phone numbers or email addresses returned.
- No real buyer or order data used.
- Rows are synthetic `COD-DEMO-*` examples only.

## Verification

After the next API deployment, verify:

```bash
curl -i https://shipmastr-api-525178961393.asia-south1.run.app/cod/dashboard/summary
```

Expected:

- HTTP `200`
- JSON body with `success: true`
- `data.dataMode: DEMO_FALLBACK`
- No OTP code, secret value, raw phone, or raw email fields

Then reload:

```text
https://shipmastr-dashboard-jscfc5kumq-el.a.run.app/admin/cod-automation
```

Expected dashboard state:

- `API demo fallback`, not `Local demo fallback`
- COD tiers and automation statuses visible
- No OTP codes
- No secrets
- No raw buyer PII

## Deploy Follow-Up

This branch does not deploy.

Next manual step:

1. Review and merge this production backend reconciliation.
2. Deploy only the API service from the production backend repo.
3. Probe `/cod/dashboard/summary`.
4. Reload the dashboard and confirm it moves to `API demo fallback`.

Do not run production migrations for this change.
