import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = process.cwd();
const acceptanceSource = readFileSync(
  join(repoRoot, 'src/modules/paymentOrchestration/__tests__/pgo1.acceptance.postgres.test.ts'),
  'utf8',
);
const reductionPersistenceSource = readFileSync(
  join(repoRoot, 'src/modules/paymentOrchestration/reductionPersistence.ts'),
  'utf8',
);
const docsSource = readFileSync(
  join(repoRoot, 'docs/pgo-1-shadow-verification.md'),
  'utf8',
);
const globalTableCleanupName = 'clear' + 'PaymentTables';
const deleteWithoutFilter = (delegate: string) => new RegExp(`${delegate}\\.deleteMany\\(\\s*\\)`);
const localQueueArray = new RegExp('const queue' + 'Consumption = outbox\\.map');
const inertSpyInterface = new RegExp('interface Mutation' + 'Spies');
const directSlaPersistence = new RegExp('const escalation = await persist' + 'SlaEscalation');
const directAttemptInsert = new RegExp('prisma\\.paymentAttempt\\.cre' + 'ate\\(');
const directAttemptUpdate = new RegExp('prisma\\.paymentAttempt\\.up' + 'date\\(');
const directReadOnlyConsumptionPersistence = new RegExp('await persistRead' + 'OnlyQueryConsumption\\(');
const directReadOnlyRequestClaim = new RegExp('const claimedRead' + 'OnlyRequest = await claimRead' + 'OnlyQueryRequest');
const directReconcileAttemptCall = new RegExp('await pgo1\\.reconcile' + 'Attempt');

describe('PGO-1 acceptance source contract', () => {
  it('fails dirty acceptance namespaces instead of globally deleting PGO-1 rows', () => {
    assert.match(acceptanceSource, /createPaymentPostgresNamespace\('acceptance'\)/);
    assert.match(acceptanceSource, /await namespace\.assertEmpty\(prisma\)/);
    assert.match(acceptanceSource, /await namespace\.cleanup\(prisma\)/);
    assert.doesNotMatch(acceptanceSource, new RegExp(`function ${globalTableCleanupName}`));
    assert.doesNotMatch(acceptanceSource, deleteWithoutFilter('paymentObligation'));
    assert.doesNotMatch(acceptanceSource, deleteWithoutFilter('paymentAttempt'));
    assert.doesNotMatch(acceptanceSource, deleteWithoutFilter('providerObservation'));
  });

  it('uses the persisted refund-due fact with the deterministic queue stub', () => {
    assert.match(acceptanceSource, /DeterministicRefundQueueStub/);
    assert.match(acceptanceSource, /toRefundDueDetectedV1/);
    assert.match(acceptanceSource, /refundQueue\.consume\(refundDueEvent\)/);
    assert.match(acceptanceSource, /owner:\s*'PAYMENTS_OPERATIONS'/);
    assert.match(acceptanceSource, /status:\s*'ACKNOWLEDGED'/);
    assert.doesNotMatch(acceptanceSource, localQueueArray);
  });

  it('exercises a production mutation-boundary seam and keeps money-moving recorders at zero', () => {
    assert.match(reductionPersistenceSource, /assertNoMutationAuthority/);
    assert.match(acceptanceSource, /createRecordingMutationBoundary/);
    assert.match(acceptanceSource, /mutationBoundary: mutationRecorder\.boundary/);
    assert.match(acceptanceSource, /assertZeroMutations\(mutationRecorder\)/);
    assert.doesNotMatch(acceptanceSource, inertSpyInterface);
  });

  it('uses worker read-only consumption and attempt-creation seams rather than direct persistence shortcuts', () => {
    assert.match(acceptanceSource, /const readOnlyWorker = reconciliationWorker/);
    assert.match(acceptanceSource, /const readOnlyWorkerResults = await readOnlyWorker\.runOnce\(\)/);
    assert.match(acceptanceSource, /const consumedReadOnlyRequest = await prisma\.reconciliationReviewHistory\.findFirstOrThrow/);
    assert.match(acceptanceSource, /result:\s*'OBSERVATION_INGESTED'/);
    assert.match(acceptanceSource, /request_acceptance_winner/);
    assert.match(acceptanceSource, /request_acceptance_after_satisfied/);
    assert.doesNotMatch(acceptanceSource, directSlaPersistence);
    assert.doesNotMatch(acceptanceSource, directAttemptInsert);
    assert.doesNotMatch(acceptanceSource, directAttemptUpdate);
    assert.doesNotMatch(acceptanceSource, directReadOnlyConsumptionPersistence);
    assert.doesNotMatch(acceptanceSource, directReadOnlyRequestClaim);
    assert.doesNotMatch(acceptanceSource, directReconcileAttemptCall);
  });

  it('documents separate guarded migration scratch creation and disposal', () => {
    assert.match(docsSource, /PGO1_MIGRATION_SCRATCH_DB_NAME=shipmastr_scratch_pgo1_a965f431_migration/);
    assert.match(docsSource, /npm run db:scratch:create/);
    assert.match(docsSource, /npx prisma migrate deploy/);
    assert.match(docsSource, /npm run db:scratch:drop -- "\$PGO1_MIGRATION_SCRATCH_DB_NAME"/);
    assert.match(docsSource, /must not equal the acceptance test database/);
  });
});
