# W2A COD Instruction-Only Netting

W2A adds a non-custodial COD netting instruction engine. It calculates what should happen for review and export, but it does not move money, receive money, pay sellers, settle couriers, or create live wallet value.

## Scope

Implemented locally:

- `CodInstructionNettingService`
- `CodNettingBatchService`
- `CodNettingReadService`
- `W2CodReadinessService`
- additive tables:
  - `cod_netting_batches`
  - `cod_netting_items`
  - `cod_netting_instruction_events`
- local smoke script:
  - `scripts/wallet-w2a-cod-netting-smoke.mjs`

Not implemented:

- COD custody
- money movement
- seller pay execution
- courier settle execution
- wallet top-up or cashout
- external bank/provider calls
- W3 checkout split settlement
- early COD or lending
- public mutating seller APIs
- live activation

## Formula

W2A stores minor-unit strings at the service boundary and persists `BIGINT` columns.

```text
sellerNetReceivableMinor =
  codCollectedMinor
  - freightDeductionMinor
  - rtoDeductionMinor
  + adjustmentMinor
```

Negative net is allowed only as an instruction. It becomes `seller_payable_to_platform_or_courier_instruction` and is marked `review_required`. It is not auto-debited.

Zero net is allowed and becomes `zero_net_instruction`.

## Status Model

Instruction statuses:

- `draft`
- `review_required`
- `approved_instruction`
- `exported_instruction`
- `voided`

No W2A status means that money was sent, received, or otherwise executed.

## Review Rules

W2A marks an item `review_required` when it sees:

- negative net
- missing internal shipment reference
- duplicate internal shipment reference inside the same batch
- invalid minor-unit amount
- unknown courier code
- unsafe inbound reference

Unsafe inbound references are not stored in item reference fields. The row remains reviewable through its source row hash.

## Idempotency

Batch creation is idempotent by:

```text
sellerOrgId + courierCode + period + sourceRef
```

If the same key is submitted with the same source hash, the existing batch is returned. If the same key is submitted with changed rows or amounts, W2A returns `W2A_SOURCE_REF_HASH_CONFLICT`.

## Export Boundary

Exports are JSON/CSV instruction reports for review. Export output includes:

- batch totals
- item net amounts
- instruction type
- review status
- source row hash

Exports do not execute external movement and do not create spendable balances.

## Activation Boundary

W2A remains blocked by W1D and future W2 approvals. `W2CodReadinessService` intentionally returns blocked live readiness. W2A is only an instruction/reporting layer until separate legal, accounting, operations, and owner approvals exist.

Shadow dispute aging is intentionally separate future work and is not part of W2A.
