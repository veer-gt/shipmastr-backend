import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Prisma, PrismaClient, type PaymentProvider, type ProviderEnvironment } from '@prisma/client';
import { expectedScratchDatabaseNameFromEnv } from './scratchDatabaseGuard.js';
import { createPaymentPostgresNamespace } from './postgresTestNamespace.js';
import {
  ingestObservation,
  persistProviderSecurityRejection,
} from '../observationService.js';
import { ingestRawObservation } from '../observationIngestor.js';
import {
  MANUAL_EVIDENCE_EXCEPTION_GATE,
  attachEvidenceReference,
  claimReview,
  evaluateEvidenceHorizonGovernanceTrigger,
  requestReadOnlyQuery,
  reviewService,
  viewReview,
} from '../reviewService.js';
import type {
  ObservationParser,
  ParsedObservationFields,
  RawObservationInput,
} from '../adapters/providerAdapter.js';

const enabled = process.env.RUN_PGO1_POSTGRES_TESTS === '1';
const prisma = new PrismaClient();
const namespace = createPaymentPostgresNamespace('review_service');

let sequence = 0;

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
  return {
    id: overrides.id ?? nextId('attempt'),
    obligationId: overrides.obligationId ?? nextId('obligation_ref'),
    merchantId: overrides.merchantId ?? nextId('merchant'),
    obligationCollectionRail: overrides.obligationCollectionRail ?? 'ONLINE',
    provider: overrides.provider ?? 'MOCK',
    environment: overrides.environment ?? 'TEST',
    credentialBindingId: overrides.credentialBindingId ?? nextId('binding'),
    credentialVersionId: overrides.credentialVersionId ?? nextId('credential_version'),
    requestIdempotencyKey: overrides.requestIdempotencyKey ?? nextId('request'),
    providerOrderRef: overrides.providerOrderRef ?? nextId('provider_order'),
    outcomeStatus: overrides.outcomeStatus ?? 'UNKNOWN',
    reviewStatus: overrides.reviewStatus ?? 'REQUIRED',
    resolvedAt: overrides.resolvedAt ?? null,
    lastOutcomeChangedAt: overrides.lastOutcomeChangedAt ?? new Date('2026-08-28T00:00:00.000Z'),
    lastObservationAt: overrides.lastObservationAt ?? null,
    adapterVersion: overrides.adapterVersion ?? 'test-adapter-v1',
    mappingVersion: overrides.mappingVersion ?? 'test-mapping-v1',
  };
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

async function loadAttempt(attemptId: string) {
  return prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
}

function lateWebhookParser(input: {
  providerOrderRef: string;
  provider?: PaymentProvider;
  environment?: ProviderEnvironment;
  mappedOutcome?: ParsedObservationFields['mappedOutcome'];
  providerOccurredAt?: Date | null;
  providerTransactionRef?: string | null;
}): ObservationParser {
  return {
    provider: input.provider ?? 'MOCK',
    adapterVersion: 'late-webhook-adapter-v1',
    mappingVersion: 'late-webhook-mapping-v1',
    providerApiVersion: 'late-webhook-api-v1',
    parse(raw: RawObservationInput): ParsedObservationFields {
      return {
        provider: input.provider ?? 'MOCK',
        environment: input.environment ?? 'TEST',
        source: 'WEBHOOK',
        providerEventId: nextId('event'),
        providerOrderRef: input.providerOrderRef,
        providerTransactionRef: input.providerTransactionRef ?? nextId('txn'),
        nativeStatus: input.mappedOutcome === 'PENDING' ? 'pending' : 'captured',
        nativeReasonCode: null,
        amountPaise: 10_000n,
        nativeAmountText: '100.00',
        nativeCurrency: 'INR',
        evidenceAuthority: 'ELIGIBLE',
        mappedOutcome: input.mappedOutcome ?? 'SUCCEEDED',
        adapterVersion: 'late-webhook-adapter-v1',
        mappingVersion: 'late-webhook-mapping-v1',
        providerApiVersion: 'late-webhook-api-v1',
        providerOccurredAt: input.providerOccurredAt ?? new Date('2026-08-27T18:00:00.000Z'),
      };
    },
  };
}

function rawWebhookInput(label: string): RawObservationInput {
  return {
    rawBody: Buffer.from(JSON.stringify({ label, late: true }), 'utf8'),
    headers: {
      'content-type': 'application/json',
      'x-shipmastr-late-webhook': label,
    },
    receivedAt: new Date('2026-08-28T06:00:00.000Z'),
  };
}

if (enabled) {
  describe('reviewService PostgreSQL integration', () => {
    before(async () => {
      assertScratchUrl();
      const current = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
      assert.equal(current[0]?.name, expectedScratchDatabaseNameFromEnv());
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

    it('lets a reviewer claim work and attach a PII-safe reference while preserving attempt invariants', async () => {
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: nextId('obligation_review_claim'),
          merchantId: namespace.id('merchant_review_claim'),
        },
        attempt: {
          id: nextId('attempt_review_claim'),
          reviewStatus: 'REQUIRED',
          outcomeStatus: 'UNKNOWN',
          providerOrderRef: 'order_review_claim',
        },
      });

      await claimReview(prisma, {
        merchantId: seeded.obligation.merchantId,
        attemptId: seeded.attempt.id,
        reviewerId: 'admin_1',
      });
      await attachEvidenceReference(prisma, {
        merchantId: seeded.obligation.merchantId,
        attemptId: seeded.attempt.id,
        reviewerId: 'admin_1',
        reference: 'evidence://case/123',
      });

      const persisted = await loadAttempt(seeded.attempt.id);
      const review = await viewReview(prisma, {
        merchantId: seeded.obligation.merchantId,
        attemptId: seeded.attempt.id,
      });

      assert.equal(persisted.outcomeStatus, 'UNKNOWN');
      assert.equal(persisted.reviewStatus, 'IN_PROGRESS');
      assert.equal(persisted.resolvedAt, null);
      assert.deepEqual(
        review.history.map((entry) => ({
          priorReviewStatus: entry.priorReviewStatus,
          nextReviewStatus: entry.nextReviewStatus,
          actorId: entry.actorId,
          reasonCode: entry.reasonCode,
          evidenceReferenceIds: entry.evidenceReferenceIds,
        })),
        [
          {
            priorReviewStatus: 'REQUIRED',
            nextReviewStatus: 'IN_PROGRESS',
            actorId: 'admin_1',
            reasonCode: 'REVIEW_CLAIMED',
            evidenceReferenceIds: [],
          },
          {
            priorReviewStatus: 'IN_PROGRESS',
            nextReviewStatus: 'IN_PROGRESS',
            actorId: 'admin_1',
            reasonCode: 'EVIDENCE_REFERENCE_ATTACHED',
            evidenceReferenceIds: ['evidence://case/123'],
          },
        ],
      );
    });

    it('exposes only non-mutating review commands and keeps the manual evidence gate disabled', () => {
      assert.deepEqual(Object.keys(reviewService).sort(), [
        'attachEvidenceReference',
        'claimReview',
        'requestReadOnlyQuery',
        'viewReview',
      ]);
      assert.equal(MANUAL_EVIDENCE_EXCEPTION_GATE, false);
    });

    it('rejects evidence references that fail the PII policy and audits only the sanitized reason', async () => {
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: nextId('obligation_review_reject'),
          merchantId: namespace.id('merchant_review_reject'),
        },
        attempt: {
          id: nextId('attempt_review_reject'),
          reviewStatus: 'IN_PROGRESS',
          outcomeStatus: 'UNKNOWN',
          providerOrderRef: 'order_review_reject',
        },
      });

      await assert.rejects(
        attachEvidenceReference(prisma, {
          merchantId: seeded.obligation.merchantId,
          attemptId: seeded.attempt.id,
          reviewerId: 'admin_1',
          reference: 'buyer-email:user@example.test',
        }),
        /PROHIBITED_EVIDENCE_PII/,
      );

      assert.equal(
        await prisma.reconciliationReviewHistory.count({
          where: { attemptId: seeded.attempt.id },
        }),
        0,
      );

      const logs = await prisma.auditLog.findMany({
        where: {
          action: 'PGO1_REVIEW_INPUT_REJECTED',
          entityId: seeded.attempt.id,
        },
        select: { metadata: true },
      });

      assert.equal(logs.length, 1);
      const serialized = JSON.stringify(logs[0]?.metadata ?? {});
      assert.match(serialized, /PROHIBITED_EVIDENCE_PII/);
      assert.doesNotMatch(serialized, /buyer-email:user@example\.test/);
      assert.doesNotMatch(serialized, /example\.test/);
    });

    it('emits a read-only query request without changing outcomeStatus or resolvedAt', async () => {
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: nextId('obligation_review_query'),
          merchantId: namespace.id('merchant_review_query'),
        },
        attempt: {
          id: nextId('attempt_review_query'),
          reviewStatus: 'IN_PROGRESS',
          outcomeStatus: 'UNKNOWN',
          providerOrderRef: 'order_review_query',
        },
      });
      const before = await loadAttempt(seeded.attempt.id);

      const request = await requestReadOnlyQuery(prisma, {
        merchantId: seeded.obligation.merchantId,
        attemptId: seeded.attempt.id,
        reviewerId: 'admin_1',
        note: 'await reconciler pass',
      });

      const afterState = await loadAttempt(seeded.attempt.id);
      const history = await prisma.reconciliationReviewHistory.findMany({
        where: { attemptId: seeded.attempt.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      assert.equal(afterState.outcomeStatus, before.outcomeStatus);
      assert.equal(afterState.reviewStatus, before.reviewStatus);
      assert.equal(afterState.resolvedAt, before.resolvedAt);
      assert.deepEqual(
        {
          kind: request.kind,
          attemptId: request.attemptId,
          obligationId: request.obligationId,
          merchantId: request.merchantId,
          provider: request.provider,
          environment: request.environment,
          credentialBindingId: request.credentialBindingId,
          credentialVersionId: request.credentialVersionId,
          operation: request.operation,
          note: request.note,
        },
        {
          kind: 'READ_ONLY_QUERY_REQUESTED',
          attemptId: seeded.attempt.id,
          obligationId: seeded.obligation.id,
          merchantId: seeded.obligation.merchantId,
          provider: seeded.attempt.provider,
          environment: seeded.attempt.environment,
          credentialBindingId: seeded.attempt.credentialBindingId,
          credentialVersionId: seeded.attempt.credentialVersionId,
          operation: 'STATUS_QUERY',
          note: 'await reconciler pass',
        },
      );
      assert.equal(history.length, 1);
      assert.equal(history[0]?.priorReviewStatus, 'IN_PROGRESS');
      assert.equal(history[0]?.nextReviewStatus, 'IN_PROGRESS');
      assert.equal(history[0]?.reasonCode, 'READ_ONLY_QUERY_REQUESTED');
      assert.equal(history[0]?.actorId, 'admin_1');
      assert.equal(history[0]?.triggeringObservationId, null);
      assert.equal(history[0]?.completedByType, null);
      assert.equal(history[0]?.correlationId, request.requestId);
      assert.deepEqual(history[0]?.evidenceReferenceIds, {
        references: [],
        note: 'await reconciler pass',
      });
    });

    it('rejects cross-merchant review access for claim, attach, request, and view', async () => {
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: nextId('obligation_cross_merchant'),
          merchantId: namespace.id('merchant_review_owner'),
        },
        attempt: {
          id: nextId('attempt_cross_merchant'),
          reviewStatus: 'REQUIRED',
          outcomeStatus: 'UNKNOWN',
          providerOrderRef: 'order_cross_merchant',
        },
      });

      await assert.rejects(
        claimReview(prisma, {
          merchantId: namespace.id('merchant_other'),
          attemptId: seeded.attempt.id,
          reviewerId: 'admin_1',
        }),
        /ATTEMPT_NOT_FOUND/,
      );

      await claimReview(prisma, {
        merchantId: seeded.obligation.merchantId,
        attemptId: seeded.attempt.id,
        reviewerId: 'admin_1',
      });

      await assert.rejects(
        attachEvidenceReference(prisma, {
          merchantId: namespace.id('merchant_other'),
          attemptId: seeded.attempt.id,
          reviewerId: 'admin_1',
          reference: 'evidence://case/789',
        }),
        /ATTEMPT_NOT_FOUND/,
      );
      await assert.rejects(
        requestReadOnlyQuery(prisma, {
          merchantId: namespace.id('merchant_other'),
          attemptId: seeded.attempt.id,
          reviewerId: 'admin_1',
          note: 'safe note',
        }),
        /ATTEMPT_NOT_FOUND/,
      );
      await assert.rejects(
        viewReview(prisma, {
          merchantId: namespace.id('merchant_other'),
          attemptId: seeded.attempt.id,
        }),
        /ATTEMPT_NOT_FOUND/,
      );

      const history = await prisma.reconciliationReviewHistory.findMany({
        where: { attemptId: seeded.attempt.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      assert.equal(history.length, 1);
      assert.equal(history[0]?.reasonCode, 'REVIEW_CLAIMED');
    });

    it('lets a late webhook enter the normal ingestion path only when verification material remains available', async () => {
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: nextId('obligation_late_webhook_verified'),
          merchantId: namespace.id('merchant_late_webhook_verified'),
        },
        attempt: {
          id: nextId('attempt_late_webhook_verified'),
          reviewStatus: 'NOT_REQUIRED',
          outcomeStatus: 'PENDING',
          providerOrderRef: 'order_late_webhook_verified',
          mappingVersion: 'late-webhook-mapping-v1',
        },
      });

      const result = await ingestRawObservation({
        parser: lateWebhookParser({
          providerOrderRef: seeded.attempt.providerOrderRef!,
        }),
        ingestionMode: 'MOCK_EXECUTABLE',
        retentionDecision: 'MOCK_SYNTHETIC',
        environment: 'TEST',
        source: 'WEBHOOK',
        securityContext: {
          merchantId: seeded.obligation.merchantId,
          obligationId: seeded.obligation.id,
          attemptId: seeded.attempt.id,
          credentialBindingId: seeded.attempt.credentialBindingId,
        },
        nextObservationId: () => nextId('observation'),
        resolveBinding: async () => ({
          attemptId: seeded.attempt.id,
          obligationId: seeded.obligation.id,
          merchantId: seeded.obligation.merchantId,
          credentialBindingId: seeded.attempt.credentialBindingId,
          credentialVersionId: seeded.attempt.credentialVersionId,
          bindingVerification: 'VERIFIED',
        }),
        verify: async () => 'VERIFIED',
        persistSecurityRejection: (evidence) => persistProviderSecurityRejection(prisma, evidence),
        persist: (candidate) => ingestObservation(prisma, candidate),
      }, rawWebhookInput('verified'));

      assert.ok(!('kind' in result));

      const persistedAttempt = await loadAttempt(seeded.attempt.id);
      const persistedObservation = await prisma.providerObservation.findUniqueOrThrow({
        where: { id: result.observationId },
      });

      assert.equal(result.outcomeStatus, 'SUCCEEDED');
      assert.equal(persistedObservation.source, 'WEBHOOK');
      assert.equal(persistedObservation.signatureVerification, 'VERIFIED');
      assert.notEqual(persistedAttempt.resolvedAt, null);
    });

    it('fails closed for a late webhook when verification material is unavailable and exposes no manual override path', async () => {
      const seeded = await createAttemptWithObligation({
        obligation: {
          id: nextId('obligation_late_webhook_unavailable'),
          merchantId: namespace.id('merchant_late_webhook_unavailable'),
        },
        attempt: {
          id: nextId('attempt_late_webhook_unavailable'),
          reviewStatus: 'REQUIRED',
          outcomeStatus: 'UNKNOWN',
          providerOrderRef: 'order_late_webhook_unavailable',
        },
      });

      let verification: 'VERIFIED' | 'FAILED' | 'NOT_APPLICABLE' | 'UNAVAILABLE' | null = null;
      const result = await ingestRawObservation({
        parser: lateWebhookParser({
          providerOrderRef: seeded.attempt.providerOrderRef!,
          mappedOutcome: 'PENDING',
        }),
        ingestionMode: 'MOCK_EXECUTABLE',
        retentionDecision: 'MOCK_SYNTHETIC',
        environment: 'TEST',
        source: 'WEBHOOK',
        securityContext: {
          merchantId: seeded.obligation.merchantId,
          obligationId: seeded.obligation.id,
          attemptId: seeded.attempt.id,
          credentialBindingId: seeded.attempt.credentialBindingId,
        },
        nextObservationId: () => nextId('observation'),
        resolveBinding: async () => ({
          attemptId: seeded.attempt.id,
          obligationId: seeded.obligation.id,
          merchantId: seeded.obligation.merchantId,
          credentialBindingId: seeded.attempt.credentialBindingId,
          credentialVersionId: seeded.attempt.credentialVersionId,
          bindingVerification: 'VERIFIED',
        }),
        verify: async () => {
          verification = 'UNAVAILABLE';
          return verification;
        },
        persistSecurityRejection: (evidence) => persistProviderSecurityRejection(prisma, evidence),
        persist: (candidate) => ingestObservation(prisma, candidate),
      }, rawWebhookInput('unavailable'));

      const persistedAttempt = await loadAttempt(seeded.attempt.id);

      assert.equal(verification, 'UNAVAILABLE');
      assert.deepEqual(result, {
        kind: 'REJECTED',
        reason: 'UNAUTHENTICATED',
      });
      assert.equal(persistedAttempt.outcomeStatus, 'UNKNOWN');
      assert.equal(persistedAttempt.reviewStatus, 'REQUIRED');
      assert.equal(persistedAttempt.resolvedAt, null);
      assert.equal(
        await prisma.providerObservation.count({
          where: { attemptId: seeded.attempt.id },
        }),
        0,
      );
      assert.partialDeepStrictEqual(
        await prisma.providerObservationRejection.findFirstOrThrow({
          where: { merchantId: seeded.obligation.merchantId, attemptId: seeded.attempt.id },
        }),
        {
          reason: 'UNAUTHENTICATED',
          securityAlertCode: 'INVALID_PROVIDER_SIGNATURE',
          securityAlertStatus: 'PENDING',
          rawBodyHash: createHash('sha256').update(rawWebhookInput('unavailable').rawBody).digest('hex'),
        },
      );
      assert.deepEqual(Object.keys(reviewService).sort(), [
        'attachEvidenceReference',
        'claimReview',
        'requestReadOnlyQuery',
        'viewReview',
      ]);
    });

    it('lets the evidence horizon convene governance and nothing else', () => {
      assert.deepEqual(
        evaluateEvidenceHorizonGovernanceTrigger({
          horizonExceeded: false,
          everyMachineChannelExhausted: true,
          credibleRealMoneyExposure: true,
        }),
        { convene: false },
      );

      assert.deepEqual(
        evaluateEvidenceHorizonGovernanceTrigger({
          horizonExceeded: true,
          everyMachineChannelExhausted: true,
          credibleRealMoneyExposure: true,
        }),
        {
          convene: true,
          paymentStateMutation: false,
          unlockProvider: false,
          replayAllowed: false,
          dualControlActivated: false,
        },
      );
    });
  });
}
