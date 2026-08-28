import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Prisma, PrismaClient, type PaymentAttempt, type PaymentObligation } from '@prisma/client';
import * as pgo1 from '../index.js';
import { ingestObservation, persistSlaEscalation } from '../observationService.js';
import type {
  CanonicalObservation,
  IngestionResult,
  ProviderActivationPolicy,
} from '../types.js';
import type {
  MockStatusQueryInput,
  RawIngestionDeps,
  RawObservationInput,
} from '../adapters/providerAdapter.js';
import {
  MOCK_RECONCILIATION_POLICY_V1,
  reconciliationWorker,
  type Clock,
  type DerivedReconciliationState,
  type PendingReadOnlyQueryRequest,
  type ReadOnlyQueryConsumptionRecord,
  type ReconciliationAttempt,
} from '../reconciliationWorker.js';
import { expectedScratchDatabaseNameFromEnv } from './scratchDatabaseGuard.js';

const enabled = process.env.RUN_PGO1_POSTGRES_TESTS === '1';
const prisma = new PrismaClient();

it('exports Mock execution and no real-provider runtime surface', () => {
  assert.deepEqual(Object.keys(pgo1).sort(), [
    'MANUAL_EVIDENCE_EXCEPTION_GATE',
    'createAttempt',
    'createCheckoutObligations',
    'ingestRawObservation',
    'mockAdapter',
    'reconcileAttempt',
    'reviewService',
    'toBuyerPaymentStatus',
    'toOperatorPaymentReadModel',
    'toRefundDueOperatorReadModel',
    'validateShadowFact',
  ].sort());
});

for (const name of [
  'executeRefund', 'refundNow', 'capturePayment', 'authorizePayment', 'cancelPayment',
  'replayAttempt', 'setResolvedAt', 'overrideOutcome',
] as const) {
  it(`does not export prohibited authority ${name}`, () => {
    assert.equal(Object.prototype.hasOwnProperty.call(pgo1, name), false);
  });
}

interface MutableClock extends Clock {
  advanceBy(deltaMs: number): void;
}

interface MutationSpies {
  journal: Array<unknown>;
  wallet: Array<unknown>;
  settlement: Array<unknown>;
  payout: Array<unknown>;
  refund: Array<unknown>;
  custody: Array<unknown>;
}

function virtualClock(initialEpochMs: number): MutableClock {
  let nowMs = initialEpochMs;
  return {
    now() {
      return new Date(nowMs);
    },
    advanceBy(deltaMs: number) {
      nowMs += deltaMs;
    },
  };
}

function assertScratchUrl() {
  const raw = process.env.DATABASE_URL ?? '';
  const url = new URL(raw);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase()));
  assert.equal(url.port, '5433');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), expectedScratchDatabaseNameFromEnv());
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

function ownershipReaderFor(merchantId: string, checkoutId: string) {
  return {
    async assertOwned(
      _tx: Prisma.TransactionClient,
      candidateMerchantId: string,
      candidateCheckoutId: string,
    ) {
      if (candidateMerchantId !== merchantId || candidateCheckoutId !== checkoutId) {
        throw new Error('CHECKOUT_NOT_FOUND');
      }
    },
  };
}

function activationPolicy(
  merchantId: string,
  amountPaise: bigint,
  maxAmountPaise = amountPaise,
): ProviderActivationPolicy {
  return {
    version: 'acceptance-policy-v1',
    approved: true,
    merchantId,
    provider: 'MOCK',
    environment: 'TEST',
    operation: 'CREATE_ATTEMPT',
    maxAmountPaise,
  };
}

async function createMockAttempt(input: {
  merchantId: string;
  obligation: PaymentObligation;
  requestIdempotencyKey: string;
  credentialBindingId: string;
  credentialVersionId: string;
  maxAmountPaise?: bigint;
}) {
  return pgo1.createAttempt(prisma, {
    merchantId: input.merchantId,
    obligationId: input.obligation.id,
    provider: 'MOCK',
    environment: 'TEST',
    operation: 'CREATE_ATTEMPT',
    amountPaise: input.obligation.amountPaise,
    requestIdempotencyKey: input.requestIdempotencyKey,
    credentialBindingId: input.credentialBindingId,
    credentialVersionId: input.credentialVersionId,
    policy: activationPolicy(
      input.merchantId,
      input.obligation.amountPaise,
      input.maxAmountPaise,
    ),
  });
}

async function ingestMock(input: {
  attempt: PaymentAttempt;
  obligation: PaymentObligation;
  scenario: 'SUCCESS' | 'TERMINAL_FAILURE' | 'TIMEOUT' | 'PENDING' | 'UNKNOWN' | 'INTEGRITY_CONFLICT';
  observationId: string;
  raw?: RawObservationInput;
}): Promise<IngestionResult> {
  const raw = input.raw ?? await pgo1.mockAdapter.create({
    attemptId: input.attempt.id,
    obligationId: input.obligation.id,
    merchantId: input.obligation.merchantId,
    amountPaise: input.obligation.amountPaise,
    currency: 'INR',
    scenario: input.scenario,
  });
  const result = await pgo1.ingestRawObservation(
    mockIngestionDeps({
      attempt: input.attempt,
      obligation: input.obligation,
      observationId: input.observationId,
    }),
    raw,
  );

  assert.ok(!('kind' in result), `unexpected ingestion rejection: ${'reason' in result ? result.reason : 'unknown'}`);
  return result;
}

function patchMockRawBody(
  raw: RawObservationInput,
  patch: Partial<{
    providerEventId: string;
    providerOrderRef: string;
    providerTransactionRef: string | null;
  }>,
): RawObservationInput {
  const payload = JSON.parse(raw.rawBody.toString('utf8')) as Record<string, unknown>;
  return {
    ...raw,
    rawBody: Buffer.from(JSON.stringify({ ...payload, ...patch }), 'utf8'),
  };
}

function mockIngestionDeps(input: {
  attempt: PaymentAttempt;
  obligation: PaymentObligation;
  observationId: string;
}): RawIngestionDeps {
  return {
    parser: pgo1.mockAdapter,
    ingestionMode: 'MOCK_EXECUTABLE',
    retentionDecision: 'MOCK_SYNTHETIC',
    nextObservationId: () => input.observationId,
    resolveBinding: async () => ({
      attemptId: input.attempt.id,
      obligationId: input.obligation.id,
      merchantId: input.obligation.merchantId,
      credentialBindingId: input.attempt.credentialBindingId,
      credentialVersionId: input.attempt.credentialVersionId,
      bindingVerification: 'VERIFIED',
    }),
    verify: async () => 'NOT_APPLICABLE',
    persist: (candidate: CanonicalObservation) => ingestObservation(prisma, candidate),
  };
}

async function codSnapshot(obligationId: string) {
  const [obligation, transitions, reviews, attention, facts, cases, observations, deliveries] = await Promise.all([
    prisma.paymentObligation.findUniqueOrThrow({ where: { id: obligationId } }),
    prisma.paymentOutcomeTransition.findMany({ where: { obligationId }, orderBy: { id: 'asc' } }),
    prisma.reconciliationReviewHistory.findMany({ where: { obligationId }, orderBy: { id: 'asc' } }),
    prisma.paymentAttentionSignal.findMany({ where: { obligationId }, orderBy: { id: 'asc' } }),
    prisma.paymentNormalizedFactOutbox.findMany({ where: { obligationId }, orderBy: { id: 'asc' } }),
    prisma.refundDueCase.findMany({ where: { obligationId }, orderBy: { id: 'asc' } }),
    prisma.providerObservation.findMany({ where: { obligationId }, orderBy: { id: 'asc' } }),
    prisma.providerObservationDelivery.findMany({ where: { obligationId }, orderBy: { id: 'asc' } }),
  ]);

  return {
    obligation,
    transitions,
    reviews,
    attention,
    facts,
    cases,
    observations,
    deliveries,
  };
}

function assertZeroMutations(spies: MutationSpies) {
  assert.deepEqual(spies, {
    journal: [],
    wallet: [],
    settlement: [],
    payout: [],
    refund: [],
    custody: [],
  });
}

async function listPendingReadOnlyQueryRequests(): Promise<PendingReadOnlyQueryRequest[]> {
  const rows = await prisma.reconciliationReviewHistory.findMany({
    where: { reasonCode: 'READ_ONLY_QUERY_REQUESTED' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const pending: PendingReadOnlyQueryRequest[] = [];

  for (const row of rows) {
    if (!row.correlationId) {
      continue;
    }

    const consumed = await prisma.reconciliationReviewHistory.findFirst({
      where: {
        attemptId: row.attemptId,
        merchantId: row.merchantId,
        reasonCode: { in: ['READ_ONLY_QUERY_CLAIMED', 'READ_ONLY_QUERY_CONSUMED'] },
        correlationId: row.correlationId,
      },
      select: { id: true },
    });
    if (consumed) {
      continue;
    }

    const attempt = await prisma.paymentAttempt.findUnique({ where: { id: row.attemptId } });
    if (!attempt) {
      continue;
    }

    pending.push({
      requestId: row.correlationId,
      attemptId: row.attemptId,
      obligationId: row.obligationId,
      merchantId: row.merchantId,
      provider: attempt.provider,
      environment: attempt.environment,
      credentialBindingId: attempt.credentialBindingId,
      credentialVersionId: attempt.credentialVersionId,
      operation: 'STATUS_QUERY',
      note: 'acceptance deterministic queue request',
    });
  }

  return pending;
}

async function claimReadOnlyQueryRequest(
  request: PendingReadOnlyQueryRequest,
): Promise<PendingReadOnlyQueryRequest | null> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ReconciliationReviewHistory"
      WHERE "attemptId" = ${request.attemptId}
        AND "obligationId" = ${request.obligationId}
        AND "merchantId" = ${request.merchantId}
        AND "reasonCode" = 'READ_ONLY_QUERY_REQUESTED'
        AND "correlationId" = ${request.requestId}
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 1
      FOR UPDATE
    `;
    if (locked.length !== 1) {
      return null;
    }

    const priorClaim = await tx.reconciliationReviewHistory.findFirst({
      where: {
        attemptId: request.attemptId,
        obligationId: request.obligationId,
        merchantId: request.merchantId,
        reasonCode: { in: ['READ_ONLY_QUERY_CLAIMED', 'READ_ONLY_QUERY_CONSUMED'] },
        correlationId: request.requestId,
      },
      select: { id: true },
    });
    if (priorClaim) {
      return null;
    }

    const attempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: request.attemptId } });
    await tx.reconciliationReviewHistory.create({
      data: {
        attemptId: attempt.id,
        obligationId: attempt.obligationId,
        merchantId: attempt.merchantId,
        priorReviewStatus: attempt.reviewStatus,
        nextReviewStatus: attempt.reviewStatus,
        completedByType: null,
        actorId: null,
        reasonCode: 'READ_ONLY_QUERY_CLAIMED',
        triggeringObservationId: null,
        evidenceReferenceIds: { references: [], note: request.note },
        correlationId: request.requestId,
      },
    });

    return request;
  });
}

async function persistReadOnlyQueryConsumption(input: ReadOnlyQueryConsumptionRecord) {
  const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
    where: { id: input.request.attemptId },
  });
  await prisma.reconciliationReviewHistory.create({
    data: {
      attemptId: attempt.id,
      obligationId: attempt.obligationId,
      merchantId: attempt.merchantId,
      priorReviewStatus: attempt.reviewStatus,
      nextReviewStatus: attempt.reviewStatus,
      completedByType: null,
      actorId: null,
      reasonCode: 'READ_ONLY_QUERY_CONSUMED',
      triggeringObservationId: null,
      evidenceReferenceIds: {
        references: [],
        note: input.request.note,
        result: input.result.kind,
      },
      correlationId: input.request.requestId,
    },
  });
}

if (enabled) {
  describe('PGO-1 shadow PostgreSQL acceptance', () => {
    before(async () => {
      assertScratchUrl();
      const current = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
      assert.equal(current[0]?.name, expectedScratchDatabaseNameFromEnv());
    });

    beforeEach(async () => {
      await clearPaymentTables(prisma);
    });

    after(async () => {
      await prisma.$disconnect();
    });

    it('runs the Mock-only shadow payment lifecycle without real-provider or money-moving authority', async () => {
      const spies: MutationSpies = {
        journal: [],
        wallet: [],
        settlement: [],
        payout: [],
        refund: [],
        custody: [],
      };
      const clock = virtualClock(0);
      const merchantId = 'merchant_pgo1_acceptance';
      const checkoutId = 'checkout_pgo1_acceptance';
      const credentialBindingId = 'binding_pgo1_acceptance';
      const credentialVersionId = 'credential_pgo1_acceptance_v1';
      const created = await prisma.$transaction((tx) =>
        pgo1.createCheckoutObligations(
          tx,
          ownershipReaderFor(merchantId, checkoutId),
          {
            merchantId,
            checkoutId,
            mode: 'PARTIAL_COD',
            onlineAdvancePaise: 20_000n,
            deliveryBalancePaise: 80_000n,
            currency: 'INR',
          },
        ),
      );
      assert.ok(created.cod);
      const codBefore = await codSnapshot(created.cod.id);

      await assert.rejects(
        createMockAttempt({
          merchantId,
          obligation: created.online,
          requestIdempotencyKey: 'request_ceiling_blocked',
          credentialBindingId,
          credentialVersionId,
          maxAmountPaise: 19_999n,
        }),
        /PROVIDER_POLICY_DISABLED/,
      );

      const [left, right] = await Promise.allSettled([
        createMockAttempt({
          merchantId,
          obligation: created.online,
          requestIdempotencyKey: 'request_acceptance_left',
          credentialBindingId,
          credentialVersionId,
        }),
        createMockAttempt({
          merchantId,
          obligation: created.online,
          requestIdempotencyKey: 'request_acceptance_right',
          credentialBindingId,
          credentialVersionId,
        }),
      ]);
      assert.deepEqual([left.status, right.status].sort(), ['fulfilled', 'fulfilled']);
      assert.equal(
        [left, right].filter((result) =>
          result.status === 'fulfilled' && result.value.kind === 'CREATED',
        ).length,
        1,
      );
      assert.equal(
        [left, right].filter((result) =>
          result.status === 'fulfilled' && result.value.kind === 'EXISTING_UNRESOLVED',
        ).length,
        1,
      );
      assert.equal(await prisma.paymentAttempt.count({
        where: { obligationId: created.online.id, resolvedAt: null },
      }), 1);

      const attempt = await prisma.paymentAttempt.findFirstOrThrow({
        where: { obligationId: created.online.id },
      });
      const providerOrderRef = `mock_order_${created.online.id}_${attempt.id}`;
      await prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          providerOrderRef,
          adapterVersion: pgo1.mockAdapter.adapterVersion,
          mappingVersion: pgo1.mockAdapter.mappingVersion,
          createdAt: clock.now(),
          lastOutcomeChangedAt: clock.now(),
        },
      });
      const currentAttempt = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });

      const timeout = await ingestMock({
        attempt: currentAttempt,
        obligation: created.online,
        scenario: 'TIMEOUT',
        observationId: 'observation_acceptance_timeout',
      });
      assert.equal(timeout.outcomeStatus, 'UNKNOWN');
      assert.equal(timeout.reviewStatus, 'NOT_REQUIRED');
      let persistedAttempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      assert.equal(persistedAttempt.outcomeStatus, 'UNKNOWN');
      assert.equal(persistedAttempt.reviewStatus, 'NOT_REQUIRED');
      assert.equal(persistedAttempt.resolvedAt, null);

      clock.advanceBy(MOCK_RECONCILIATION_POLICY_V1.slaMs);
      const escalation = await persistSlaEscalation(prisma, {
        attemptId: attempt.id,
        obligationId: created.online.id,
        merchantId,
        observedAt: clock.now(),
        reason: 'SLA_EXCEEDED',
      });
      assert.deepEqual(escalation, {
        kind: 'ESCALATED',
        outcomeStatus: 'UNKNOWN',
        reviewStatus: 'REQUIRED',
      });
      persistedAttempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      assert.equal(persistedAttempt.outcomeStatus, 'UNKNOWN');
      assert.equal(persistedAttempt.reviewStatus, 'REQUIRED');
      assert.equal(persistedAttempt.resolvedAt, null);

      await pgo1.reviewService.claimReview(prisma, {
        merchantId,
        attemptId: attempt.id,
        reviewerId: 'operator_acceptance',
      });
      await pgo1.reviewService.requestReadOnlyQuery(prisma, {
        merchantId,
        attemptId: attempt.id,
        reviewerId: 'operator_acceptance',
        note: 'acceptance deterministic queue request',
        requestId: 'review_query_acceptance_1',
      });

      const worker = reconciliationWorker({
        clock,
        policy: MOCK_RECONCILIATION_POLICY_V1,
        getReconciliationState: async (): Promise<DerivedReconciliationState> => {
          const observations = await prisma.providerObservation.findMany({
            where: { attemptId: attempt.id },
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
            select: { receivedAt: true },
          });
          return {
            amountPaise: created.online.amountPaise,
            currency: 'INR',
            queryCount: observations.length,
            lastReconciledAt: observations[0]?.receivedAt ?? null,
          };
        },
        queryStatus: async (input: MockStatusQueryInput) => {
          const raw = await pgo1.mockAdapter.queryStatus({ ...input, scenario: 'SUCCESS' });
          return {
            ...patchMockRawBody(raw, { providerEventId: 'event_acceptance_success' }),
            receivedAt: clock.now(),
          };
        },
        ingestRawObservation: (raw: RawObservationInput) => pgo1.ingestRawObservation(
          mockIngestionDeps({
            attempt: currentAttempt,
            obligation: created.online,
            observationId: 'observation_acceptance_success',
          }),
          raw,
        ),
        buildCredentialUseInput: async (workerAttempt: ReconciliationAttempt) => ({
          originalMerchantId: workerAttempt.merchantId,
          requestedMerchantId: workerAttempt.merchantId,
          originalProvider: workerAttempt.provider,
          requestedProvider: workerAttempt.provider,
          originalEnvironment: workerAttempt.environment,
          requestedEnvironment: workerAttempt.environment,
          originalBindingId: workerAttempt.credentialBindingId,
          requestedBindingId: workerAttempt.credentialBindingId,
          continuity: 'PROVEN_SAME_ACCOUNT',
          credentialState: 'ACTIVE',
          operation: 'STATUS_QUERY',
        }),
        persistSlaEscalation: (input) => persistSlaEscalation(prisma, input),
        listRequestedReadOnlyQueries: listPendingReadOnlyQueryRequests,
        claimReadOnlyQueryRequest,
        persistReadOnlyQueryConsumption,
        listUnresolvedAttempts: () => prisma.paymentAttempt.findMany({
          where: { obligationId: created.online.id, merchantId, resolvedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      });

      assert.deepEqual(await worker.runOnce(), [{
        kind: 'OBSERVATION_INGESTED',
        observationId: 'observation_acceptance_success',
      }]);
      persistedAttempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      assert.equal(persistedAttempt.outcomeStatus, 'SUCCEEDED');
      assert.equal(persistedAttempt.reviewStatus, 'COMPLETED');
      assert.ok(persistedAttempt.resolvedAt);
      let onlineObligation = await prisma.paymentObligation.findUniqueOrThrow({
        where: { id: created.online.id },
      });
      assert.equal(onlineObligation.status, 'SATISFIED');
      assert.ok(onlineObligation.satisfiedAt);

      const terminalFailureRaw = await pgo1.mockAdapter.create({
        attemptId: currentAttempt.id,
        obligationId: created.online.id,
        merchantId,
        amountPaise: created.online.amountPaise,
        currency: 'INR',
        scenario: 'TERMINAL_FAILURE',
      });
      await ingestMock({
        attempt: currentAttempt,
        obligation: created.online,
        scenario: 'TERMINAL_FAILURE',
        observationId: 'observation_acceptance_failure',
        raw: patchMockRawBody(terminalFailureRaw, {
          providerEventId: 'event_acceptance_failure',
          providerOrderRef,
        }),
      });
      persistedAttempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      assert.equal(persistedAttempt.outcomeStatus, 'SUCCEEDED');
      assert.equal(persistedAttempt.reviewStatus, 'COMPLETED');
      assert.ok(persistedAttempt.resolvedAt);

      await prisma.paymentAttempt.create({
        data: {
          id: 'attempt_acceptance_surplus',
          obligationId: created.online.id,
          merchantId,
          obligationCollectionRail: 'ONLINE',
          provider: 'MOCK',
          environment: 'TEST',
          credentialBindingId,
          credentialVersionId,
          requestIdempotencyKey: 'request_acceptance_surplus',
          providerOrderRef: `mock_order_${created.online.id}_attempt_acceptance_surplus`,
          outcomeStatus: 'PENDING',
          reviewStatus: 'NOT_REQUIRED',
          resolvedAt: null,
          lastOutcomeChangedAt: clock.now(),
          lastObservationAt: null,
          adapterVersion: pgo1.mockAdapter.adapterVersion,
          mappingVersion: pgo1.mockAdapter.mappingVersion,
        },
      });
      const surplusAttempt = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: 'attempt_acceptance_surplus' },
      });
      await ingestMock({
        attempt: surplusAttempt,
        obligation: created.online,
        scenario: 'SUCCESS',
        observationId: 'observation_acceptance_surplus_success',
      });

      const refundCases = await prisma.refundDueCase.findMany({
        where: { obligationId: created.online.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      assert.equal(refundCases.length, 1);
      assert.equal(refundCases[0]?.reason, 'SURPLUS_DOUBLE_SUCCESS');
      assert.equal(refundCases[0]?.attemptId, surplusAttempt.id);

      const outbox = await prisma.paymentNormalizedFactOutbox.findMany({
        where: { obligationId: created.online.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const refundDueFacts = outbox.filter((fact) => fact.factType === 'REFUND_DUE_DETECTED');
      assert.equal(refundDueFacts.length, 1);
      assert.equal(refundDueFacts[0]?.attemptId, surplusAttempt.id);
      assert.equal(refundDueFacts[0]?.providerReferenceId, refundCases[0]?.providerTransactionRef);
      for (const fact of outbox) {
        assert.deepEqual(pgo1.validateShadowFact(fact), { valid: true });
      }

      const queueConsumption = outbox.map((fact, index) => ({
        sequence: index + 1,
        factId: fact.id,
        factType: fact.factType,
        dedupeKey: fact.dedupeKey,
      }));
      assert.deepEqual(
        queueConsumption.map((entry) => `${entry.sequence}:${entry.factType}`),
        [
          '1:PAYMENT_SUCCEEDED',
          '2:PAYMENT_SUCCEEDED',
          '3:PAYMENT_SUCCEEDED',
          '4:REFUND_DUE_DETECTED',
        ],
      );

      const history = await prisma.reconciliationReviewHistory.findMany({
        where: { attemptId: attempt.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { reasonCode: true, completedByType: true, correlationId: true },
      });
      assert.deepEqual(history.map((entry) => entry.reasonCode), [
        'SLA_EXCEEDED',
        'REVIEW_CLAIMED',
        'READ_ONLY_QUERY_REQUESTED',
        'READ_ONLY_QUERY_CLAIMED',
        'SYSTEM_COMPLETED_BY_TERMINAL_OBSERVATION',
        'READ_ONLY_QUERY_CONSUMED',
      ]);
      assert.ok(history.some((entry) =>
        entry.reasonCode === 'SYSTEM_COMPLETED_BY_TERMINAL_OBSERVATION' &&
        entry.completedByType === 'SYSTEM',
      ));

      onlineObligation = await prisma.paymentObligation.findUniqueOrThrow({
        where: { id: created.online.id },
      });
      assert.equal(onlineObligation.status, 'SATISFIED');
      assert.deepEqual(await codSnapshot(created.cod.id), codBefore);
      assertZeroMutations(spies);
    });
  });
} else {
  after(async () => {
    await prisma.$disconnect();
  });
}
