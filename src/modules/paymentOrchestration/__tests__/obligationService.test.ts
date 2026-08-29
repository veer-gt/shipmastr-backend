import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PaymentObligation, Prisma } from '@prisma/client';
import {
  createCheckoutObligations,
  type CheckoutOwnershipReader,
  type CreateCheckoutObligationsInput,
} from '../obligationService.js';

type CreatedRow = Pick<
  PaymentObligation,
  'id' | 'merchantId' | 'checkoutId' | 'collectionRail' | 'purpose' | 'amountPaise' | 'currency' | 'status' | 'satisfiedAt'
>;

function makeTransactionClient() {
  let sequence = 0;
  const rows: CreatedRow[] = [];
  const ownershipCalls: Array<{ merchantId: string; checkoutId: string }> = [];

  const tx = {
    paymentObligation: {
      async create({ data }: { data: Prisma.PaymentObligationUncheckedCreateInput }) {
        sequence += 1;
        const row: CreatedRow = {
          id: `obligation_${sequence}`,
          merchantId: data.merchantId,
          checkoutId: data.checkoutId,
          collectionRail: data.collectionRail,
          purpose: data.purpose,
          amountPaise: BigInt(data.amountPaise),
          currency: data.currency,
          status: data.status,
          satisfiedAt:
            data.satisfiedAt == null
              ? null
              : data.satisfiedAt instanceof Date
                ? data.satisfiedAt
                : new Date(data.satisfiedAt),
        };
        rows.push(row);
        return row as PaymentObligation;
      },
    },
  };

  const ownershipReader: CheckoutOwnershipReader = {
    async assertOwned(_tx: Prisma.TransactionClient, merchantId: string, checkoutId: string) {
      ownershipCalls.push({ merchantId, checkoutId });
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    rows,
    ownershipCalls,
    ownershipReader,
  };
}

function partialCodInput(
  overrides: Partial<Extract<CreateCheckoutObligationsInput, { mode: 'PARTIAL_COD' }>> = {},
): Extract<CreateCheckoutObligationsInput, { mode: 'PARTIAL_COD' }> {
  return {
    merchantId: 'm_1',
    checkoutId: 'co_1',
    mode: 'PARTIAL_COD',
    onlineAdvancePaise: 20_000n,
    deliveryBalancePaise: 80_000n,
    currency: 'INR',
    ...overrides,
  };
}

describe('createCheckoutObligations', () => {
  it('creates distinct online advance and delivery-balance obligations', async () => {
    const harness = makeTransactionClient();

    const result = await createCheckoutObligations(harness.tx, harness.ownershipReader, partialCodInput());

    assert.deepEqual(harness.ownershipCalls, [{ merchantId: 'm_1', checkoutId: 'co_1' }]);
    assert.partialDeepStrictEqual(result.online, {
      merchantId: 'm_1',
      checkoutId: 'co_1',
      collectionRail: 'ONLINE',
      purpose: 'COD_ADVANCE',
      amountPaise: 20_000n,
      currency: 'INR',
      status: 'OPEN',
      satisfiedAt: null,
    });
    assert.partialDeepStrictEqual(result.cod, {
      merchantId: 'm_1',
      checkoutId: 'co_1',
      collectionRail: 'COD',
      purpose: 'COD_DELIVERY_BALANCE',
      amountPaise: 80_000n,
      currency: 'INR',
      status: 'OPEN',
      satisfiedAt: null,
    });
    assert.notEqual(result.online.id, result.cod?.id);
    assert.equal(harness.rows.length, 2);
  });

  it('creates one full-online obligation without a COD sibling', async () => {
    const harness = makeTransactionClient();

    const result = await createCheckoutObligations(harness.tx, harness.ownershipReader, {
      merchantId: 'm_2',
      checkoutId: 'co_2',
      mode: 'FULL_ONLINE',
      fullOnlinePaise: 55_500n,
      currency: 'INR',
    });

    assert.partialDeepStrictEqual(result.online, {
      merchantId: 'm_2',
      checkoutId: 'co_2',
      collectionRail: 'ONLINE',
      purpose: 'FULL_ONLINE',
      amountPaise: 55_500n,
      currency: 'INR',
      status: 'OPEN',
      satisfiedAt: null,
    });
    assert.equal(result.cod, undefined);
    assert.equal(harness.rows.length, 1);
  });

  it('never recomputes checkout amounts', async () => {
    const harness = makeTransactionClient();

    await assert.rejects(
      createCheckoutObligations(
        harness.tx,
        harness.ownershipReader,
        partialCodInput({ onlineAdvancePaise: 0n, deliveryBalancePaise: 100_000n }),
      ),
      /INVALID_AUTHORITATIVE_OBLIGATION/,
    );

    assert.equal(harness.rows.length, 0);
  });

  it('rejects non-INR full-online obligations', async () => {
    const harness = makeTransactionClient();

    await assert.rejects(
      createCheckoutObligations(
        harness.tx,
        harness.ownershipReader,
        {
          merchantId: 'm_3',
          checkoutId: 'co_3',
          mode: 'FULL_ONLINE',
          fullOnlinePaise: 1_000n,
          currency: 'USD',
        } as unknown as CreateCheckoutObligationsInput,
      ),
      /INVALID_AUTHORITATIVE_OBLIGATION/,
    );
  });
});
