# W1B Wallet Read Surfaces

W1B exposes W1A through read-only operational and seller-safe surfaces. It does not activate live wallet movement.

## Scope

Implemented:

- internal W1 readiness read endpoint
- admin W1 wallet summary read endpoint
- admin W1 wallet statement read endpoint
- seller W1 wallet summary read endpoint
- seller W1 wallet statement read endpoint
- seller read guard using W1 safe flags
- custodial-only summary and statement serialization

Not implemented:

- W2
- W3
- COD custody
- bank payouts
- checkout split settlement
- lending
- payment gateway integration
- top-up, hold, capture, refund, cashout, payout, or settlement mutation routes
- live database or deployment work
- external workflow automation

## Routes

Internal:

```text
GET /api/internal/wallet/w1/readiness
```

Admin:

```text
GET /api/admin/wallets/w1/:sellerOrgId/summary
GET /api/admin/wallets/w1/:sellerOrgId/statement
```

Seller:

```text
GET /api/seller/wallet/w1/summary
GET /api/seller/wallet/w1/statement
```

The seller routes derive `sellerOrgId` from authenticated seller context only. A seller cannot pass an arbitrary seller id.

## Guards

Seller reads require:

```text
WALLET_W1_ENABLED=true
WALLET_W1_SANDBOX_ONLY=true
WALLET_W1_ALLOW_LIVE_PAYMENTS=false
WALLET_W1_ALLOW_CASHOUT=false
```

Admin and internal routes are visibility surfaces only. They do not expose mutation actions.

## Response Shape

Summary returns string minor units:

- `sellerOrgId`
- `scope=custodial`
- `sandboxOnly`
- `enabled`
- `postedMinor`
- `heldMinor`
- `availableMinor`
- `disputeHeldMinor`
- `currency`
- `accountStatus`
- `lastLedgerAt`

Statement returns custodial postings only:

- `entryId`
- `entryType`
- `sourceType`
- `sourceRef`, only when it is an opaque internal W1 ref
- `amountMinor`
- `direction`
- `createdAt`
- `narrative`, only when safe

Shadow balances are never spendable and never appear in seller spendable reads.

## Safety

W1B does not bypass `LedgerService`, but it also does not post journal movement. It only reads W1 ledger state.

Default statement serialization removes buyer-resolvable, contact-like, and location-like refs or narratives. Public operational refs must not appear in seller responses.

W1B does not change W0 import behavior, W0 shadow ledger behavior, W0 corrections, W1A posting behavior, or W1A sandbox mutation rules.

## W1C Smoke Runner

W1C adds a local/internal sandbox smoke runner that consumes these W1B read services to verify final wallet summary and statement output after a deterministic W1A sandbox flow.

W1C does not add read or mutation routes. It keeps dry-run as the default and execute mode local/test only. Shadow balances remain excluded from W1C reads.
