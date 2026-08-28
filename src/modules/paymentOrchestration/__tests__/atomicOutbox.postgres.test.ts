import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { expectedScratchDatabaseNameFromEnv } from './scratchDatabaseGuard.js';
import type {
  CanonicalObservation,
} from '../types.js';

const enabled = process.env.RUN_PGO1_POSTGRES_TESTS === '1';
const prisma = new PrismaClient();

let sequence = 0;

type IngestObservation = (
  client: PrismaClient,
  candidate: ObservationCandidate,
) => Promise<IngestionResult>;

type FailurePoint = 'BEFORE_OUTBOX_INSERT';

type ObservationCandidate = CanonicalObservation;

interface IngestionResult {
  observationId: string;
  disposition: string;
  outcomeStatus: 'PENDING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED_TERMINAL' | 'NOT_FOUND_TERMINAL';
  reviewStatus: 'NOT_REQUIRED' | 'REQUIRED' | 'IN_PROGRESS' | 'COMPLETED';
  resolvedAt: Date | null;
}

function nextId(prefix: string) {
  sequence += 1;
  return `${prefix}_${sequence}`;
}

function assertScratchUrl() {
  const raw = process.env.DATABASE_URL ?? '';
  const url = new URL(raw);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase()));
  assert.equal(url.port, '5433');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), expectedScratchDatabaseNameFromEnv());
  return url;
}

async function clearPaymentTables(client: PrismaClient) {
  await client.providerObservationInterpretation.deleteMany();
  await client.providerObservationDelivery.deleteMany();
  await client.paymentNormalizedFactOutbox.deleteMany();
  await client.refundDueCase.deleteMany();
  await client.paymentAttentionSignal.deleteMany();
  await client.reconciliationReviewHistory.deleteMany();
  await client.paymentOutcomeTransition.deleteMany();
  await client.providerObservation.deleteMany();
  await client.paymentAttempt.deleteMany();
  await client.paymentObligation.deleteMany();
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
    providerEventId?: string | null;
    providerTransactionRef?: string | null;
    mappedOutcome?: CanonicalObservation['mappedOutcome'];
    rawBodyHash?: string;
    receivedAt?: Date;
  },
): CanonicalObservation {
  return {
    id: nextId('observation'),
    attemptId: input.attemptId,
    obligationId: input.obligationId,
    merchantId: input.merchantId,
    provider: 'MOCK',
    environment: 'TEST',
    credentialBindingId: input.credentialBindingId,
    credentialVersionId: input.credentialVersionId,
    source: 'MOCK',
    providerEventId: input.providerEventId ?? nextId('event'),
    providerOrderRef: input.providerOrderRef,
    providerTransactionRef: input.providerTransactionRef ?? nextId('txn'),
    nativeStatus: 'captured',
    nativeReasonCode: null,
    amountPaise: 10_000n,
    nativeAmountText: '100.00',
    nativeCurrency: 'INR',
    rawBodyHash: input.rawBodyHash ?? nextId('hash'),
    hashAlgorithm: 'SHA-256',
    signatureVerification: 'NOT_APPLICABLE',
    bindingVerification: 'VERIFIED',
    evidenceAuthority: 'ELIGIBLE',
    mappedOutcome: input.mappedOutcome ?? 'SUCCEEDED',
    adapterVersion: 'test-adapter-v1',
    mappingVersion: 'test-mapping-v1',
    providerApiVersion: 'mock-2026-08-27',
    providerOccurredAt: new Date('2026-08-27T12:00:00.000Z'),
    receivedAt: input.receivedAt ?? new Date('2026-08-27T12:00:01.000Z'),
    reductionDisposition: 'ACCEPTED',
  };
}

async function loadObservationService(): Promise<{ ingestObservation: IngestObservation }> {
  const modulePath = '../observationService.js';
  return import(modulePath) as Promise<{ ingestObservation: IngestObservation }>;
}

async function loadReductionPersistence(): Promise<{
  __setFailureInjectionForTests: (point: FailurePoint | null) => void;
}> {
  const modulePath = '../reductionPersistence.js';
  return import(modulePath) as Promise<{
    __setFailureInjectionForTests: (point: FailurePoint | null) => void;
  }>;
}

async function seedExpiredAttempt() {
  const obligationRow = await prisma.paymentObligation.create({
    data: obligation({
      id: 'obligation_expired',
      merchantId: 'merchant_expired',
      status: 'EXPIRED',
    }),
  });
  const attemptRow = await prisma.paymentAttempt.create({
    data: attempt({
      id: 'attempt_expired',
      merchantId: obligationRow.merchantId,
      obligationId: obligationRow.id,
      obligationCollectionRail: obligationRow.collectionRail,
      providerOrderRef: 'order_expired',
      reviewStatus: 'IN_PROGRESS',
    }),
  });

  return { obligation: obligationRow, attempt: attemptRow };
}

async function counts() {
  return {
    observations: await prisma.providerObservation.count(),
    deliveries: await prisma.providerObservationDelivery.count(),
    transitions: await prisma.paymentOutcomeTransition.count(),
    reviews: await prisma.reconciliationReviewHistory.count(),
    attention: await prisma.paymentAttentionSignal.count(),
    facts: await prisma.paymentNormalizedFactOutbox.count(),
    cases: await prisma.refundDueCase.count(),
  };
}

if (enabled) {
  describe('ingestObservation atomic outbox persistence', () => {
    before(async () => {
      const url = assertScratchUrl();
      const current = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
      assert.equal(current[0]?.name, decodeURIComponent(url.pathname.slice(1)));
    });

    beforeEach(async () => {
      await clearPaymentTables(prisma);
      try {
        const { __setFailureInjectionForTests } = await loadReductionPersistence();
        __setFailureInjectionForTests(null);
      } catch {
        // RED phase: module may not exist yet.
      }
    });

    after(async () => {
      await prisma.$disconnect();
    });

    it('commits observation, projections, history, case, and fact atomically', async () => {
      const { ingestObservation } = await loadObservationService();
      const seeded = await seedExpiredAttempt();

      const result = await ingestObservation(
        prisma,
        candidate({
          attemptId: seeded.attempt.id,
          obligationId: seeded.obligation.id,
          merchantId: seeded.obligation.merchantId,
          credentialBindingId: seeded.attempt.credentialBindingId,
          credentialVersionId: seeded.attempt.credentialVersionId,
          providerOrderRef: seeded.attempt.providerOrderRef!,
          providerEventId: 'event_atomic_success',
          providerTransactionRef: 'txn_atomic_success',
        }),
      );

      assert.equal(result.outcomeStatus, 'SUCCEEDED');
      assert.equal(result.reviewStatus, 'COMPLETED');
      assert.equal(await prisma.providerObservation.count(), 1);
      assert.equal(await prisma.providerObservationDelivery.count(), 1);
      assert.equal(await prisma.paymentOutcomeTransition.count(), 1);
      assert.equal(await prisma.reconciliationReviewHistory.count(), 1);
      assert.equal(await prisma.refundDueCase.count(), 1);
      assert.equal(await prisma.paymentNormalizedFactOutbox.count(), 2);
    });

    it('rolls back every write when outbox persistence fails', async () => {
      const { ingestObservation } = await loadObservationService();
      const { __setFailureInjectionForTests } = await loadReductionPersistence();
      const seeded = await seedExpiredAttempt();

      __setFailureInjectionForTests('BEFORE_OUTBOX_INSERT');

      await assert.rejects(
        ingestObservation(
          prisma,
          candidate({
            attemptId: seeded.attempt.id,
            obligationId: seeded.obligation.id,
            merchantId: seeded.obligation.merchantId,
            credentialBindingId: seeded.attempt.credentialBindingId,
            credentialVersionId: seeded.attempt.credentialVersionId,
            providerOrderRef: seeded.attempt.providerOrderRef!,
            providerEventId: 'event_atomic_failure',
            providerTransactionRef: 'txn_atomic_failure',
          }),
        ),
        /INJECTED_FAILURE/,
      );

      assert.deepEqual(await counts(), {
        observations: 0,
        deliveries: 0,
        transitions: 0,
        reviews: 0,
        attention: 0,
        facts: 0,
        cases: 0,
      });
    });

    it('dedupes a refund-due case and outbox facts across duplicate deliveries', async () => {
      const { ingestObservation } = await loadObservationService();
      const seeded = await seedExpiredAttempt();

      const first = candidate({
        attemptId: seeded.attempt.id,
        obligationId: seeded.obligation.id,
        merchantId: seeded.obligation.merchantId,
        credentialBindingId: seeded.attempt.credentialBindingId,
        credentialVersionId: seeded.attempt.credentialVersionId,
        providerOrderRef: seeded.attempt.providerOrderRef!,
        providerEventId: 'event_refund_duplicate',
        providerTransactionRef: 'txn_refund_duplicate',
        rawBodyHash: 'hash_refund_duplicate',
      });

      const second = {
        ...first,
        id: 'observation_refund_duplicate_second',
        receivedAt: new Date('2026-08-27T12:00:09.000Z'),
      };

      await ingestObservation(prisma, first);
      await ingestObservation(prisma, second);

      assert.equal(await prisma.providerObservation.count(), 1);
      assert.equal(await prisma.providerObservationDelivery.count(), 2);
      assert.equal(await prisma.refundDueCase.count(), 1);
      assert.equal(await prisma.paymentNormalizedFactOutbox.count(), 2);
    });

    it('attributes surplus refund persistence to the sourced attempt and keeps it exactly once across later target successes', async () => {
      const { ingestObservation } = await loadObservationService();
      const obligationRow = await prisma.paymentObligation.create({
        data: obligation({
          id: 'obligation_refund_source',
          merchantId: 'merchant_refund_source',
          status: 'SATISFIED',
          satisfiedAt: new Date('2026-08-27T11:00:00.000Z'),
        }),
      });
      const priorAttempt = await prisma.paymentAttempt.create({
        data: attempt({
          id: 'attempt_refund_source_prior',
          merchantId: obligationRow.merchantId,
          obligationId: obligationRow.id,
          obligationCollectionRail: obligationRow.collectionRail,
          providerOrderRef: 'order_refund_source_prior',
          outcomeStatus: 'SUCCEEDED',
          reviewStatus: 'COMPLETED',
          resolvedAt: new Date('2026-08-27T11:00:00.000Z'),
          createdAt: new Date('2026-08-27T10:00:00.000Z'),
        }),
      });
      const targetAttempt = await prisma.paymentAttempt.create({
        data: attempt({
          id: 'attempt_refund_source_target',
          merchantId: obligationRow.merchantId,
          obligationId: obligationRow.id,
          obligationCollectionRail: obligationRow.collectionRail,
          providerOrderRef: 'order_refund_source_target',
          outcomeStatus: 'SUCCEEDED',
          reviewStatus: 'NOT_REQUIRED',
          resolvedAt: new Date('2026-08-27T12:00:00.000Z'),
          createdAt: new Date('2026-08-27T12:00:00.000Z'),
        }),
      });

      const priorSuccess = candidate({
        attemptId: priorAttempt.id,
        obligationId: obligationRow.id,
        merchantId: obligationRow.merchantId,
        credentialBindingId: priorAttempt.credentialBindingId,
        credentialVersionId: priorAttempt.credentialVersionId,
        providerOrderRef: priorAttempt.providerOrderRef!,
        providerEventId: 'event_refund_source_prior',
        providerTransactionRef: 'txn_refund_source_prior',
        rawBodyHash: 'hash_refund_source_prior',
        receivedAt: new Date('2026-08-27T10:30:00.000Z'),
      });
      const targetSuccessA = candidate({
        attemptId: targetAttempt.id,
        obligationId: obligationRow.id,
        merchantId: obligationRow.merchantId,
        credentialBindingId: targetAttempt.credentialBindingId,
        credentialVersionId: targetAttempt.credentialVersionId,
        providerOrderRef: targetAttempt.providerOrderRef!,
        providerEventId: 'event_refund_source_target_a',
        providerTransactionRef: 'txn_refund_source_target',
        rawBodyHash: 'hash_refund_source_target_a',
        receivedAt: new Date('2026-08-27T12:30:00.000Z'),
      });
      const targetSuccessB = candidate({
        attemptId: targetAttempt.id,
        obligationId: obligationRow.id,
        merchantId: obligationRow.merchantId,
        credentialBindingId: targetAttempt.credentialBindingId,
        credentialVersionId: targetAttempt.credentialVersionId,
        providerOrderRef: targetAttempt.providerOrderRef!,
        providerEventId: 'event_refund_source_target_b',
        providerTransactionRef: 'txn_refund_source_target',
        rawBodyHash: 'hash_refund_source_target_b',
        receivedAt: new Date('2026-08-27T12:31:00.000Z'),
      });

      const priorResult = await ingestObservation(prisma, priorSuccess);
      const targetResult = await ingestObservation(prisma, targetSuccessA);
      await ingestObservation(prisma, targetSuccessB);

      const refundCase = await prisma.refundDueCase.findUniqueOrThrow({
        where: {
          dedupeKey: createHash('sha256')
            .update(
              [
                'pgo1:refund-due',
                obligationRow.merchantId,
                obligationRow.id,
                priorAttempt.provider,
                'txn_refund_source_prior',
                priorAttempt.id,
                priorResult.observationId,
              ].join(':'),
            )
            .digest('hex'),
        },
      });
      assert.equal(refundCase.attemptId, priorAttempt.id);
      assert.equal(refundCase.provider, priorAttempt.provider);
      assert.equal(refundCase.providerTransactionRef, 'txn_refund_source_prior');

      const refundFacts = await prisma.paymentNormalizedFactOutbox.findMany({
        where: {
          obligationId: obligationRow.id,
          factType: 'REFUND_DUE_DETECTED',
        },
        orderBy: { createdAt: 'asc' },
      });
      assert.equal(refundFacts.length, 1);
      assert.equal(refundFacts[0]!.attemptId, priorAttempt.id);
      assert.equal(refundFacts[0]!.triggeringObservationId, priorResult.observationId);
      assert.equal(refundFacts[0]!.providerReferenceId, 'txn_refund_source_prior');

      const paymentFacts = await prisma.paymentNormalizedFactOutbox.findMany({
        where: {
          obligationId: obligationRow.id,
          factType: 'PAYMENT_SUCCEEDED',
        },
        orderBy: { createdAt: 'asc' },
      });
      assert.equal(paymentFacts.length, 3);
      assert.ok(
        paymentFacts.some((fact) =>
          fact.attemptId === targetAttempt.id && fact.triggeringObservationId === targetResult.observationId,
        ),
      );
      assert.equal(await prisma.refundDueCase.count(), 1);
      assert.equal(await prisma.paymentNormalizedFactOutbox.count(), 4);
    });
  });
}
