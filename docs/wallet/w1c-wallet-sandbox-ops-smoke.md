# W1C Wallet Sandbox Operations Smoke

W1C is a local/internal sandbox smoke runner for the W1A/W1B closed-loop shipping wallet foundation. It proves the wallet flow end-to-end without activating live movement.

## Scope

Implemented:

- local script: `scripts/wallet-w1c-sandbox-smoke.mjs`
- internal service wrapper: `W1SandboxSmokeService`
- dry-run plan by default
- execute mode for local/test databases only
- deterministic sandbox fixture refs
- W1A service reuse for provisioning, sandbox top-up, hold, capture, and wallet-only refund
- W1B read service reuse for summary and statement verification
- unsupported cashout and closure blockers

Not implemented:

- W2 or W3
- COD custody
- bank movement
- checkout split settlement
- lending
- provider payment calls
- public mutation routes
- external workflow or cloud orchestration
- live database or deployment work

## Command

Build first so the script can import compiled backend modules:

```bash
npm run build
```

Dry-run is the default:

```bash
node scripts/wallet-w1c-sandbox-smoke.mjs --json
```

Execute requires explicit `--execute` and safe W1 flags:

```bash
WALLET_W1_ENABLED=true \
WALLET_W1_SANDBOX_ONLY=true \
WALLET_W1_ALLOW_LIVE_PAYMENTS=false \
WALLET_W1_ALLOW_CASHOUT=false \
node scripts/wallet-w1c-sandbox-smoke.mjs \
  --execute \
  --seller-org-id org_w1c_sandbox_seller \
  --created-by usr_w1c_operator \
  --period 2026-07 \
  --json
```

Execute refuses production-like runtime and any live-payment or cashout flag.

## Flow

The smoke runner verifies:

1. readiness
2. seller wallet provisioning
3. sandbox top-up intent creation
4. sandbox top-up confirmation
5. summary after top-up
6. shipment estimate hold
7. shipment charge capture
8. unused hold remainder release through hold status
9. summary after capture
10. wallet-only shipment refund
11. custodial-only statement read
12. unsupported cashout and closure actions remain blocked

## Fixture

All money is string minor units:

- top-up: `100000`
- hold: `45000`
- capture: `42000`
- unused hold remainder: `3000`
- refund: `7000`

Expected final summary:

```json
{
  "postedMinor": "65000",
  "heldMinor": "0",
  "availableMinor": "65000"
}
```

## Safety

W1C does not add routes or controllers. It does not expose top-up, hold, capture, or refund as a public action.

Dry-run produces a planned sequence and writes no accounts, intents, holds, or journal rows.

Execute uses W1A services and `LedgerService` only. W1C does not write journal entries, postings, balances, or outbox rows directly.

Shadow balances remain non-spendable and are excluded from W1C summary and statement reads.

Generated refs are opaque/internal. Buyer-resolvable, contact-like, and location-like values must not enter journal refs, source refs, narratives, or smoke output.

## Rerun Behavior

The runner uses deterministic refs for the period. Re-running the same seller and period is idempotent for:

- top-up intent
- top-up confirmation
- hold
- capture
- wallet-only refund

Reusing the same deterministic ref with a different amount returns a conflict rather than double posting.
