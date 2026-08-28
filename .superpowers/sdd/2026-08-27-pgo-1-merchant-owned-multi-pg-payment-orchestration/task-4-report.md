# Task 4 Report: Provider-Neutral Exact Matching and Deterministic Reducer

## Scope

Implemented the pure Task 4 payment-orchestration matching and reduction slice in `/Users/mac/shipmastr-backend-pgo-1`:

- extended `src/modules/paymentOrchestration/types.ts` with the canonical observation, match, and reduction-plan interfaces required by the brief;
- added `src/modules/paymentOrchestration/matching.ts` for exact-field, provider-neutral observation matching with source-specific authenticity checks;
- added `src/modules/paymentOrchestration/reducer.ts` for deterministic evidence classification, duplicate/integrity handling, absorbing success, mapping-gap precedence over terminal failure, contradiction signaling, refund-due planning, and related-attempt preservation with no Prisma or provider I/O;
- added focused `node:test` coverage in:
  - `src/modules/paymentOrchestration/__tests__/matching.test.ts`
  - `src/modules/paymentOrchestration/__tests__/reducer.test.ts`
  - `src/modules/paymentOrchestration/__tests__/reducerPermutations.test.ts`

Cashfree and Paytm runtime execution remained out of scope.

## TDD evidence

1. Per the brief, I added the new canonical Task 4 type surface first so the tests could compile against the required interfaces. I treated that as interface scaffolding, not behavioral implementation.
2. RED: wrote the matcher, reducer, and permutation regressions before creating `matching.ts` or `reducer.ts`.
3. Initial RED verification command:

```text
npm run build && node --test dist/modules/paymentOrchestration/__tests__/matching.test.js
```

Initial result: TypeScript failed with the expected missing-module error for `../matching.js`, and also surfaced one strict test-harness issue because `returnedIdempotencyKey` was being materialized as `undefined` under `exactOptionalPropertyTypes`.

4. Harness-only correction: updated the test helper to omit `returnedIdempotencyKey` unless it was explicitly provided.
5. Clean RED verification command:

```text
npm run build
```

Clean RED result:

```text
src/modules/paymentOrchestration/__tests__/matching.test.ts(3,34): error TS2307: Cannot find module '../matching.js' or its corresponding type declarations.
src/modules/paymentOrchestration/__tests__/reducer.test.ts(3,32): error TS2307: Cannot find module '../reducer.js' or its corresponding type declarations.
src/modules/paymentOrchestration/__tests__/reducerPermutations.test.ts(3,32): error TS2307: Cannot find module '../reducer.js' or its corresponding type declarations.
```

6. GREEN: implemented the minimal pure matcher/reducer needed to satisfy the frozen semantics and reran the focused Task 4 verification surface.

## Verification

Focused Task 4 verification command:

```text
npm run build && node --test dist/modules/paymentOrchestration/__tests__/matching.test.js dist/modules/paymentOrchestration/__tests__/reducer.test.js dist/modules/paymentOrchestration/__tests__/reducerPermutations.test.js
```

Result:

```text
✔ matchObservation
✔ reduceEvidence
✔ reduceEvidence permutation stability
ℹ tests 84
ℹ suites 3
ℹ pass 84
ℹ fail 0
```

Provider-neutral reducer check:

```text
rg -n "CASHFREE|PAYTM|Prisma|PrismaClient|paymentAttempt|paymentObligation|providerObservation" /Users/mac/shipmastr-backend-pgo-1/src/modules/paymentOrchestration/reducer.ts
```

Result: exit code `1` with no matches, confirming no provider-native or database-I/O branch was introduced in `reducer.ts`.

## Behavior delivered

- `matchObservation` now rejects single-field mismatches with named reasons for merchant, provider, environment, credential binding, source/authentication, evidence authority, order reference, success transaction reference, exact amount, exact INR currency, mapping version, internal references, and optional idempotency-key mismatch.
- Source authenticity is fail-closed and table-covered:
  - `WEBHOOK` accepts only `signatureVerification = VERIFIED` with `evidenceAuthority = ELIGIBLE`;
  - `STATUS_QUERY`, `PROVIDER_RECORD`, and `MOCK` accept only `signatureVerification = NOT_APPLICABLE` with `evidenceAuthority = ELIGIBLE`;
  - `MOCK` still requires the attempt and observation provider to match normally, so `source` alone cannot claim authenticity.
- The reducer classifies same-event/same-hash replays as idempotent duplicates and same-event/different-hash replays as `INTEGRITY_CONFLICT`.
- Success is absorbing across the obligation evidence set, while distinct successful transaction references remain preserved and can produce `SURPLUS_DOUBLE_SUCCESS` refund-due planning plus `DOUBLE_SUCCESS_DETECTED` attention.
- `UNMAPPED` evidence becomes `MAPPING_GAP` and blocks terminal-failure resolution, preserving the mixed mapped-failure plus mapping-gap precedence required by the brief/spec.
- Review completion is machine-driven when a currently `REQUIRED` or `IN_PROGRESS` target attempt becomes resolved; the reducer emits `completedByType = SYSTEM`.
- The permutation suite freezes arrival-order independence by checking every permutation of evidence sets up to five observations after normalizing output ordering.

## Rulings made

- `providerOrderRef` is required to be already bound on the target attempt for an exact match. If `attempt.providerOrderRef` is `null`, the matcher returns `ORDER_REFERENCE_MISMATCH` rather than falling back to request idempotency.
- `MISSING_TRANSACTION_REFERENCE` is enforced only for `mappedOutcome = 'SUCCEEDED'`. `PENDING` and `UNKNOWN` observations may remain matchable with `providerTransactionRef = null`, which preserves the timeout/unknown reducer behavior required by the brief.
- Integrity conflict is evaluated at the provider-event level before semantic success/failure reduction for that event, so a reused event ID with a different hash cannot claim terminal authority.

## Constraints and safety

- No PostgreSQL command was needed for Task 4, so `/Users/mac/.config/shipmastr/pgo1-a965f431-test.env` was not sourced.
- No provider SDK, network call, production DB mutation, migration, deploy, push, or merge was performed.
- Existing dirty generated drift in `dist/` and `node_modules/` was preserved and will not be staged into the Task 4 commit.
