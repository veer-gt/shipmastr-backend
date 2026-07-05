# W3D Final Activation Gate

W3D is a gate/checklist only. It is not activation.

Current W3 mode remains preview-only:

- W3A checkout settlement is shadow/preview only.
- W3B checkout settlement reads are read/export-preview only.
- W3C early COD partner rail is instruction/pre-qualification preview only.

## Scope

Implemented:

- internal W3 activation gate service
- machine-readable checklist/report
- local read-only CLI report
- tests proving W3 remains blocked by default

Not implemented:

- live checkout settlement
- payment capture
- payout execution
- bank transfer or cashout
- COD custody
- lending or early COD funding
- partner API calls
- public mutating seller APIs
- seller shipping balance credit from checkout, COD, or early COD

No database migration is required for W3D.

## Statuses

The gate returns:

- `preview_only`: current safe state
- `blocked`: requested target is missing required evidence or unsafe runtime flags are present
- `review_ready`: all required evidence is documented, but nothing is enabled

Even with full evidence, W3D returns `review_ready`, not activated.

## Target Modes

- `preview_only`
- `checkout_settlement`
- `early_cod_partner`
- `full_w3`

`preview_only` is the default. It can remain `preview_only` when W3A/W3B/W3C technical safeguards are present.

`checkout_settlement` is blocked unless legal, accounting, payment partner, banking, operations, technical, owner, and post-activation control evidence is documented.

`early_cod_partner` is blocked unless legal, accounting, lending partner, banking, operations, technical, owner, and post-activation control evidence is documented.

`full_w3` is blocked unless both checkout settlement and early COD partner evidence sets are complete.

## Evidence Categories

W3D tracks:

- legal
- accounting
- payment partner
- lending partner
- banking
- operations
- technical
- owner
- post-activation controls

Unknown or missing required evidence fails closed.

## Unsafe Runtime Flags

These flags block unless all required evidence for the target is documented:

- `walletW3Enabled`
- `checkoutSettlementEnabled`
- `paymentCaptureEnabled`
- `payoutExecutionEnabled`
- `earlyCodFundingEnabled`
- `lendingPartnerEnabled`
- `allowBankTransfer`

Production, staging, or live runtime emits final-review warnings and remains blocked unless required evidence exists. Even then, W3D does not enable anything.

## CLI

```bash
node scripts/wallet-w3d-activation-gate.mjs --json
```

Target example:

```bash
node scripts/wallet-w3d-activation-gate.mjs \
  --target checkout_settlement \
  --json
```

Evidence may be supplied as repeated refs:

```bash
node scripts/wallet-w3d-activation-gate.mjs \
  --target full_w3 \
  --evidence OWNER_W3_MODE_APPROVAL=owner-review-2026-07 \
  --json
```

or as a JSON file:

```bash
node scripts/wallet-w3d-activation-gate.mjs \
  --target full_w3 \
  --evidence-file ./local-only-w3-evidence.json \
  --json
```

The CLI is read-only. It has no execute mode and performs no database writes.

## Activation Boundary

W3D does not activate settlement, capture payments, execute payouts, run bank/cashout movement, create COD custody, create loans, fund early COD, call partners, or create spendable wallet balance.

Live activation remains blocked until all required evidence and owner approval are documented, reviewed, and separately approved in a future activation process.
