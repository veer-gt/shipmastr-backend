# Final Fix Report

## Commit

- Planned commit message: `fix(pgo-1): close final source-only payment orchestration gaps`
- Commit contents limited to source, tests, Prisma schema/migration, fixture manifests, and SDD docs for this final-fix pass.

## Files

- Production logic:
  - `src/modules/paymentOrchestration/attemptCoordinator.ts`
  - `src/modules/paymentOrchestration/credentialPolicy.ts`
  - `src/modules/paymentOrchestration/observationIngestor.ts`
  - `src/modules/paymentOrchestration/observationService.ts`
  - `src/modules/paymentOrchestration/reconciliationWorker.ts`
  - `src/modules/paymentOrchestration/reducer.ts`
  - `src/modules/paymentOrchestration/reductionPersistence.ts`
  - `src/modules/paymentOrchestration/refundDueContract.ts`
  - `src/modules/paymentOrchestration/reviewService.ts`
  - `src/modules/paymentOrchestration/types.ts`
  - `src/modules/paymentOrchestration/policyAudit.ts`
- Tests and guards:
  - `src/modules/paymentOrchestration/__tests__/attemptEligibility.test.ts`
  - `src/modules/paymentOrchestration/__tests__/activationPolicy.test.ts`
  - `src/modules/paymentOrchestration/__tests__/credentialPolicy.test.ts`
  - `src/modules/paymentOrchestration/__tests__/requestId.test.ts`
  - `src/modules/paymentOrchestration/__tests__/observationIngestor.test.ts`
  - `src/modules/paymentOrchestration/__tests__/observationPersistence.test.ts`
  - `src/modules/paymentOrchestration/__tests__/observationTruthGuard.test.ts`
  - `src/modules/paymentOrchestration/__tests__/reducer.test.ts`
  - `src/modules/paymentOrchestration/__tests__/reducerPermutations.test.ts`
  - `src/modules/paymentOrchestration/__tests__/reductionPersistence.test.ts`
  - `src/modules/paymentOrchestration/__tests__/reconciliationWorker.test.ts`
  - `src/modules/paymentOrchestration/__tests__/postgresNamespaceGuard.test.ts`
  - `src/modules/paymentOrchestration/__tests__/postgresTestNamespace.ts`
- Schema and fixture support:
  - `prisma/schema.prisma`
  - `prisma/migrations/20260829120000_pgo_1_final_fix_observation_truth/migration.sql`
  - `src/modules/paymentOrchestration/__fixtures__/paytm/*.manifest.json`
- Existing SDD report preserved and carried forward:
  - `task-4-report.md`

## Tests

- Fresh bounded source-only verification command:

```text
npm run build && node --test dist/modules/paymentOrchestration/__tests__/attemptEligibility.test.js dist/modules/paymentOrchestration/__tests__/activationPolicy.test.js dist/modules/paymentOrchestration/__tests__/credentialPolicy.test.js dist/modules/paymentOrchestration/__tests__/requestId.test.js dist/modules/paymentOrchestration/__tests__/observationPersistence.test.js dist/modules/paymentOrchestration/__tests__/observationTruthGuard.test.js dist/modules/paymentOrchestration/__tests__/observationIngestor.test.js dist/modules/paymentOrchestration/__tests__/matching.test.js dist/modules/paymentOrchestration/__tests__/reducer.test.js dist/modules/paymentOrchestration/__tests__/reducerPermutations.test.js dist/modules/paymentOrchestration/__tests__/reductionPersistence.test.js dist/modules/paymentOrchestration/__tests__/reconciliationWorker.test.js dist/modules/paymentOrchestration/__tests__/refundDueContract.test.js dist/modules/paymentOrchestration/__tests__/mockAdapter.test.js dist/modules/paymentOrchestration/__tests__/cashfreeContract.test.js dist/modules/paymentOrchestration/__tests__/paytmContract.test.js dist/modules/paymentOrchestration/__tests__/interpretation.test.js dist/modules/paymentOrchestration/__tests__/telemetry.test.js dist/modules/paymentOrchestration/__tests__/postgresNamespaceGuard.test.js
```

- PostgreSQL suites were intentionally not run because the env file and scratch database were removed by design for this pass.

## Evidence Limits

- No PostgreSQL commands were run.
- No env file was read, recreated, or sourced.
- No live provider credentials, provider traffic, deploy, push, merge, or non-local side effects were used.
- Generated `dist/` and `node_modules/.prisma/client` output is excluded from the commit and must remain restored before handoff.
- `progress.md` was not edited.

## Focused Follow-up: Provider Order Reference Truth

- Independent review found that persisted `ProviderObservation.providerOrderRef` could still be nullable in Prisma schema, while `providerObservationRowToCanonical` silently normalized `null` to `''`.
- The focused fix tightened canonical truth in two layers:
  - hydration now fails closed with `INVALID_PERSISTED_PROVIDER_ORDER_REF` when a persisted order reference is null, non-string, or blank;
  - `prisma/schema.prisma` and `prisma/migrations/20260829120000_pgo_1_final_fix_observation_truth/migration.sql` now require `ProviderObservation.providerOrderRef` to be non-null and non-empty.

### Focused follow-up tests

- RED command:

```text
node --import tsx --test src/modules/paymentOrchestration/__tests__/observationPersistence.test.ts
```

- RED result:
  - 2 failures for the new null/blank `providerOrderRef` cases, both missing the expected `INVALID_PERSISTED_PROVIDER_ORDER_REF` exception before the fix.

- GREEN command:

```text
node --import tsx --test src/modules/paymentOrchestration/__tests__/observationPersistence.test.ts
```

- PostgreSQL/env-backed migration execution was intentionally not run for this follow-up.

## Focused Follow-up: Nullable Attempt Order Ref Compile Guard

- Independent review found two PostgreSQL tests still passed `PaymentAttempt.providerOrderRef` directly into `CanonicalObservation.providerOrderRef` after canonical truth was tightened to non-null.
- The focused fix keeps the canonical type strict and makes the fixtures explicit:
  - `codSeparation.postgres.test.ts` now reuses the seeded non-null `priorProviderOrderRef` constant when constructing the persisted observation fixture;
  - `interpretation.postgres.test.ts` now reuses the seeded non-null `providerOrderRef` constant when constructing both the attempt and original observation fixture.
- No new no-DB runtime regression was added because the issue was compile-only and fully covered by the safe TypeScript verification surface.

### Compile follow-up checks

- Safe verification command:

```text
./node_modules/.bin/tsc --noEmit --pretty false
```

- Additional hygiene command:

```text
git diff --check
```

- `npm run build` was intentionally not used because it would regenerate `dist/`.
