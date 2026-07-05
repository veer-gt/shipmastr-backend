# W2D COD Activation Gate

W2D is a gate and checklist for the W2 COD decision. It does not activate custody, does not move funds, and does not change runtime configuration.

Current W2 mode remains instruction-only.

## Scope

Implemented:

- `W2CodActivationGateService`
- `scripts/wallet-w2d-cod-activation-gate.mjs`
- machine-readable checklist grouped by legal, accounting, banking, operations, technical, owner, and future W3 categories
- tests proving custody remains blocked by default

Not implemented:

- COD custody
- money movement
- seller pay execution
- courier settle execution
- bank movement or cashout
- W3 checkout split settlement
- lending or early COD funding
- public mutating seller APIs
- provider calls or external workflow calls
- live activation

## Command

```bash
node scripts/wallet-w2d-cod-activation-gate.mjs --json
```

For custody review:

```bash
node scripts/wallet-w2d-cod-activation-gate.mjs \
  --target custody \
  --evidence-file ./local/w2-cod-evidence.json \
  --json
```

The command is read-only. It has no execute mode and performs no database writes.

## Status Semantics

- `instruction_only`: current safe mode; W2A, W2B, and W2C remain instruction-only.
- `blocked`: custody or unsafe runtime flags are missing required evidence.
- `review_ready`: all custody evidence is present, but custody is still not activated.

Even when the custody target is `review_ready`, separate owner action would still be required before any future implementation. W2D does not enable flags or live services.

## Required Evidence

Custody review requires documented evidence across:

- legal position and seller disclosures
- accounting treatment for COD receivables, deductions, GST, TDS, and principal/agent treatment
- banking partner, nodal/escrow, settlement account, and payout-file control review
- reconciliation, exception, negative-net, duplicate-remittance, audit export, and support SOPs
- owner mode approval, pilot limit approval, and rollback plan approval

Future W3 items remain blocked:

- checkout split settlement
- early COD lending
- payment aggregator review
- digital lending review

W3A now provides checkout split settlement shadow preview only. W3A does not activate custody, payment capture, payout, settlement execution, lending, or payment aggregator behavior. Future W3D approvals remain required before any live activation.

## Technical Lock

W2D reports the technical lock:

- W2A remains instruction-only.
- W2B export-preview remains read-only.
- W2C smoke confirms the instruction-only flow.
- No COD custody table is treated as spendable balance.
- No payout execution route is present.
- No bank transfer integration is present.
- No seller shipping balance COD credit path is present.
- No public mutating seller W2 API is present.
- COD output avoids public or private references.

## Activation Boundary

W2D is not activation. Live activation remains blocked until all required evidence and owner approval are documented and a separate approved implementation exists.
