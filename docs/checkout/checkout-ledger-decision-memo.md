# Checkout Ledger Decision Memo

C0 does not choose or implement a ledger path. This memo compares options for owner review before C1 schema is finalized.

## Context

Shipmastr now has W0-W3D wallet work:

- W0: shadow/import ledger foundation
- W1: sandbox closed-loop shipping wallet and read surfaces
- W2: COD instruction-only netting and activation gate
- W3A/W3B: checkout settlement preview/read/export only
- W3C: early COD partner prequalification preview only
- W3D: final W3 activation gate/checklist only

New Shipmastr Checkout is a buyer quote/order/payment/COD-choice flow. It must not silently activate W3 settlement, COD custody, payout, bank movement, early COD funding, or live payment-provider behavior.

## Option A: Separate Checkout Ledger / Checkout Accounting Tables

Create checkout-specific accounting/event tables for quote/order/payment/COD lifecycle. Reconcile those tables against wallet ledger nightly or through an explicit reviewed job later.

Possible table families in C1/C2:

- checkout quotes
- checkout orders
- checkout payment attempts
- checkout provider events
- checkout timeline/audit
- checkout COD collection state
- checkout accounting entries or event facts

### Pros

- Keeps buyer checkout separate from W0-W3 wallet gates.
- Avoids accidental custodial interpretation of buyer payment events.
- Preserves W3A/W3B as preview-only settlement/read surfaces.
- Easier to match fixed reference semantics: quote, order, payment, webhook, `refund_due`, buyer token.
- Lets Postgres E2E smoke prove checkout hardening before any wallet integration.
- Reduces blast radius on existing `LedgerService` and wallet account types.
- Allows owner/accounting review of ledger mapping after real checkout domain semantics are visible.

### Cons

- Requires later reconciliation bridge to wallet ledger if/when owner approves.
- More tables and reporting surfaces.
- There is a risk of duplicated accounting concepts if naming is loose.
- Nightly reconciliation must be designed, tested, and audited before live use.

### Migration Risk

Medium. New additive checkout tables are required, but existing wallet and fulfillment models can remain unchanged.

### Reconciliation Risk

Medium. Separate records require explicit tie-outs between checkout payment facts, provider events, fulfillment orders, and wallet previews. This is manageable if C1 stores stable internal refs and C5 adds E2E reconciliation smoke.

### Regulatory / Custody Risk

Lower than Option B for C1. Keeping checkout events outside wallet ledger reduces the chance that preview/sandbox ledger rows are interpreted as spendable balance, custody, settlement, payout, or COD custody.

### Implementation Complexity

Medium. C1 needs new checkout event/accounting records and serializers, but avoids deep ledger account design during the first checkout foundation phase.

### Test Impact

Add tests for:

- quote math
- idempotent order creation with request hash
- buyer token access
- payment attempt state
- provider webhook cross-validation
- `refund_due`
- no wallet ledger posts
- later reconciliation export shape

### Interaction With W0-W3 Gates

- W0-W3 remain unchanged.
- W3A can later consume reviewed checkout summary rows for preview only.
- W3D remains the final gate before live checkout settlement.
- No wallet account balances become spendable from C1.

## Option B: Post Checkout Events Directly Into Existing Wallet Ledger

Post buyer checkout payment/COD events directly through `LedgerService` with new entry types and account types.

### Pros

- Single ledger source for payment-adjacent facts.
- Reuses W0A idempotent double-entry posting and balance invariants.
- Could simplify future settlement preview if account design is correct.
- Reduces later bridge/reconciliation work.

### Cons

- High risk of conflating buyer checkout with W3 settlement preview.
- Requires new wallet account-type design before checkout semantics are fully settled.
- Could imply custody or spendable balance if rows are posted to custodial scope or seller accounts incorrectly.
- Adds pressure to W3D/W1D gates because checkout capture events and settlement expectations become ledger-visible.
- Higher blast radius in `LedgerService`, account config seed rows, wallet read serializers, admin reports, and existing safety greps.
- Harder to preserve fixed reference behavior quickly without dragging wallet scope into C1.

### Migration Risk

High. New account types, entry types, and seed rows would likely be required. Mistakes could affect wallet invariants, generated Prisma client, existing wallet tests, and future W3 gates.

### Reconciliation Risk

Low-to-medium if designed perfectly, but high if semantics are wrong. Direct ledger posting makes reconciliation immediate, but correcting wrong account semantics later is expensive.

### Regulatory / Custody Risk

Higher. Direct ledger rows can be misread as custody, settlement, or seller balance movement. This is especially risky before payment provider, accounting, and owner approval evidence exists.

### Implementation Complexity

High. Requires wallet design, migration, account type config, posting tests, serializer decisions, and new gate checks before C1 can safely ship.

### Test Impact

Add tests for:

- all checkout ledger entry types
- balanced postings
- account owner/scope restrictions
- idempotency and reversal behavior
- no spendable balance exposure
- W3D blocked status remains intact
- settlement preview remains preview-only

### Interaction With W0-W3 Gates

- Must not bypass W3D.
- Requires explicit mapping to W3A preview or a new W3 bridge.
- Risks accidental coupling to W1 shipping balance or W2 COD instruction work.

## Recommendation

Recommend Option A for C1-C2: separate checkout domain/event/accounting tables, reconciled against wallet ledger later through an owner-approved bridge.

Reasoning:

- C1 must preserve the fixed checkout hardening without reopening wallet semantics.
- Checkout order/payment/COD behavior needs its own domain model first.
- Wallet W3 checkout naming currently means settlement-preview, not buyer checkout.
- Direct wallet posting should wait until accounting, custody, settlement, and owner review are complete.

Final decision: requires owner review before C1 schema is finalized.

## Review Questions Before C1

1. Is Shipmastr the merchant of record, payment facilitator, software provider, or checkout orchestration layer for the first pilot?
2. Should checkout payments ever create custodial wallet rows, or only provider reconciliation records?
3. When should a checkout order become a fulfillment `Order`?
4. What state owns refund_due: checkout payment state, wallet ledger state, or both?
5. What provider mode is allowed in C1: mock only, sandbox provider, or no provider adapter at all?
6. What are the seller-visible terms for partial COD advance and full COD fee waiver?

