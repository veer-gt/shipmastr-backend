import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  createAttempt,
  type AttemptCreationResult,
  type CreateAttemptInput,
} from '../attemptCoordinator.js';
import { expectedScratchDatabaseNameFromEnv } from './scratchDatabaseGuard.js';
import type { ProviderActivationPolicy } from '../types.js';

const enabled = process.env.RUN_PGO1_POSTGRES_TESTS === '1';
const prisma = new PrismaClient();

let sequence = 0;

function nextId(prefix: string) {
  sequence += 1;
  return `${prefix}_${sequence}`;
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

function isPrismaCode(error: unknown, code: string): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
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

async function createObligation(
  overrides: Partial<Prisma.PaymentObligationUncheckedCreateInput> = {},
) {
  const data = obligation(overrides);
  return prisma.paymentObligation.create({ data });
}

function directAttemptData(
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
    providerOrderRef: overrides.providerOrderRef ?? null,
    outcomeStatus: overrides.outcomeStatus ?? 'PENDING',
    reviewStatus: overrides.reviewStatus ?? 'NOT_REQUIRED',
    resolvedAt: overrides.resolvedAt ?? null,
    lastOutcomeChangedAt: overrides.lastOutcomeChangedAt ?? new Date('2026-08-27T12:00:00.000Z'),
    lastObservationAt: overrides.lastObservationAt ?? null,
    adapterVersion: overrides.adapterVersion ?? 'direct-insert-v1',
    mappingVersion: overrides.mappingVersion ?? 'direct-insert-v1',
  };
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
  };
}

function requestFactory(base: { merchantId: string; obligationId: string; amountPaise: bigint }) {
  return (
    overrides: Partial<
      Omit<
        CreateAttemptInput,
        'merchantId' | 'obligationId' | 'amountPaise' | 'provider' | 'environment' | 'operation'
      >
    > = {},
    options: { withoutPolicy?: boolean } = {},
  ): CreateAttemptInput => {
    const input: CreateAttemptInput = {
      merchantId: base.merchantId,
      obligationId: base.obligationId,
      provider: 'MOCK',
      environment: 'TEST',
      operation: 'CREATE_ATTEMPT',
      amountPaise: base.amountPaise,
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

function value(result: PromiseSettledResult<AttemptCreationResult>) {
  assert.equal(result.status, 'fulfilled');
  return result.value;
}

async function insertUnresolvedAttemptDirect(
  client: PrismaClient,
  data: Prisma.PaymentAttemptUncheckedCreateInput,
) {
  return client.$transaction(async (tx) => tx.paymentAttempt.create({ data }));
}

if (enabled) {
  describe('createAttempt PostgreSQL coordination', () => {
    before(async () => {
      const url = assertScratchUrl();
      const current = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
      assert.equal(current[0]?.name, decodeURIComponent(url.pathname.slice(1)));
    });

    beforeEach(async () => {
      await clearPaymentTables(prisma);
    });

    after(async () => {
      await prisma.$disconnect();
    });

    it('serializes two different requests and creates one unresolved attempt', async () => {
      const merchantId = 'm_1';
      const obligationRow = await createObligation({
        id: 'obligation_serialized',
        merchantId,
        amountPaise: 12_500n,
      });
      const request = requestFactory({
        merchantId,
        obligationId: obligationRow.id,
        amountPaise: obligationRow.amountPaise,
      });

      const [left, right] = await Promise.allSettled([
        createAttempt(prisma, request({ requestIdempotencyKey: 'r_left' })),
        createAttempt(prisma, request({ requestIdempotencyKey: 'r_right' })),
      ]);

      assert.deepEqual([left.status, right.status].sort(), ['fulfilled', 'fulfilled']);
      assert.equal(
        await prisma.paymentAttempt.count({
          where: { obligationId: obligationRow.id, resolvedAt: null },
        }),
        1,
      );
      assert.equal(
        [value(left), value(right)].filter((result) => result.kind === 'CREATED').length,
        1,
      );
      assert.equal(
        [value(left), value(right)].filter((result) => result.kind === 'EXISTING_UNRESOLVED').length,
        1,
      );
    });

    it('returns one logical result for the same request key', async () => {
      const merchantId = 'm_1';
      const obligationRow = await createObligation({
        id: 'obligation_same_key',
        merchantId,
        amountPaise: 17_500n,
      });
      const request = requestFactory({
        merchantId,
        obligationId: obligationRow.id,
        amountPaise: obligationRow.amountPaise,
      });

      const [left, right] = await Promise.all([
        createAttempt(prisma, request({ requestIdempotencyKey: 'same' })),
        createAttempt(prisma, request({ requestIdempotencyKey: 'same' })),
      ]);

      assert.equal(left.attempt.id, right.attempt.id);
      assert.deepEqual([left.kind, right.kind].sort(), ['CREATED', 'IDEMPOTENT_REPLAY']);
      assert.equal(
        await prisma.paymentAttempt.count({
          where: { merchantId, requestIdempotencyKey: 'same' },
        }),
        1,
      );
    });

    it('rejects reuse of a merchant idempotency key for another obligation', async () => {
      const merchantId = 'm_1';
      const obligationA = await createObligation({
        id: 'obligation_conflict_a',
        merchantId,
        amountPaise: 10_000n,
      });
      const obligationB = await createObligation({
        id: 'obligation_conflict_b',
        merchantId,
        amountPaise: 11_000n,
      });

      await createAttempt(
        prisma,
        requestFactory({
          merchantId,
          obligationId: obligationA.id,
          amountPaise: obligationA.amountPaise,
        })({ requestIdempotencyKey: 'same' }),
      );

      await assert.rejects(
        createAttempt(
          prisma,
          requestFactory({
            merchantId,
            obligationId: obligationB.id,
            amountPaise: obligationB.amountPaise,
          })({ requestIdempotencyKey: 'same' }),
        ),
        /IDEMPOTENCY_KEY_CONFLICT/,
      );
      assert.equal(await prisma.paymentAttempt.count({ where: { obligationId: obligationB.id } }), 0);
    });

    it('maps a concurrent same-key and different-obligation race to the same conflict', async () => {
      const merchantId = 'm_1';
      const obligationA = await createObligation({
        id: 'obligation_race_a',
        merchantId,
        amountPaise: 14_000n,
      });
      const obligationB = await createObligation({
        id: 'obligation_race_b',
        merchantId,
        amountPaise: 15_000n,
      });

      const results = await Promise.allSettled([
        createAttempt(
          prisma,
          requestFactory({
            merchantId,
            obligationId: obligationA.id,
            amountPaise: obligationA.amountPaise,
          })({ requestIdempotencyKey: 'raced' }),
        ),
        createAttempt(
          prisma,
          requestFactory({
            merchantId,
            obligationId: obligationB.id,
            amountPaise: obligationB.amountPaise,
          })({ requestIdempotencyKey: 'raced' }),
        ),
      ]);

      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      assert.ok(rejected?.reason instanceof Error);
      assert.equal(rejected.reason.message, 'IDEMPOTENCY_KEY_CONFLICT');
      assert.equal(
        await prisma.paymentAttempt.count({
          where: { merchantId, requestIdempotencyKey: 'raced' },
        }),
        1,
      );
    });

    it('returns the existing unresolved attempt before evaluating a now-disabled policy', async () => {
      const merchantId = 'm_1';
      const obligationRow = await createObligation({
        id: 'obligation_existing',
        merchantId,
        amountPaise: 21_000n,
      });
      const request = requestFactory({
        merchantId,
        obligationId: obligationRow.id,
        amountPaise: obligationRow.amountPaise,
      });

      const existing = await createAttempt(prisma, request({ requestIdempotencyKey: 'first' }));
      const result = await createAttempt(
        prisma,
        request({ requestIdempotencyKey: 'second' }, { withoutPolicy: true }),
      );

      assert.partialDeepStrictEqual(result, {
        kind: 'EXISTING_UNRESOLVED',
        attempt: { id: existing.attempt.id },
      });
    });

    it('fails disabled before touching the provider', async () => {
      const merchantId = 'm_1';
      const obligationRow = await createObligation({
        id: 'obligation_disabled',
        merchantId,
        amountPaise: 18_000n,
      });
      const request = requestFactory({
        merchantId,
        obligationId: obligationRow.id,
        amountPaise: obligationRow.amountPaise,
      });

      await assert.rejects(
        createAttempt(prisma, request({ requestIdempotencyKey: 'disabled' }, { withoutPolicy: true })),
        /PROVIDER_POLICY_DISABLED/,
      );
      assert.equal(createAttempt.length, 2);
      assert.equal(await prisma.paymentAttempt.count({ where: { obligationId: obligationRow.id } }), 0);
    });

    it('evaluates policy against the authoritative obligation amount', async () => {
      const merchantId = 'm_1';
      const obligationRow = await createObligation({
        id: 'obligation_authoritative_amount',
        merchantId,
        amountPaise: 20_000n,
      });

      await assert.rejects(
        createAttempt(
          prisma,
          requestFactory({
            merchantId,
            obligationId: obligationRow.id,
            amountPaise: 10_000n,
          })({
            requestIdempotencyKey: 'understated_amount',
            policy: activationPolicy(merchantId, 10_000n),
          }),
        ),
        /PROVIDER_POLICY_DISABLED/,
      );
      assert.equal(
        await prisma.paymentAttempt.count({
          where: { obligationId: obligationRow.id },
        }),
        0,
      );
    });

    it('proves the unique index independently of the service lock', async () => {
      const merchantId = 'm_1';
      const obligationRow = await createObligation({
        id: 'obligation_direct_index',
        merchantId,
        amountPaise: 19_000n,
      });
      const leftClient = new PrismaClient();
      const rightClient = new PrismaClient();

      try {
        const results = await Promise.allSettled([
          insertUnresolvedAttemptDirect(
            leftClient,
            directAttemptData({
              id: 'direct_left',
              merchantId,
              obligationId: obligationRow.id,
              requestIdempotencyKey: 'direct_left',
            }),
          ),
          insertUnresolvedAttemptDirect(
            rightClient,
            directAttemptData({
              id: 'direct_right',
              merchantId,
              obligationId: obligationRow.id,
              requestIdempotencyKey: 'direct_right',
            }),
          ),
        ]);

        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        const rejected = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        assert.ok(rejected);
        assert.ok(isPrismaCode(rejected.reason, 'P2002'));
        assert.equal(
          await prisma.paymentAttempt.count({
            where: { obligationId: obligationRow.id, resolvedAt: null },
          }),
          1,
        );
      } finally {
        await Promise.all([leftClient.$disconnect(), rightClient.$disconnect()]);
      }
    });
  });
}
