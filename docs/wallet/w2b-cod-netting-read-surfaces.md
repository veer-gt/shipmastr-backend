# W2B COD Netting Read Surfaces

W2B exposes W2A COD instruction batches through protected read and export-preview surfaces. It is still instruction-only.

## Scope

Implemented:

- internal readiness read:
  - `GET /api/internal/wallet/w2/cod/readiness`
- admin batch list:
  - `GET /api/admin/wallets/w2/cod/batches`
- admin batch detail:
  - `GET /api/admin/wallets/w2/cod/batches/:batchId`
- admin export preview:
  - `GET /api/admin/wallets/w2/cod/batches/:batchId/export-preview`
- seller-scoped summary and batch list:
  - `GET /api/seller/wallet/w2/cod/summary`
  - `GET /api/seller/wallet/w2/cod/batches`

No W2B route uses `POST`, `PUT`, `PATCH`, or `DELETE`.

## Boundary

W2B does not:

- move money
- create COD custody
- pay sellers
- settle couriers
- execute bank movement or cashout
- credit W1 shipping balance from COD
- create spendable COD wallet balance
- implement W3 checkout split settlement
- implement lending or early COD funding
- call providers or external workflow tools
- add public mutating seller APIs

## Access Control

- internal readiness is protected by the internal secret guard
- admin reads are protected by admin auth
- seller reads are protected by seller auth and derive seller scope from the authenticated account
- sellers cannot pass an arbitrary seller org id to read another seller's COD instruction batches

## Response Policy

Every response is explicit about the instruction-only boundary:

- `movementExecuted=false`
- `custodyCreated=false`
- `payoutExecuted=false`
- `settlementExecuted=false`
- `spendableBalanceCreated=false`

Money values are serialized as string minor units.

W2B avoids publicly resolvable operational identifiers and does not expose raw inbound remittance references. Item output uses internal instruction item IDs and sanitized internal shipment references only.

## Export Preview

Export-preview is read-only. It does not change batch status and does not create an instruction event.

The required disclaimer is:

```text
Instruction preview only. No money movement has been executed by Shipmastr.
```

Export-preview is not payment execution.

W2C uses this export-preview surface in its local/internal smoke runner to prove that clean `approved_instruction` batches can be inspected without changing status or creating new instruction events.

## Activation

Live activation remains blocked by W1D, W2D, and future W2 approvals. W2B is visibility and review support only.

W2B does not implement W3, lending, early COD funding, COD custody, seller payment execution, courier settlement execution, or live provider movement.
