# W2C COD Reconciliation Smoke

W2C is a local/internal reconciliation smoke runner for the W2A + W2B instruction stack. It proves that deterministic COD inputs can be planned, reviewed, approved as instructions, read, and export-previewed without creating custody or moving funds.

## Scope

Implemented:

- `W2CCodReconciliationSmokeService`
- `scripts/wallet-w2c-cod-reconciliation-smoke.mjs`
- deterministic review and clean fixtures
- focused W2C tests

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
node scripts/wallet-w2c-cod-reconciliation-smoke.mjs \
  --seller-org-id org_w2c_sandbox_seller \
  --courier-code BIGSHIP_SYNTHETIC \
  --period 2026-07 \
  --created-by usr_w2c_operator \
  --json
```

Dry-run is the default. It validates the sequence and reports planned outcomes with:

```text
writes.batches = 0
writes.items = 0
writes.events = 0
```

Use `--execute` only in local/test-style runtime. Execution records W2A instruction rows only. It is blocked for production, staging, and live runtime modes.

## Deterministic Fixture

The clean item uses string minor units:

```text
codCollectedMinor = 100000
freightDeductionMinor = 18000
rtoDeductionMinor = 5000
adjustmentMinor = 3000
sellerNetReceivableMinor = 80000
```

The review fixture includes:

- a negative-net trap
- a duplicate internal shipment reference trap
- a missing internal shipment reference trap
- an unknown courier-code trap

Generated references are internal-only and use `codbatch_w2c_...`, `shp_w2c_...`, and `usr_w2c_...` shapes.

## Verified Flow

W2C verifies:

- readiness remains blocked for live activation
- review batch becomes `review_required`
- review batch approval is blocked while review issues exist
- clean batch can become `approved_instruction`
- W2B read service can read the clean batch
- W2B export-preview is read-only
- export-preview does not change status
- export-preview does not create an instruction event
- `movementExecuted=false`
- `payoutExecuted=false`
- `settlementExecuted=false`
- W1 COD credit is not created
- custody is not created
- output avoids public operational identifiers
- output does not describe completed funds movement

## Export Preview Boundary

W2B export-preview is a review artifact, not payment execution. It does not move funds, create custody, settle couriers, or change batch status.

## Activation Boundary

W2C does not activate COD settlement. Live activation remains blocked by W1D and future W2 approvals.

Shadow dispute aging is intentionally separate future work.
