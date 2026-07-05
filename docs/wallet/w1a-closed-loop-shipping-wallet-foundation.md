# W1A Closed-Loop Shipping Wallet Foundation

W1A adds an internal, sandbox-only closed-loop shipping wallet foundation on top of the W0 ledger service. It is not a public wallet launch and it does not move real money.

## Scope

Implemented:

- seller closed-loop wallet provisioning
- custodial seller `shipping_balance`
- custodial seller `dispute_hold`
- sandbox top-up intent creation
- sandbox top-up confirmation through `LedgerService`
- shipment estimate holds
- shipment charge capture through `LedgerService`
- shipment refund back to wallet through `LedgerService`
- read-only summary and statement services
- closure and cashout policy blockers
- readiness checks for unsafe flags

Not implemented:

- W2
- W3
- COD custody
- bank payouts
- checkout split settlement
- lending
- real payment gateway calls
- live courier settlement
- public seller routes or controllers
- live database or deployment work
- external workflow automation

## Feature Flags

Safe defaults:

```text
WALLET_W1_ENABLED=false
WALLET_W1_SANDBOX_ONLY=true
WALLET_W1_ALLOW_LIVE_PAYMENTS=false
WALLET_W1_ALLOW_CASHOUT=false
```

W1A mutating commands refuse when the feature is disabled, when runtime is production-like, when sandbox-only mode is off, or when live payment movement is enabled.

## Accounts

Provisioning `ensureSellerClosedLoopWallet()` creates or finds:

- `wallet_owner`: `owner_type=seller`, `external_id=<sellerOrgId>`
- seller `shipping_balance`, custodial
- seller `dispute_hold`, custodial

It does not create checkout, COD custody, leakage, suspense, revenue, or tax accounts. Courier payable and platform gateway clearing accounts are created only when needed by sandbox top-up confirmation or shipment charge/refund tests.

## Posting Shapes

Sandbox top-up confirmation:

```text
DR platform gateway_clearing
CR seller shipping_balance
entry_type=topup
ledger_scope=custodial
source_type=sandbox_topup
```

Shipment charge capture:

```text
DR seller shipping_balance
CR courier courier_payable
entry_type=shipment_charge
ledger_scope=custodial
```

Shipment refund:

```text
DR courier courier_payable
CR seller shipping_balance
entry_type=shipment_refund
ledger_scope=custodial
```

All journal movement goes through `LedgerService`. W1A services do not write journal entries, postings, balances, or ledger outbox records directly.

## Holds

Shipment estimate holds are internal reservations on the seller shipping balance. Available balance is:

```text
postedMinor - activeHeldMinor
```

Capture marks the hold captured and releases any unused remainder by removing the active hold from availability math. No live courier settlement is triggered.

## Read Models

`getWalletSummary()` returns string minor units:

- `postedMinor`
- `heldMinor`
- `availableMinor`

`getWalletStatement()` returns custodial wallet rows only. Shadow rows are excluded from spendable balance and statement output.

Default statement output omits raw source refs and narratives. Internal refs use opaque W1A refs.

## Closure Policy

W1A blocks:

- mid-life cashout
- closure bank settlement

Refund-to-source is documented as a sandbox policy only. Real closure settlement is future work outside W1A.

## I17-Safe Refs

W1A rejects buyer-resolvable, contact-like, and location-like refs before they can enter:

- ledger refs
- ledger source refs
- hold refs
- hold source refs
- outbox payloads
- default statement output

W1A hashes shipment inputs into opaque internal refs before persistence.

## Boundary

W1A is a sandbox/internal foundation only. It does not alter W0 shadow import behavior, W0 correction behavior, W0 recovery reports, or normalized W0B import schema.
