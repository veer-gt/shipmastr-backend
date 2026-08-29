import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { expectedScratchDatabaseNameFromEnv } from './scratchDatabaseGuard.js';
import { createPaymentPostgresNamespace } from './postgresTestNamespace.js';
import type {
  CanonicalObservation,
  OutcomeStatus,
  ReviewStatus,
} from '../types.js';
import type {
  SlaEscalationRequest,
  SlaEscalationResult,
} from '../reconciliationWorker.js';

const enabled = process.env.RUN_PGO1_POSTGRES_TESTS === '1';
const prisma = new PrismaClient();
const namespace = createPaymentPostgresNamespace('observation_service');
const namespaceRows = { merchantId: { startsWith: namespace.prefix } };

let sequence = 0;

type IngestObservation = (
  client: PrismaClient,
  candidate: ObservationCandidate,
) => Promise<IngestionResult>;

type ObservationCandidate = CanonicalObservation;

interface IngestionResult {
  observationId: string;
  disposition: string;
  outcomeStatus: OutcomeStatus;
  reviewStatus: ReviewStatus;
  resolvedAt: Date | null;
}

function nextId(prefix: string) {
  sequence += 1;
  return namespace.id(`${prefix}_${sequence}`);
}

function assertScratchUrl() {
  const raw = process.env.DATABASE_URL ?? '';
  const url = new URL(raw);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase()));
  assert.equal(url.port, '5433');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), expectedScratchDatabaseNameFromEnv());
  return url;
}

function obligation(
  overrides: Partial<Prisma.PaymentObligationUncheckedCreateInput> = {},
): Prisma.PaymentObligationUncheckedCreateInput {
  const merchantId = overrides.merchantId ?? nextId('merchant');

  return {
    id: overrides.id ?? nextId('obligation'),
    merchantId,
    checkoutId: overrides.checkoutId ?? nextId('checkout'),
    collectionRail: overrides.collectionRail ?? 'ONLINE',
    purpose: overrides.purpose ?? 'FULL_ONLINE',
    amountPaise: overrides.amountPaise ?? 10_000n,
    currency: overrides.currency ?? 'INR',
    status: overrides.status ?? 'OPEN',
    satisfiedAt: overrides.satisfiedAt ?? null,
  };
}

function attempt(
  overrides: Partial<Prisma.PaymentAttemptUncheckedCreateInput> = {},
): Prisma.PaymentAttemptUncheckedCreateInput {
  const merchantId = overrides.merchantId ?? nextId('merchant');
  const obligationId = overrides.obligationId ?? nextId('obligation_ref');

  return {
    id: overrides.id ?? nextId('attempt'),
    obligationId,
    merchantId,
    obligationCollectionRail: overrides.obligationCollectionRail ?? 'ONLINE',
    provider: overrides.provider ?? 'MOCK',
    environment: overrides.environment ?? 'TEST',
    credentialBindingId: overrides.credentialBindingId ?? nextId('binding'),
    credentialVersionId: overrides.credentialVersionId ?? nextId('credential_version'),
    requestIdempotencyKey: overrides.requestIdempotencyKey ?? nextId('request'),
    providerOrderRef: overrides.providerOrderRef ?? nextId('provider_order'),
    outcomeStatus: overrides.outcomeStatus ?? 'PENDING',
    reviewStatus: overrides.reviewStatus ?? 'NOT_REQUIRED',
    resolvedAt: overrides.resolvedAt ?? null,
    lastOutcomeChangedAt: overrides.lastOutcomeChangedAt ?? new Date('2026-08-27T12:00:00.000Z'),
    lastObservationAt: overrides.lastObservationAt ?? null,
    adapterVersion: overrides.adapterVersion ?? 'test-adapter-v1',
    mappingVersion: overrides.mappingVersion ?? 'test-mapping-v1',
  };
}

function candidate(
  input: {
    attemptId: string;
    obligationId: string;
    merchantId: string;
    credentialBindingId: string;
    credentialVersionId: string;
    providerOrderRef: string;
    provider?: 'MOCK';
    environment?: 'TEST';
    providerEventId?: string | null;
    providerTransactionRef?: string | null;
    mappedOutcome?: CanonicalObservation['mappedOutcome'];
    nativeStatus?: string;
    nativeReasonCode?: string | null;
    amountPaise?: bigint | null;
    rawBodyHash?: string;
    signatureVerification?: CanonicalObservation['signatureVerification'];
    bindingVerification?: CanonicalObservation['bindingVerification'];
    evidenceAuthority?: CanonicalObservation['evidenceAuthority'];
    receivedAt?: Date;
    providerOccurredAt?: Date | null;
  },
  overrides: Partial<CanonicalObservation> = {},
): CanonicalObservation {
  return {
    id: overrides.id ?? nextId('observation'),
    attemptId: input.attemptId,
    obligationId: input.obligationId,
    merchantId: input.merchantId,
    provider: input.provider ?? 'MOCK',
    environment: input.environment ?? 'TEST',
    credentialBindingId: input.credentialBindingId,
    credentialVersionId: input.credentialVersionId,
    source: 'MOCK',
    providerEventId: input.providerEventId ?? nextId('event'),
    providerOrderRef: input.providerOrderRef,
    providerTransactionRef: input.providerTransactionRef ?? nextId('txn'),
    nativeStatus: input.nativeStatus ?? 'captured',
    nativeReasonCode: input.nativeReasonCode ?? null,
    amountPaise: input.amountPaise ?? 10_000n,
    nativeAmountText: '100.00',
    nativeCurrency: 'INR',
    rawBodyHash: input.rawBodyHash ?? nextId('hash'),
    hashAlgorithm: 'SHA-256',
    signatureVerification: input.signatureVerification ?? 'NOT_APPLICABLE',
    bindingVerification: input.bindingVerification ?? 'VERIFIED',
    evidenceAuthority: input.evidenceAuthority ?? 'ELIGIBLE',
    mappedOutcome: input.mappedOutcome ?? 'SUCCEEDED',
    adapterVersion: 'test-adapter-v1',
    mappingVersion: 'test-mapping-v1',
    providerApiVersion: 'mock-2026-08-27',
    providerOccurredAt: input.providerOccurredAt ?? new Date('2026-08-27T12:00:00.000Z'),
    receivedAt: input.receivedAt ?? new Date('2026-08-27T12:00:01.000Z'),
    reductionDisposition: 'ACCEPTED',
    ...overrides,
  };
}

type PersistSlaEscalation = (
  client: PrismaClient,
  input: SlaEscalationRequest,
) => Promise<SlaEscalationResult>;

async function loadObservationService(): Promise<{
  ingestObservation: IngestObservation;
  persistSlaEscalation: PersistSlaEscalation;
}> {
  const modulePath = '../observationService.js';
  return import(modulePath) as Promise<{
    ingestObservation: IngestObservation;
    persistSlaEscalation: PersistSlaEscalation;
  }>;
}

async function createAttemptWithObligation(
  overrides: {
    obligation?: Partial<Prisma.PaymentObligationUncheckedCreateInput>;
    attempt?: Partial<Prisma.PaymentAttemptUncheckedCreateInput>;
  } = {},
) {
  const obligationRow = await prisma.paymentObligation.create({
    data: obligation(overrides.obligation),
  });
  const attemptRow = await prisma.paymentAttempt.create({
    data: attempt({
      merchantId: obligationRow.merchantId,
      obligationId: obligationRow.id,
      obligationCollectionRail: obligationRow.collectionRail,
      ...overrides.attempt,
    }),
  });

  return { obligation: obligationRow, attempt: attemptRow };
}

async function counts() {
  return {
    observations: await prisma.providerObservation.count({ where: namespaceRows }),
    deliveries: await prisma.providerObservationDelivery.count({ where: namespaceRows }),
    transitions: await prisma.paymentOutcomeTransition.count({ where: namespaceRows }),
    reviews: await prisma.reconciliationReviewHistory.count({ where: namespaceRows }),
    attention: await prisma.paymentAttentionSignal.count({ where: namespaceRows }),
    facts: await prisma.paymentNormalizedFactOutbox.count({ where: namespaceRows }),
    cases: await prisma.refundDueCase.count({ where: namespaceRows }),
  };
}

async function currentOutcome(attemptId: string) {
  const row = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  return row.outcomeStatus;
}

async function loadAttempt(attemptId: string) {
  return prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
}

if (enabled) {
  describe('ingestObservation PostgreSQL persistence', () => {
    before(async () => {
      const url = assertScratchUrl();
      const current = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
      assert.equal(current[0]?.name, decodeURIComponent(url.pathname.slice(1)));
    });

    beforeEach(async () => {
      await namespace.assertEmpty(prisma);
    });

    afterEach(async () => {
      await namespace.cleanup(prisma);
    });

    after(async () => {
      await prisma.$disconnect();
    });

    it('serializes contradictory observations from simultaneous transactions', async () => {
      const { ingestObservation } = await loadObservationService();
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: 'obligation_serialized',
          merchantId: namespace.id('merchant_serialized'),
          amountPaise: 12_500n,
        },
        attempt: {
          id: 'attempt_serialized',
          providerOrderRef: 'order_serialized',
        },
      });

      const successCandidate = candidate({
        attemptId: seeded.attempt.id,
        obligationId: seeded.obligation.id,
        merchantId: seeded.obligation.merchantId,
        credentialBindingId: seeded.attempt.credentialBindingId,
        credentialVersionId: seeded.attempt.credentialVersionId,
        providerOrderRef: seeded.attempt.providerOrderRef!,
        providerEventId: 'event_serialized_success',
        providerTransactionRef: 'txn_serialized_success',
        mappedOutcome: 'SUCCEEDED',
        amountPaise: seeded.obligation.amountPaise,
      });
      const failureCandidate = candidate({
        attemptId: seeded.attempt.id,
        obligationId: seeded.obligation.id,
        merchantId: seeded.obligation.merchantId,
        credentialBindingId: seeded.attempt.credentialBindingId,
        credentialVersionId: seeded.attempt.credentialVersionId,
        providerOrderRef: seeded.attempt.providerOrderRef!,
        providerEventId: 'event_serialized_failure',
        providerTransactionRef: null,
        mappedOutcome: 'FAILED_TERMINAL',
        nativeStatus: 'failed',
        amountPaise: seeded.obligation.amountPaise,
      });

      await Promise.all([
        ingestObservation(prisma, successCandidate),
        ingestObservation(prisma, failureCandidate),
      ]);

      assert.equal(await currentOutcome(seeded.attempt.id), 'SUCCEEDED');
      assert.equal(await prisma.providerObservation.count({ where: namespaceRows }), 2);
      assert.equal(await prisma.providerObservationDelivery.count({ where: namespaceRows }), 2);
    });

    it('locks a newer unresolved attempt when late success resolves an older failure', async () => {
      const { ingestObservation } = await loadObservationService();
      const obligationRow = await prisma.paymentObligation.create({
        data: obligation({
          id: 'obligation_late_success',
          merchantId: namespace.id('merchant_late_success'),
          amountPaise: 20_000n,
        }),
      });
      const oldAttempt = await prisma.paymentAttempt.create({
        data: attempt({
          id: 'attempt_old',
          merchantId: obligationRow.merchantId,
          obligationId: obligationRow.id,
          obligationCollectionRail: obligationRow.collectionRail,
          providerOrderRef: 'order_old',
          outcomeStatus: 'FAILED_TERMINAL',
          reviewStatus: 'COMPLETED',
          resolvedAt: new Date('2026-08-27T10:00:00.000Z'),
          createdAt: new Date('2026-08-27T09:00:00.000Z'),
        }),
      });
      const newAttempt = await prisma.paymentAttempt.create({
        data: attempt({
          id: 'attempt_new',
          merchantId: obligationRow.merchantId,
          obligationId: obligationRow.id,
          obligationCollectionRail: obligationRow.collectionRail,
          providerOrderRef: 'order_new',
          outcomeStatus: 'PENDING',
          reviewStatus: 'NOT_REQUIRED',
          resolvedAt: null,
          createdAt: new Date('2026-08-27T11:00:00.000Z'),
        }),
      });

      await ingestObservation(
        prisma,
        candidate({
          attemptId: oldAttempt.id,
          obligationId: obligationRow.id,
          merchantId: obligationRow.merchantId,
          credentialBindingId: oldAttempt.credentialBindingId,
          credentialVersionId: oldAttempt.credentialVersionId,
          providerOrderRef: oldAttempt.providerOrderRef!,
          providerEventId: 'event_late_success',
          providerTransactionRef: 'txn_late_success',
          mappedOutcome: 'SUCCEEDED',
          amountPaise: obligationRow.amountPaise,
        }),
      );

      assert.partialDeepStrictEqual(await loadAttempt(oldAttempt.id), { outcomeStatus: 'SUCCEEDED' });
      assert.partialDeepStrictEqual(await loadAttempt(newAttempt.id), { resolvedAt: null });
      assert.partialDeepStrictEqual(
        await prisma.paymentObligation.findUniqueOrThrow({ where: { id: obligationRow.id } }),
        { status: 'SATISFIED' },
      );
      assert.equal(
        await prisma.paymentAttempt.count({
          where: { obligationId: obligationRow.id, resolvedAt: null },
        }),
        1,
      );
    });

    it('stores a duplicate delivery without a second normalized observation or second fact', async () => {
      const { ingestObservation } = await loadObservationService();
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: 'obligation_duplicate',
          merchantId: namespace.id('merchant_duplicate'),
        },
        attempt: {
          id: 'attempt_duplicate',
          providerOrderRef: 'order_duplicate',
        },
      });

      const first = candidate({
        attemptId: seeded.attempt.id,
        obligationId: seeded.obligation.id,
        merchantId: seeded.obligation.merchantId,
        credentialBindingId: seeded.attempt.credentialBindingId,
        credentialVersionId: seeded.attempt.credentialVersionId,
        providerOrderRef: seeded.attempt.providerOrderRef!,
        providerEventId: 'event_duplicate',
        providerTransactionRef: 'txn_duplicate',
        rawBodyHash: 'hash_duplicate',
      });
      const second = candidate(
        {
          attemptId: seeded.attempt.id,
          obligationId: seeded.obligation.id,
          merchantId: seeded.obligation.merchantId,
          credentialBindingId: seeded.attempt.credentialBindingId,
          credentialVersionId: seeded.attempt.credentialVersionId,
          providerOrderRef: seeded.attempt.providerOrderRef!,
          providerEventId: 'event_duplicate',
          providerTransactionRef: 'txn_duplicate',
          rawBodyHash: 'hash_duplicate',
          receivedAt: new Date('2026-08-27T12:00:09.000Z'),
        },
        { id: 'observation_duplicate_second' },
      );

      const firstResult = await ingestObservation(prisma, first);
      const secondResult = await ingestObservation(prisma, second);

      assert.equal(secondResult.observationId, firstResult.observationId);
      assert.equal(await prisma.providerObservation.count({ where: namespaceRows }), 1);
      assert.equal(await prisma.providerObservationDelivery.count({ where: namespaceRows }), 2);
      assert.equal(await prisma.paymentNormalizedFactOutbox.count({ where: namespaceRows }), 1);
    });

    it('persists the reducer disposition instead of the candidate placeholder for unresolved evidence', async () => {
      const { ingestObservation } = await loadObservationService();
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: 'obligation_pending_disposition',
          merchantId: namespace.id('merchant_pending_disposition'),
        },
        attempt: {
          id: 'attempt_pending_disposition',
          providerOrderRef: 'order_pending_disposition',
        },
      });

      const result = await ingestObservation(
        prisma,
        candidate({
          attemptId: seeded.attempt.id,
          obligationId: seeded.obligation.id,
          merchantId: seeded.obligation.merchantId,
          credentialBindingId: seeded.attempt.credentialBindingId,
          credentialVersionId: seeded.attempt.credentialVersionId,
          providerOrderRef: seeded.attempt.providerOrderRef!,
          providerEventId: 'event_pending_disposition',
          providerTransactionRef: null,
          mappedOutcome: 'PENDING',
          nativeStatus: 'pending',
          rawBodyHash: 'hash_pending_disposition',
        }),
      );

      assert.equal(result.disposition, 'PENDING');
      assert.equal(
        (
          await prisma.providerObservation.findUniqueOrThrow({
            where: { id: result.observationId },
            select: { reductionDisposition: true },
          })
        ).reductionDisposition,
        'PENDING',
      );
    });

    it('reuses the matching conflicting observation when the same event id and hash replay after A,B', async () => {
      const { ingestObservation } = await loadObservationService();
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: 'obligation_conflict_replay',
          merchantId: namespace.id('merchant_conflict_replay'),
        },
        attempt: {
          id: 'attempt_conflict_replay',
          providerOrderRef: 'order_conflict_replay',
        },
      });

      const hashA = candidate({
        attemptId: seeded.attempt.id,
        obligationId: seeded.obligation.id,
        merchantId: seeded.obligation.merchantId,
        credentialBindingId: seeded.attempt.credentialBindingId,
        credentialVersionId: seeded.attempt.credentialVersionId,
        providerOrderRef: seeded.attempt.providerOrderRef!,
        providerEventId: 'event_conflict_replay',
        providerTransactionRef: null,
        mappedOutcome: 'PENDING',
        rawBodyHash: 'hash_conflict_replay_a',
        nativeStatus: 'pending',
      });
      const hashB = candidate({
        attemptId: seeded.attempt.id,
        obligationId: seeded.obligation.id,
        merchantId: seeded.obligation.merchantId,
        credentialBindingId: seeded.attempt.credentialBindingId,
        credentialVersionId: seeded.attempt.credentialVersionId,
        providerOrderRef: seeded.attempt.providerOrderRef!,
        providerEventId: 'event_conflict_replay',
        providerTransactionRef: null,
        mappedOutcome: 'PENDING',
        rawBodyHash: 'hash_conflict_replay_b',
        nativeStatus: 'pending',
        receivedAt: new Date('2026-08-27T12:00:02.000Z'),
      });
      const hashBReplay = {
        ...hashB,
        id: 'observation_conflict_replay_b_second_delivery',
        receivedAt: new Date('2026-08-27T12:00:03.000Z'),
      };

      const firstResult = await ingestObservation(prisma, hashA);
      const secondResult = await ingestObservation(prisma, hashB);
      const replayResult = await ingestObservation(prisma, hashBReplay);

      assert.notEqual(secondResult.observationId, firstResult.observationId);
      assert.equal(replayResult.observationId, secondResult.observationId);
      assert.equal(replayResult.disposition, 'INTEGRITY_CONFLICT');
      assert.equal(await prisma.providerObservation.count({ where: namespaceRows }), 2);
      assert.equal(await prisma.providerObservationDelivery.count({ where: namespaceRows }), 3);

      const observations = await prisma.providerObservation.findMany({
        where: { obligationId: seeded.obligation.id },
        orderBy: [{ rawBodyHash: 'asc' }, { id: 'asc' }],
        select: { id: true, rawBodyHash: true, reductionDisposition: true },
      });
      assert.deepEqual(observations, [
        {
          id: firstResult.observationId,
          rawBodyHash: 'hash_conflict_replay_a',
          reductionDisposition: 'PENDING',
        },
        {
          id: secondResult.observationId,
          rawBodyHash: 'hash_conflict_replay_b',
          reductionDisposition: 'INTEGRITY_CONFLICT',
        },
      ]);
      assert.equal(await prisma.paymentAttentionSignal.count({ where: namespaceRows }), 1);
      assert.equal(await prisma.paymentNormalizedFactOutbox.count({ where: namespaceRows }), 0);
    });

    it('preserves unresolved state for an integrity conflict on an unresolved attempt', async () => {
      const { ingestObservation } = await loadObservationService();
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: 'obligation_unresolved_conflict',
          merchantId: namespace.id('merchant_unresolved_conflict'),
        },
        attempt: {
          id: 'attempt_unresolved_conflict',
          providerOrderRef: 'order_unresolved_conflict',
        },
      });

      await ingestObservation(
        prisma,
        candidate({
          attemptId: seeded.attempt.id,
          obligationId: seeded.obligation.id,
          merchantId: seeded.obligation.merchantId,
          credentialBindingId: seeded.attempt.credentialBindingId,
          credentialVersionId: seeded.attempt.credentialVersionId,
          providerOrderRef: seeded.attempt.providerOrderRef!,
          providerEventId: 'event_conflict_unresolved',
          providerTransactionRef: null,
          mappedOutcome: 'PENDING',
          rawBodyHash: 'hash_conflict_a',
          nativeStatus: 'pending',
        }),
      );

      const result = await ingestObservation(
        prisma,
        candidate({
          attemptId: seeded.attempt.id,
          obligationId: seeded.obligation.id,
          merchantId: seeded.obligation.merchantId,
          credentialBindingId: seeded.attempt.credentialBindingId,
          credentialVersionId: seeded.attempt.credentialVersionId,
          providerOrderRef: seeded.attempt.providerOrderRef!,
          providerEventId: 'event_conflict_unresolved',
          providerTransactionRef: null,
          mappedOutcome: 'PENDING',
          rawBodyHash: 'hash_conflict_b',
          nativeStatus: 'pending',
        }),
      );

      assert.equal(result.disposition, 'INTEGRITY_CONFLICT');
      assert.equal(result.outcomeStatus, 'PENDING');
      assert.equal(result.reviewStatus, 'REQUIRED');
      assert.equal((await loadAttempt(seeded.attempt.id)).resolvedAt, null);
      assert.equal(await prisma.providerObservation.count({ where: namespaceRows }), 2);
      assert.equal(await prisma.paymentNormalizedFactOutbox.count({ where: namespaceRows }), 0);
      assert.equal(await prisma.paymentAttentionSignal.count({ where: namespaceRows }), 1);
    });

    it('preserves the resolved outcome and adds attention when an integrity conflict arrives after success', async () => {
      const { ingestObservation } = await loadObservationService();
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: 'obligation_resolved_conflict',
          merchantId: namespace.id('merchant_resolved_conflict'),
        },
        attempt: {
          id: 'attempt_resolved_conflict',
          providerOrderRef: 'order_resolved_conflict',
          reviewStatus: 'IN_PROGRESS',
        },
      });

      await ingestObservation(
        prisma,
        candidate({
          attemptId: seeded.attempt.id,
          obligationId: seeded.obligation.id,
          merchantId: seeded.obligation.merchantId,
          credentialBindingId: seeded.attempt.credentialBindingId,
          credentialVersionId: seeded.attempt.credentialVersionId,
          providerOrderRef: seeded.attempt.providerOrderRef!,
          providerEventId: 'event_conflict_resolved',
          providerTransactionRef: 'txn_conflict_resolved',
          rawBodyHash: 'hash_conflict_initial',
        }),
      );

      const result = await ingestObservation(
        prisma,
        candidate({
          attemptId: seeded.attempt.id,
          obligationId: seeded.obligation.id,
          merchantId: seeded.obligation.merchantId,
          credentialBindingId: seeded.attempt.credentialBindingId,
          credentialVersionId: seeded.attempt.credentialVersionId,
          providerOrderRef: seeded.attempt.providerOrderRef!,
          providerEventId: 'event_conflict_resolved',
          providerTransactionRef: 'txn_conflict_resolved',
          rawBodyHash: 'hash_conflict_followup',
        }),
      );

      const resolvedAttempt = await loadAttempt(seeded.attempt.id);
      assert.equal(result.disposition, 'INTEGRITY_CONFLICT_POST_RESOLUTION');
      assert.equal(result.outcomeStatus, 'SUCCEEDED');
      assert.equal(result.reviewStatus, 'COMPLETED');
      assert.equal(resolvedAttempt.outcomeStatus, 'SUCCEEDED');
      assert.notEqual(resolvedAttempt.resolvedAt, null);
      assert.deepEqual(result.resolvedAt, resolvedAttempt.resolvedAt);
      assert.equal(await prisma.paymentOutcomeTransition.count({ where: namespaceRows }), 1);
      assert.equal(await prisma.paymentNormalizedFactOutbox.count({ where: namespaceRows }), 1);
      assert.equal(await prisma.paymentAttentionSignal.count({ where: namespaceRows }), 1);
    });

    it('persists SLA escalation through the serialized Task 5 boundary with history', async () => {
      const { persistSlaEscalation } = await loadObservationService();
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: 'obligation_sla_escalation',
          merchantId: namespace.id('merchant_sla_escalation'),
        },
        attempt: {
          id: 'attempt_sla_escalation',
          providerOrderRef: 'order_sla_escalation',
        },
      });
      const input: SlaEscalationRequest = {
        attemptId: seeded.attempt.id,
        obligationId: seeded.obligation.id,
        merchantId: seeded.obligation.merchantId,
        observedAt: new Date('2026-08-28T00:01:00.000Z'),
        reason: 'SLA_EXCEEDED',
      };

      const first = await persistSlaEscalation(prisma, input);
      const second = await persistSlaEscalation(prisma, input);
      const persisted = await loadAttempt(seeded.attempt.id);

      assert.deepEqual(first, {
        kind: 'ESCALATED',
        outcomeStatus: 'UNKNOWN',
        reviewStatus: 'REQUIRED',
      });
      assert.deepEqual(second, {
        kind: 'ESCALATED',
        outcomeStatus: 'UNKNOWN',
        reviewStatus: 'REQUIRED',
      });
      assert.equal(persisted.outcomeStatus, 'UNKNOWN');
      assert.equal(persisted.reviewStatus, 'REQUIRED');
      assert.equal(persisted.resolvedAt, null);
      assert.deepEqual(
        await prisma.paymentOutcomeTransition.findMany({
          where: { attemptId: seeded.attempt.id },
          select: {
            priorOutcomeStatus: true,
            nextOutcomeStatus: true,
            reasonCode: true,
            triggeringObservationId: true,
          },
        }),
        [{
          priorOutcomeStatus: 'PENDING',
          nextOutcomeStatus: 'UNKNOWN',
          reasonCode: 'SLA_EXCEEDED',
          triggeringObservationId: null,
        }],
      );
      assert.deepEqual(
        await prisma.reconciliationReviewHistory.findMany({
          where: { attemptId: seeded.attempt.id },
          select: {
            priorReviewStatus: true,
            nextReviewStatus: true,
            completedByType: true,
            actorId: true,
            reasonCode: true,
            triggeringObservationId: true,
          },
        }),
        [{
          priorReviewStatus: 'NOT_REQUIRED',
          nextReviewStatus: 'REQUIRED',
          completedByType: null,
          actorId: null,
          reasonCode: 'SLA_EXCEEDED',
          triggeringObservationId: null,
        }],
      );
    });
  });
}
