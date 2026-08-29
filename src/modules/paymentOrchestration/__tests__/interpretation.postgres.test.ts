import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { PrismaClient, type Prisma } from '@prisma/client';
import { appendDerivedInterpretation } from '../interpretation.js';
import { expectedScratchDatabaseNameFromEnv } from './scratchDatabaseGuard.js';
import { createPaymentPostgresNamespace } from './postgresTestNamespace.js';

const enabled = process.env.RUN_PGO1_POSTGRES_TESTS === '1';
const prisma = new PrismaClient();
const namespace = createPaymentPostgresNamespace('interpretation');
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
    provider: overrides.provider ?? 'CASHFREE',
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
    adapterVersion: overrides.adapterVersion ?? 'cashfree-adapter-old',
    mappingVersion: overrides.mappingVersion ?? 'cashfree-map-old',
  };
}

function observation(
  overrides: Partial<Prisma.ProviderObservationUncheckedCreateInput> = {},
): Prisma.ProviderObservationUncheckedCreateInput {
  const merchantId = overrides.merchantId ?? nextId('merchant');
  const obligationId = overrides.obligationId ?? nextId('obligation');
  const attemptId = overrides.attemptId ?? nextId('attempt');
  return {
    id: overrides.id ?? nextId('observation'),
    attemptId,
    obligationId,
    merchantId,
    provider: overrides.provider ?? 'CASHFREE',
    environment: overrides.environment ?? 'TEST',
    credentialBindingId: overrides.credentialBindingId ?? nextId('binding'),
    credentialVersionId: overrides.credentialVersionId ?? nextId('credential_version'),
    source: overrides.source ?? 'WEBHOOK',
    providerEventId: overrides.providerEventId ?? nextId('provider_event'),
    providerOrderRef: overrides.providerOrderRef ?? nextId('provider_order'),
    providerTransactionRef: overrides.providerTransactionRef ?? nextId('provider_txn'),
    nativeStatus: overrides.nativeStatus ?? 'SUCCESS',
    nativeReasonCode: overrides.nativeReasonCode ?? null,
    nativeAmountText: overrides.nativeAmountText ?? '100.00',
    nativeCurrency: overrides.nativeCurrency ?? 'INR',
    amountPaise: overrides.amountPaise ?? 10_000n,
    rawBodyHash: overrides.rawBodyHash ?? nextId('hash'),
    hashAlgorithm: overrides.hashAlgorithm ?? 'SHA_256',
    signatureVerification: overrides.signatureVerification ?? 'VERIFIED',
    bindingVerification: overrides.bindingVerification ?? 'VERIFIED',
    evidenceAuthority: overrides.evidenceAuthority ?? 'ACTIVATION_GATED',
    mappedOutcome: overrides.mappedOutcome ?? 'SUCCEEDED',
    adapterVersion: overrides.adapterVersion ?? 'cashfree-adapter-old',
    mappingVersion: overrides.mappingVersion ?? 'cashfree-map-old',
    providerApiVersion: overrides.providerApiVersion ?? 'cashfree-api-2023-08-01',
    providerOccurredAt: overrides.providerOccurredAt ?? new Date('2026-08-27T12:00:00.000Z'),
    receivedAt: overrides.receivedAt ?? new Date('2026-08-27T12:00:01.000Z'),
    reductionDisposition: overrides.reductionDisposition ?? 'UNREDUCED',
    observationDedupeKey: overrides.observationDedupeKey ?? nextId('observation_dedupe'),
  };
}

if (enabled) {
  describe('appendDerivedInterpretation PostgreSQL persistence', () => {
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

    it('appends an idempotent derived interpretation while preserving the original observation', async () => {
      const obligationRow = await prisma.paymentObligation.create({
        data: obligation({
          id: namespace.id('obligation_interpretation'),
          merchantId: namespace.id('merchant_interpretation'),
        }),
      });
      const providerOrderRef = 'cf_order_interpretation';
      const attemptRow = await prisma.paymentAttempt.create({
        data: attempt({
          id: namespace.id('attempt_interpretation'),
          merchantId: obligationRow.merchantId,
          obligationId: obligationRow.id,
          obligationCollectionRail: obligationRow.collectionRail,
          providerOrderRef,
        }),
      });
      const originalObservation = await prisma.providerObservation.create({
        data: observation({
          id: namespace.id('observation_original_interpretation'),
          merchantId: obligationRow.merchantId,
          obligationId: obligationRow.id,
          attemptId: attemptRow.id,
          credentialBindingId: attemptRow.credentialBindingId,
          credentialVersionId: attemptRow.credentialVersionId,
          providerOrderRef,
          rawBodyHash: namespace.id('hash_original_interpretation'),
          observationDedupeKey: namespace.id('dedupe_original_interpretation'),
          adapterVersion: 'cashfree-adapter-old',
          mappingVersion: 'cashfree-map-old',
          mappedOutcome: 'SUCCEEDED',
          providerApiVersion: 'cashfree-api-2022-09-01',
          reductionDisposition: 'UNREDUCED',
        }),
      });
      const originalSnapshot = await prisma.providerObservation.findUniqueOrThrow({
        where: { id: originalObservation.id },
      });
      const derivedAt = new Date('2026-08-28T06:00:00.000Z');

      const first = await prisma.$transaction((tx) =>
        appendDerivedInterpretation(tx, {
          original: {
            id: originalObservation.id,
            merchantId: originalObservation.merchantId,
            obligationId: originalObservation.obligationId,
            attemptId: originalObservation.attemptId,
            mappingVersion: originalObservation.mappingVersion,
            nativeStatus: originalObservation.nativeStatus,
          },
          derivedAdapterVersion: 'cashfree-contract-fixture-v1',
          derivedMappingVersion: 'cashfree-fixture-map-v1',
          derivedAt,
          map(nativeStatus) {
            return nativeStatus === 'SUCCESS' ? 'SUCCEEDED' : 'UNMAPPED';
          },
        }),
      );
      const replay = await prisma.$transaction((tx) =>
        appendDerivedInterpretation(tx, {
          original: {
            id: originalObservation.id,
            merchantId: originalObservation.merchantId,
            obligationId: originalObservation.obligationId,
            attemptId: originalObservation.attemptId,
            mappingVersion: originalObservation.mappingVersion,
            nativeStatus: originalObservation.nativeStatus,
          },
          derivedAdapterVersion: 'cashfree-contract-fixture-v1',
          derivedMappingVersion: 'cashfree-fixture-map-v1',
          derivedAt,
          map(nativeStatus) {
            return nativeStatus === 'SUCCESS' ? 'SUCCEEDED' : 'UNMAPPED';
          },
        }),
      );

      assert.equal(first.id, replay.id);
      assert.equal(await prisma.providerObservationInterpretation.count({
        where: { merchantId: obligationRow.merchantId },
      }), 1);
      assert.deepEqual(
        await prisma.providerObservation.findUniqueOrThrow({ where: { id: originalObservation.id } }),
        originalSnapshot,
      );
      assert.deepEqual(
        {
          originalObservationId: first.originalObservationId,
          merchantId: first.merchantId,
          obligationId: first.obligationId,
          attemptId: first.attemptId,
          originalMappingVersion: first.originalMappingVersion,
          derivedAdapterVersion: first.derivedAdapterVersion,
          derivedMappingVersion: first.derivedMappingVersion,
          derivedOutcome: first.derivedOutcome,
          derivedAt: first.derivedAt,
        },
        {
          originalObservationId: originalObservation.id,
          merchantId: obligationRow.merchantId,
          obligationId: obligationRow.id,
          attemptId: attemptRow.id,
          originalMappingVersion: 'cashfree-map-old',
          derivedAdapterVersion: 'cashfree-contract-fixture-v1',
          derivedMappingVersion: 'cashfree-fixture-map-v1',
          derivedOutcome: 'SUCCEEDED',
          derivedAt,
        },
      );
    });
  });
}
