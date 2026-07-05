# Checkout C6 - Live Payment-Provider Activation Gate

Status: read-only readiness gate, not activation.

## Scope

C6 adds a machine-readable readiness report for live checkout payments. It does not deploy provider calls, enable live webhooks, create settlement execution, create payout execution, create COD custody, add public APIs, mutate configuration, or move money.

The local CLI is:

```sh
node scripts/checkout-activation-gate.mjs --json
```

`--execute` is intentionally rejected with `CHECKOUT_C6_READ_ONLY_NO_EXECUTE`.

## Runtime Input

Runtime booleans are gate inputs only. They are not Shipmastr config/env fields and are not added to `src/config/env.ts`.

The service accepts:

```ts
{
  checkoutLivePaymentsEnabled?: boolean;
  razorpayLiveEnabled?: boolean;
  cashfreeLiveEnabled?: boolean;
  liveWebhookEnabled?: boolean;
  settlementExecutionEnabled?: boolean;
  payoutExecutionEnabled?: boolean;
  codCustodyEnabled?: boolean;
  nodeEnv?: string;
  appEnv?: string;
}
```

All booleans default to `false`. `nodeEnv` may default from `process.env.NODE_ENV`; `appEnv` may default from `process.env.APP_ENV` when present. The gate does not infer live readiness from guessed env var names.

Supported `APP_ENV` values remain:

- `development`
- `test`
- `staging`
- `production`

`live` is not a valid Shipmastr `APP_ENV` value. Staging/production runtime context blocks live activation readiness until full C6 evidence is present.

The CLI exposes explicit runtime flags:

```sh
node scripts/checkout-activation-gate.mjs --json \
  --checkout-live-payments-enabled \
  --razorpay-live-enabled \
  --live-webhook-enabled \
  --node-env production \
  --app-env production
```

If runtime flags are absent, the live/execution booleans are false.

## Evidence Checklist

C6 requires evidence for:

- legal payment aggregator position and checkout terms
- accounting treatment for payments, refunds, and reversals
- Razorpay and Cashfree live account approval
- live key handling and rollback signoff
- webhook signature verification
- webhook replay protection
- webhook amount, currency, and order reference cross-validation
- refund/reversal SOP
- payment reconciliation SOP
- payment support escalation SOP
- owner approval
- rollback plan

Evidence can be supplied through `--evidence CODE=ref`, `--evidence-file path.json`, or dedicated approval flags such as `--owner-approval`.

## Blocking Runtime Flags

Without full evidence, these runtime flags block:

- `--checkout-live-payments-enabled`
- `--razorpay-live-enabled`
- `--cashfree-live-enabled`
- `--live-webhook-enabled`

These flags are always outside C6 scope and block:

- `--settlement-execution-enabled`
- `--payout-execution-enabled`
- `--cod-custody-enabled`

Even with complete evidence, C6 returns `review_ready` with `activationAllowed: false`. Separate owner-approved rollout work is required before any live provider/env/key/deploy change.

## Safety Boundaries

- no public controller or API route
- no provider SDK calls
- no Secret Manager, Cloud Run, hosted runtime, or n8n work
- no settlement execution
- no payout execution
- no COD custody
- no wallet ledger writes
- no DB migration
