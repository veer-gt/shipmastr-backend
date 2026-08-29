import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  createAttempt,
  type CreateAttemptInput,
} from '../attemptCoordinator.js';
import {
  createCheckoutObligations,
  type CheckoutOwnershipReader,
} from '../obligationService.js';
import {
  getOwnedAttemptForObligationOrThrow,
  getOwnedObligationOrThrow,
  listOwnedAttemptsForObligationOrThrow,
} from '../repository.js';
import { expectedScratchDatabaseNameFromEnv } from './scratchDatabaseGuard.js';
import { createPaymentPostgresNamespace } from './postgresTestNamespace.js';
import type {
  CanonicalObservation,
  ProviderActivationPolicy,
} from '../types.js';

const enabled = process.env.RUN_PGO1_POSTGRES_TESTS === '1';
const prisma = new PrismaClient();
const namespace = createPaymentPostgresNamespace('cod_separation');

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
  assert.equal(decodeURIComponent(url.pathname.slice(1)), expectedScratchDatabaseName());
  return url;
}

function expectedScratchDatabaseName() {
  return expectedScratchDatabaseNameFromEnv();
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

async function createObligation(
  overrides: Partial<Prisma.PaymentObligationUncheckedCreateInput> = {},
) {
  const data = obligation(overrides);
  return prisma.paymentObligation.create({ data });
}

function activationPolicy(merchantId: string, amountPaise: bigint): ProviderActivationPolicy {
  return {
    version: 'policy_v1',
    approved: true,
    merchantId,
    provider: 'MOCK',
    environment: 'TEST',
    operation: 'CREATE_ATTEMPT',
    maxAmountPaise: amountPaise,
    approvedAt: new Date('2026-08-27T00:00:00.000Z'),
    effectiveFrom: new Date('2026-08-27T00:00:00.000Z'),
    effectiveUntil: new Date('2030-01-01T00:00:00.000Z'),
  };
}

function requestFactory(base: { merchantId: string; obligationId: string; amountPaise: bigint }) {
  return (
    overrides: Partial<Omit<CreateAttemptInput, 'merchantId' | 'obligationId' | 'amountPaise' | 'provider' | 'environment' | 'operation'>> = {},
    options: { withoutPolicy?: boolean } = {},
  ): CreateAttemptInput => {
    const input: CreateAttemptInput = {
      merchantId: base.merchantId,
      obligationId: base.obligationId,
      provider: 'MOCK',
      environment: 'TEST',
      operation: 'CREATE_ATTEMPT',
      amountPaise: base.amountPaise,
      evaluatedAt: new Date('2026-08-28T00:00:00.000Z'),
      requestIdempotencyKey: overrides.requestIdempotencyKey ?? nextId('request'),
      credentialBindingId: overrides.credentialBindingId ?? nextId('binding'),
      credentialVersionId: overrides.credentialVersionId ?? nextId('credential_version'),
      policy: activationPolicy(base.merchantId, base.amountPaise),
    };

    Object.assign(input, overrides);
    if (options.withoutPolicy) {
      delete (input as { policy?: ProviderActivationPolicy }).policy;
    }
    return input;
  };
}

function ownershipReaderFor(merchantId: string, checkoutId: string): CheckoutOwnershipReader {
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

type IngestObservation = (
  client: PrismaClient,
  candidate: ObservationCandidate,
) => Promise<IngestionResult>;

type ObservationCandidate = CanonicalObservation;

interface IngestionResult {
  observationId: string;
  disposition: string;
  outcomeStatus: 'PENDING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED_TERMINAL' | 'NOT_FOUND_TERMINAL';
  reviewStatus: 'NOT_REQUIRED' | 'REQUIRED' | 'IN_PROGRESS' | 'COMPLETED';
  resolvedAt: Date | null;
}

async function loadObservationService(): Promise<{ ingestObservation: IngestObservation }> {
  const modulePath = '../observationService.js';
  return import(modulePath) as Promise<{ ingestObservation: IngestObservation }>;
}

function directAttempt(
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

function observationCandidate(
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
    nativeStatus?: string;
  },
  overrides: Partial<CanonicalObservation> = {},
): CanonicalObservation {
  return {
    id: overrides.id ?? nextId('observation'),
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
    nativeStatus: input.nativeStatus ?? 'captured',
    nativeReasonCode: null,
    amountPaise: 10_000n,
    nativeAmountText: '100.00',
    nativeCurrency: 'INR',
    rawBodyHash: overrides.rawBodyHash ?? nextId('hash'),
    hashAlgorithm: 'SHA-256',
    signatureVerification: 'NOT_APPLICABLE',
    bindingVerification: 'VERIFIED',
    evidenceAuthority: 'ELIGIBLE',
    mappedOutcome: input.mappedOutcome ?? 'SUCCEEDED',
    adapterVersion: 'test-adapter-v1',
    mappingVersion: 'test-mapping-v1',
    providerApiVersion: 'mock-2026-08-27',
    providerOccurredAt: new Date('2026-08-27T12:00:00.000Z'),
    receivedAt: new Date('2026-08-27T12:00:01.000Z'),
    reductionDisposition: 'ACCEPTED',
    ...overrides,
  };
}

async function seedPartialCodCheckout() {
  const merchantId = nextId('merchant_cod_pair');
  const checkoutId = nextId('checkout_cod_pair');
  const online = await prisma.paymentObligation.create({
    data: obligation({
      id: nextId('obligation_online'),
      merchantId,
      checkoutId,
      collectionRail: 'ONLINE',
      purpose: 'COD_ADVANCE',
      amountPaise: 10_000n,
    }),
  });
  const cod = await prisma.paymentObligation.create({
    data: obligation({
      id: nextId('obligation_cod'),
      merchantId,
      checkoutId,
      collectionRail: 'COD',
      purpose: 'COD_DELIVERY_BALANCE',
      amountPaise: 40_000n,
    }),
  });
  const onlineAttempt = await prisma.paymentAttempt.create({
    data: directAttempt({
      id: nextId('attempt_online'),
      merchantId,
      obligationId: online.id,
      obligationCollectionRail: online.collectionRail,
      providerOrderRef: nextId('order_online'),
    }),
  });

  return { online, cod, onlineAttempt };
}

async function codSnapshot(obligationId: string) {
  const [obligationRow, transitions, reviews, attention, facts, cases, observations, deliveries] = await Promise.all([
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
    obligation: obligationRow,
    transitions,
    reviews,
    attention,
    facts,
    cases,
    observations,
    deliveries,
  };
}

if (enabled) {
  describe('payment obligation COD separation and ownership', () => {
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

    it('persists partial COD obligations as separate authoritative rows', async () => {
      const merchantId = namespace.id('merchant_cod');
      const checkoutId = namespace.id('checkout_cod');
      const result = await prisma.$transaction((tx) =>
        createCheckoutObligations(
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

      const rows = await prisma.paymentObligation.findMany({
        where: { merchantId, checkoutId },
        orderBy: { collectionRail: 'asc' },
      });

      assert.equal(rows.length, 2);
      assert.notEqual(result.online.id, result.cod?.id);
      assert.deepEqual(
        rows.map((row) => ({
          id: row.id,
          amountPaise: row.amountPaise,
          collectionRail: row.collectionRail,
          purpose: row.purpose,
        })),
        [
          {
            id: result.online.id,
            amountPaise: 20_000n,
            collectionRail: 'ONLINE',
            purpose: 'COD_ADVANCE',
          },
          {
            id: result.cod!.id,
            amountPaise: 80_000n,
            collectionRail: 'COD',
            purpose: 'COD_DELIVERY_BALANCE',
          },
        ],
      );
    });

    it('rejects a COD-rail obligation before policy evaluation', async () => {
      const merchantId = namespace.id('merchant_cod');
      const codObligation = await createObligation({
        id: 'obligation_cod_only',
        merchantId,
        collectionRail: 'COD',
        purpose: 'COD_DELIVERY_BALANCE',
        amountPaise: 80_000n,
      });

      await assert.rejects(
        createAttempt(
          prisma,
          requestFactory({
            merchantId,
            obligationId: codObligation.id,
            amountPaise: codObligation.amountPaise,
          })({ requestIdempotencyKey: 'cod_disabled' }, { withoutPolicy: true }),
        ),
        /OBLIGATION_NOT_ATTEMPT_ELIGIBLE/,
      );
      assert.equal(await prisma.paymentAttempt.count({ where: { obligationId: codObligation.id } }), 0);
    });

    it('rejects malformed rail and purpose pairs in PostgreSQL', async () => {
      await assert.rejects(
        prisma.paymentObligation.create({
          data: obligation({
            merchantId: namespace.id('merchant_invalid'),
            id: 'obligation_invalid',
            collectionRail: 'COD',
            purpose: 'FULL_ONLINE',
          }),
        }),
      );
    });

    it('returns obligation not found for cross-merchant coordinator and repository reads', async () => {
      const owningMerchantId = namespace.id('merchant_owner');
      const otherMerchantId = namespace.id('merchant_other');
      const obligationRow = await createObligation({
        id: 'obligation_owned',
        merchantId: owningMerchantId,
        amountPaise: 16_000n,
      });
      const created = await createAttempt(
        prisma,
        requestFactory({
          merchantId: owningMerchantId,
          obligationId: obligationRow.id,
          amountPaise: obligationRow.amountPaise,
        })({ requestIdempotencyKey: 'owner_only' }),
      );

      await assert.rejects(
        createAttempt(
          prisma,
          requestFactory({
            merchantId: otherMerchantId,
            obligationId: obligationRow.id,
            amountPaise: obligationRow.amountPaise,
          })({ requestIdempotencyKey: 'cross_merchant' }),
        ),
        /OBLIGATION_NOT_FOUND/,
      );
      await assert.rejects(
        getOwnedObligationOrThrow(prisma, otherMerchantId, obligationRow.id),
        /OBLIGATION_NOT_FOUND/,
      );
      await assert.rejects(
        listOwnedAttemptsForObligationOrThrow(prisma, otherMerchantId, obligationRow.id),
        /OBLIGATION_NOT_FOUND/,
      );
      await assert.rejects(
        getOwnedAttemptForObligationOrThrow(
          prisma,
          otherMerchantId,
          obligationRow.id,
          created.attempt.id,
        ),
        /OBLIGATION_NOT_FOUND/,
      );
      assert.equal(
        await prisma.paymentObligation.count({ where: { merchantId: owningMerchantId } }),
        1,
      );
      assert.equal(
        await prisma.paymentAttempt.count({ where: { merchantId: owningMerchantId } }),
        1,
      );
    });

    for (const testCase of [
      {
        name: 'online unknown leaves COD snapshot unchanged',
        build: (state: Awaited<ReturnType<typeof seedPartialCodCheckout>>) =>
          observationCandidate({
            attemptId: state.onlineAttempt.id,
            obligationId: state.online.id,
            merchantId: state.online.merchantId,
            credentialBindingId: state.onlineAttempt.credentialBindingId,
            credentialVersionId: state.onlineAttempt.credentialVersionId,
            providerOrderRef: state.onlineAttempt.providerOrderRef!,
            providerEventId: 'event_cod_unknown',
            providerTransactionRef: null,
            mappedOutcome: 'UNKNOWN',
            nativeStatus: 'review',
          }),
      },
      {
        name: 'terminal failure leaves COD snapshot unchanged',
        build: (state: Awaited<ReturnType<typeof seedPartialCodCheckout>>) =>
          observationCandidate({
            attemptId: state.onlineAttempt.id,
            obligationId: state.online.id,
            merchantId: state.online.merchantId,
            credentialBindingId: state.onlineAttempt.credentialBindingId,
            credentialVersionId: state.onlineAttempt.credentialVersionId,
            providerOrderRef: state.onlineAttempt.providerOrderRef!,
            providerEventId: 'event_cod_failure',
            providerTransactionRef: null,
            mappedOutcome: 'FAILED_TERMINAL',
            nativeStatus: 'failed',
          }),
      },
      {
        name: 'late success refund-due leaves COD snapshot unchanged',
        setup: async (state: Awaited<ReturnType<typeof seedPartialCodCheckout>>) => {
          await prisma.paymentObligation.update({
            where: { id: state.online.id },
            data: { status: 'EXPIRED' },
          });
        },
        build: (state: Awaited<ReturnType<typeof seedPartialCodCheckout>>) =>
          observationCandidate({
            attemptId: state.onlineAttempt.id,
            obligationId: state.online.id,
            merchantId: state.online.merchantId,
            credentialBindingId: state.onlineAttempt.credentialBindingId,
            credentialVersionId: state.onlineAttempt.credentialVersionId,
            providerOrderRef: state.onlineAttempt.providerOrderRef!,
            providerEventId: 'event_cod_late_success',
            providerTransactionRef: 'txn_cod_late_success',
            mappedOutcome: 'SUCCEEDED',
          }),
      },
      {
        name: 'distinct double success leaves COD snapshot unchanged',
        setup: async (state: Awaited<ReturnType<typeof seedPartialCodCheckout>>) => {
          const priorAttempt = await prisma.paymentAttempt.create({
            data: directAttempt({
              id: nextId('attempt_prior_success'),
              merchantId: state.online.merchantId,
              obligationId: state.online.id,
              obligationCollectionRail: state.online.collectionRail,
              providerOrderRef: nextId('order_prior_success'),
              outcomeStatus: 'SUCCEEDED',
              reviewStatus: 'COMPLETED',
              resolvedAt: new Date('2026-08-27T11:00:00.000Z'),
            }),
          });
          await prisma.paymentObligation.update({
            where: { id: state.online.id },
            data: { status: 'SATISFIED', satisfiedAt: new Date('2026-08-27T11:00:01.000Z') },
          });
          await prisma.providerObservation.create({
            data: {
              id: nextId('prior_observation'),
              attemptId: priorAttempt.id,
              obligationId: state.online.id,
              merchantId: state.online.merchantId,
              provider: 'MOCK',
              environment: 'TEST',
              credentialBindingId: priorAttempt.credentialBindingId,
              credentialVersionId: priorAttempt.credentialVersionId,
              source: 'MOCK',
              providerEventId: 'event_prior_success',
              providerOrderRef: priorAttempt.providerOrderRef,
              providerTransactionRef: 'txn_prior_success',
              nativeStatus: 'captured',
              nativeReasonCode: null,
              nativeAmountText: '100.00',
              nativeCurrency: 'INR',
              amountPaise: 10_000n,
              rawBodyHash: nextId('hash'),
              hashAlgorithm: 'SHA_256',
              signatureVerification: 'NOT_APPLICABLE',
              bindingVerification: 'VERIFIED',
              evidenceAuthority: 'ELIGIBLE',
              mappedOutcome: 'SUCCEEDED',
              adapterVersion: 'test-adapter-v1',
              mappingVersion: 'test-mapping-v1',
              providerApiVersion: 'mock-2026-08-27',
              receivedAt: new Date('2026-08-27T11:00:02.000Z'),
              reductionDisposition: 'SUCCEEDED',
              observationDedupeKey: nextId('dedupe'),
            },
          });
        },
        build: (state: Awaited<ReturnType<typeof seedPartialCodCheckout>>) =>
          observationCandidate({
            attemptId: state.onlineAttempt.id,
            obligationId: state.online.id,
            merchantId: state.online.merchantId,
            credentialBindingId: state.onlineAttempt.credentialBindingId,
            credentialVersionId: state.onlineAttempt.credentialVersionId,
            providerOrderRef: state.onlineAttempt.providerOrderRef!,
            providerEventId: 'event_cod_double_success',
            providerTransactionRef: 'txn_cod_double_success',
            mappedOutcome: 'SUCCEEDED',
          }),
      },
    ] as const) {
      it(testCase.name, async () => {
        const { ingestObservation } = await loadObservationService();
        const state = await seedPartialCodCheckout();
        if (testCase.setup) {
          await testCase.setup(state);
        }

        const beforeSnapshot = await codSnapshot(state.cod.id);
        await ingestObservation(prisma, testCase.build(state));
        const afterSnapshot = await codSnapshot(state.cod.id);

        assert.deepEqual(afterSnapshot, beforeSnapshot);
      });
    }

    it('rejects a COD obligation paired with an online attempt as an internal reference mismatch', async () => {
      const { ingestObservation } = await loadObservationService();
      const state = await seedPartialCodCheckout();
      const onlineBefore = await prisma.paymentObligation.findUniqueOrThrow({ where: { id: state.online.id } });
      const codBefore = await prisma.paymentObligation.findUniqueOrThrow({ where: { id: state.cod.id } });

      await assert.rejects(
        ingestObservation(
          prisma,
          observationCandidate({
            attemptId: state.onlineAttempt.id,
            obligationId: state.cod.id,
            merchantId: state.cod.merchantId,
            credentialBindingId: state.onlineAttempt.credentialBindingId,
            credentialVersionId: state.onlineAttempt.credentialVersionId,
            providerOrderRef: state.onlineAttempt.providerOrderRef!,
            providerEventId: 'event_cod_reference_mismatch',
            providerTransactionRef: null,
            mappedOutcome: 'FAILED_TERMINAL',
            nativeStatus: 'failed',
          }),
        ),
        /INTERNAL_REFERENCE_MISMATCH/,
      );

      assert.equal(await prisma.paymentOutcomeTransition.count({
        where: { merchantId: { startsWith: namespace.prefix } },
      }), 0);
      assert.deepEqual(
        await prisma.paymentObligation.findUniqueOrThrow({ where: { id: state.online.id } }),
        onlineBefore,
      );
      assert.deepEqual(
        await prisma.paymentObligation.findUniqueOrThrow({ where: { id: state.cod.id } }),
        codBefore,
      );
    });
  });
}
