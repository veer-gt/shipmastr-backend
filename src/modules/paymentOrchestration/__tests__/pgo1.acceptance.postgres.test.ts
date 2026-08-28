import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Prisma, PrismaClient, type PaymentAttempt, type PaymentNormalizedFactOutbox, type PaymentObligation, type RefundDueCase } from '@prisma/client';
import * as pgo1 from '../index.js';
import { ingestObservation, persistSlaEscalation } from '../observationService.js';
import type {
  CanonicalObservation,
  IngestionResult,
  ProviderActivationPolicy,
  ShadowMutationBoundary,
  ShadowMutationCategory,
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
import {
  DeterministicRefundQueueStub,
  type RefundDueDetectedV1,
  virtualClock as refundQueueVirtualClock,
} from '../refundDueContract.js';
import { expectedScratchDatabaseNameFromEnv } from './scratchDatabaseGuard.js';

const enabled = process.env.RUN_PGO1_POSTGRES_TESTS === '1';
const prisma = new PrismaClient();
const ACCEPTANCE_MERCHANT_ID = 'merchant_pgo1_acceptance';
const ACCEPTANCE_CHECKOUT_ID = 'checkout_pgo1_acceptance';

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

type MutationRecorder = Record<ShadowMutationCategory, unknown[]> & {
  authorityChecks: Array<{
    merchantId: string;
    obligationId: string;
    attemptId: string;
    categories: readonly ShadowMutationCategory[];
  }>;
  boundary: ShadowMutationBoundary;
};

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

async function acceptanceNamespaceCounts(client: PrismaClient) {
  const obligationIds = await acceptanceNamespaceObligationIds(client);
  const childWhere = {
    merchantId: ACCEPTANCE_MERCHANT_ID,
    obligationId: { in: obligationIds },
  };
  const [
    interpretations,
    deliveries,
    facts,
    cases,
    attention,
    reviews,
    transitions,
    observations,
    attempts,
    obligations,
  ] = await Promise.all([
    client.providerObservationInterpretation.count({ where: childWhere }),
    client.providerObservationDelivery.count({ where: childWhere }),
    client.paymentNormalizedFactOutbox.count({ where: childWhere }),
    client.refundDueCase.count({ where: childWhere }),
    client.paymentAttentionSignal.count({ where: childWhere }),
    client.reconciliationReviewHistory.count({ where: childWhere }),
    client.paymentOutcomeTransition.count({ where: childWhere }),
    client.providerObservation.count({ where: childWhere }),
    client.paymentAttempt.count({ where: childWhere }),
    client.paymentObligation.count({
      where: {
        merchantId: ACCEPTANCE_MERCHANT_ID,
        checkoutId: ACCEPTANCE_CHECKOUT_ID,
      },
    }),
  ]);

  return {
    interpretations,
    deliveries,
    facts,
    cases,
    attention,
    reviews,
    transitions,
    observations,
    attempts,
    obligations,
  };
}

async function acceptanceNamespaceObligationIds(client: PrismaClient) {
  const rows = await client.paymentObligation.findMany({
    where: {
      merchantId: ACCEPTANCE_MERCHANT_ID,
      checkoutId: ACCEPTANCE_CHECKOUT_ID,
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

async function assertAcceptanceNamespaceEmpty(client: PrismaClient) {
  assert.deepEqual(await acceptanceNamespaceCounts(client), {
    interpretations: 0,
    deliveries: 0,
    facts: 0,
    cases: 0,
    attention: 0,
    reviews: 0,
    transitions: 0,
    observations: 0,
    attempts: 0,
    obligations: 0,
  });
}

async function deleteAcceptanceNamespace(client: PrismaClient) {
  const obligationIds = await acceptanceNamespaceObligationIds(client);
  if (obligationIds.length === 0) {
    return;
  }

  const childWhere = {
    merchantId: ACCEPTANCE_MERCHANT_ID,
    obligationId: { in: obligationIds },
  };
  await client.providerObservationInterpretation.deleteMany({ where: childWhere });
  await client.providerObservationDelivery.deleteMany({ where: childWhere });
  await client.paymentNormalizedFactOutbox.deleteMany({ where: childWhere });
  await client.refundDueCase.deleteMany({ where: childWhere });
  await client.paymentAttentionSignal.deleteMany({ where: childWhere });
  await client.reconciliationReviewHistory.deleteMany({ where: childWhere });
  await client.paymentOutcomeTransition.deleteMany({ where: childWhere });
  await client.providerObservation.deleteMany({ where: childWhere });
  await client.paymentAttempt.deleteMany({ where: childWhere });
  await client.paymentObligation.deleteMany({
    where: {
      merchantId: ACCEPTANCE_MERCHANT_ID,
      checkoutId: ACCEPTANCE_CHECKOUT_ID,
    },
  });
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
  mutationBoundary?: ShadowMutationBoundary | undefined;
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
      mutationBoundary: input.mutationBoundary,
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
  mutationBoundary?: ShadowMutationBoundary | undefined;
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
    persist: (candidate: CanonicalObservation) =>
      ingestObservation(prisma, candidate, { mutationBoundary: input.mutationBoundary }),
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

function createRecordingMutationBoundary(): MutationRecorder {
  const recorder: Omit<MutationRecorder, 'boundary'> = {
    authorityChecks: [],
    journal: [],
    wallet: [],
    settlement: [],
    payout: [],
    refund: [],
    custody: [],
  };

  return {
    ...recorder,
    boundary: {
      assertNoMutationAuthority(input) {
        recorder.authorityChecks.push(input);
      },
    },
  };
}

function assertZeroMutations(recorder: MutationRecorder) {
  assert.ok(recorder.authorityChecks.length > 0);
  for (const check of recorder.authorityChecks) {
    assert.deepEqual([...check.categories].sort(), [
      'custody',
      'journal',
      'payout',
      'refund',
      'settlement',
      'wallet',
    ]);
  }
  assert.deepEqual(
    {
      journal: recorder.journal,
      wallet: recorder.wallet,
      settlement: recorder.settlement,
      payout: recorder.payout,
      refund: recorder.refund,
      custody: recorder.custody,
    },
    {
      journal: [],
      wallet: [],
      settlement: [],
      payout: [],
      refund: [],
      custody: [],
    },
  );
}

function toRefundDueDetectedV1(
  fact: PaymentNormalizedFactOutbox,
  refundCase: RefundDueCase,
): RefundDueDetectedV1 {
  assert.equal(fact.factType, 'REFUND_DUE_DETECTED');
  assert.equal(fact.merchantId, refundCase.merchantId);
  assert.equal(fact.obligationId, refundCase.obligationId);
  assert.equal(fact.attemptId, refundCase.attemptId);
  assert.equal(fact.providerReferenceId, refundCase.providerTransactionRef);
  assert.equal(fact.dedupeKey, refundCase.dedupeKey);

  return {
    schemaVersion: 'pgo1.refund-due.v1',
    factId: fact.id,
    merchantId: fact.merchantId,
    obligationId: fact.obligationId,
    attemptId: fact.attemptId,
    provider: fact.provider,
    providerTransactionRef: fact.providerReferenceId,
    amountPaise: fact.amountPaise,
    currency: 'INR',
    reason: refundCase.reason,
    dedupeKey: fact.dedupeKey,
    detectedAt: refundCase.detectedAt.toISOString(),
  };
}

async function listPendingReadOnlyQueryRequests(): Promise<PendingReadOnlyQueryRequest[]> {
  const rows = await prisma.reconciliationReviewHistory.findMany({
    where: {
      merchantId: ACCEPTANCE_MERCHANT_ID,
      reasonCode: 'READ_ONLY_QUERY_REQUESTED',
    },
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

    const attempt = await prisma.paymentAttempt.findFirst({
      where: {
        id: row.attemptId,
        merchantId: ACCEPTANCE_MERCHANT_ID,
      },
    });
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
  const attempt = await prisma.paymentAttempt.findFirstOrThrow({
    where: {
      id: input.request.attemptId,
      obligationId: input.request.obligationId,
      merchantId: ACCEPTANCE_MERCHANT_ID,
    },
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
      await assertAcceptanceNamespaceEmpty(prisma);
    });

    afterEach(async () => {
      await deleteAcceptanceNamespace(prisma);
    });

    after(async () => {
      await prisma.$disconnect();
    });

    it('runs the Mock-only shadow payment lifecycle without real-provider or money-moving authority', async () => {
      const mutationRecorder = createRecordingMutationBoundary();
      const clock = virtualClock(0);
      const merchantId = ACCEPTANCE_MERCHANT_ID;
      const checkoutId = ACCEPTANCE_CHECKOUT_ID;
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
        mutationBoundary: mutationRecorder.boundary,
      });
      assert.equal(timeout.outcomeStatus, 'UNKNOWN');
      assert.equal(timeout.reviewStatus, 'NOT_REQUIRED');
      let persistedAttempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      assert.equal(persistedAttempt.outcomeStatus, 'UNKNOWN');
      assert.equal(persistedAttempt.reviewStatus, 'NOT_REQUIRED');
      assert.equal(persistedAttempt.resolvedAt, null);

      clock.advanceBy(MOCK_RECONCILIATION_POLICY_V1.slaMs);
      const escalationWorker = reconciliationWorker({
        clock,
        policy: MOCK_RECONCILIATION_POLICY_V1,
        getReconciliationState: async (): Promise<DerivedReconciliationState> => ({
          amountPaise: created.online.amountPaise,
          currency: 'INR',
          queryCount: 0,
          lastReconciledAt: null,
        }),
        queryStatus: async (input: MockStatusQueryInput) => {
          const raw = await pgo1.mockAdapter.queryStatus({ ...input, scenario: 'TIMEOUT' });
          return {
            ...patchMockRawBody(raw, { providerEventId: 'event_acceptance_sla_probe' }),
            receivedAt: clock.now(),
          };
        },
        ingestRawObservation: (raw: RawObservationInput) => pgo1.ingestRawObservation(
          mockIngestionDeps({
            attempt: currentAttempt,
            obligation: created.online,
            observationId: 'observation_acceptance_sla_probe',
            mutationBoundary: mutationRecorder.boundary,
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
        listUnresolvedAttempts: () => prisma.paymentAttempt.findMany({
          where: { obligationId: created.online.id, merchantId, resolvedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      });
      assert.deepEqual(await escalationWorker.runOnce(), [{
        kind: 'OBSERVATION_INGESTED',
        observationId: 'observation_acceptance_sla_probe',
      }]);
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

      const [pendingReadOnlyRequest] = await listPendingReadOnlyQueryRequests();
      assert.ok(pendingReadOnlyRequest);
      const claimedReadOnlyRequest = await claimReadOnlyQueryRequest(pendingReadOnlyRequest);
      assert.ok(claimedReadOnlyRequest);

      const successReconciliationResult = await pgo1.reconcileAttempt({
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
            mutationBoundary: mutationRecorder.boundary,
          }),
          raw,
        ),
        buildCredentialUseInput: async (workerAttempt: ReconciliationAttempt, request) => ({
          originalMerchantId: workerAttempt.merchantId,
          requestedMerchantId: request?.merchantId ?? workerAttempt.merchantId,
          originalProvider: workerAttempt.provider,
          requestedProvider: request?.provider ?? workerAttempt.provider,
          originalEnvironment: workerAttempt.environment,
          requestedEnvironment: request?.environment ?? workerAttempt.environment,
          originalBindingId: workerAttempt.credentialBindingId,
          requestedBindingId: request?.credentialBindingId ?? workerAttempt.credentialBindingId,
          continuity: 'PROVEN_SAME_ACCOUNT',
          credentialState: 'ACTIVE',
          operation: 'STATUS_QUERY',
        }),
        persistSlaEscalation: (input) => persistSlaEscalation(prisma, input),
      }, currentAttempt, claimedReadOnlyRequest);
      assert.deepEqual(successReconciliationResult, {
        kind: 'OBSERVATION_INGESTED',
        observationId: 'observation_acceptance_success',
      });
      await persistReadOnlyQueryConsumption({
        request: claimedReadOnlyRequest,
        result: successReconciliationResult,
      });
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
        mutationBoundary: mutationRecorder.boundary,
      });
      persistedAttempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      assert.equal(persistedAttempt.outcomeStatus, 'SUCCEEDED');
      assert.equal(persistedAttempt.reviewStatus, 'COMPLETED');
      assert.ok(persistedAttempt.resolvedAt);

      const surplusAttemptResult = await createMockAttempt({
        merchantId,
        obligation: created.online,
        requestIdempotencyKey: 'request_acceptance_surplus',
        credentialBindingId,
        credentialVersionId,
      });
      assert.equal(surplusAttemptResult.kind, 'CREATED');
      await prisma.paymentAttempt.update({
        where: { id: surplusAttemptResult.attempt.id },
        data: {
          providerOrderRef: `mock_order_${created.online.id}_${surplusAttemptResult.attempt.id}`,
          adapterVersion: pgo1.mockAdapter.adapterVersion,
          mappingVersion: pgo1.mockAdapter.mappingVersion,
          createdAt: clock.now(),
          lastOutcomeChangedAt: clock.now(),
        },
      });
      const surplusAttempt = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: surplusAttemptResult.attempt.id },
      });
      await ingestMock({
        attempt: surplusAttempt,
        obligation: created.online,
        scenario: 'SUCCESS',
        observationId: 'observation_acceptance_surplus_success',
        mutationBoundary: mutationRecorder.boundary,
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

      const outboxFactSequence = outbox.map((fact, index) => ({
        sequence: index + 1,
        factId: fact.id,
        factType: fact.factType,
        dedupeKey: fact.dedupeKey,
      }));
      assert.deepEqual(
        outboxFactSequence.map((entry) => `${entry.sequence}:${entry.factType}`),
        [
          '1:PAYMENT_SUCCEEDED',
          '2:PAYMENT_SUCCEEDED',
          '3:PAYMENT_SUCCEEDED',
          '4:REFUND_DUE_DETECTED',
        ],
      );
      const refundDueEvent = toRefundDueDetectedV1(refundDueFacts[0]!, refundCases[0]!);
      const refundQueue = new DeterministicRefundQueueStub({
        clock: refundQueueVirtualClock(0),
      });
      refundQueue.consume(refundDueEvent);
      refundQueue.consume(refundDueEvent);
      assert.deepEqual(refundQueue.list().map((entry) => ({
        owner: entry.owner,
        status: entry.status,
        merchantId: entry.merchantId,
        obligationId: entry.obligationId,
        attemptId: entry.attemptId,
        reason: entry.reason,
        dedupeKey: entry.dedupeKey,
      })), [{
        owner: 'PAYMENTS_OPERATIONS',
        status: 'OPEN',
        merchantId,
        obligationId: created.online.id,
        attemptId: surplusAttempt.id,
        reason: 'SURPLUS_DOUBLE_SUCCESS',
        dedupeKey: refundDueFacts[0]!.dedupeKey,
      }]);
      refundQueue.acknowledge({ caseId: 'case_1' });
      assert.partialDeepStrictEqual(refundQueue.list()[0], {
        owner: 'PAYMENTS_OPERATIONS',
        status: 'ACKNOWLEDGED',
      });

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
      assertZeroMutations(mutationRecorder);
    });
  });
} else {
  after(async () => {
    await prisma.$disconnect();
  });
}
