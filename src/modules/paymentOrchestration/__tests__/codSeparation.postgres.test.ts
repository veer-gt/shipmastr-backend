import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
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
  assert.equal(decodeURIComponent(url.pathname.slice(1)), 'shipmastr_scratch_pgo1_a965f431');
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

if (enabled) {
  describe('payment obligation COD separation and ownership', () => {
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

    it('persists partial COD obligations as separate authoritative rows', async () => {
      const merchantId = 'merchant_cod';
      const checkoutId = 'checkout_cod';
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
      const merchantId = 'merchant_cod';
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
            merchantId: 'merchant_invalid',
            id: 'obligation_invalid',
            collectionRail: 'COD',
            purpose: 'FULL_ONLINE',
          }),
        }),
      );
    });

    it('returns obligation not found for cross-merchant coordinator and repository reads', async () => {
      const owningMerchantId = 'merchant_owner';
      const otherMerchantId = 'merchant_other';
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
  });
}
