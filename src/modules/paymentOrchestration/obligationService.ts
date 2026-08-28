import type {
  CollectionRail,
  ObligationPurpose,
  PaymentObligation,
  Prisma,
} from '@prisma/client';

export type CreateCheckoutObligationsInput =
  | {
      merchantId: string;
      checkoutId: string;
      mode: 'FULL_ONLINE';
      fullOnlinePaise: bigint;
      currency: 'INR';
    }
  | {
      merchantId: string;
      checkoutId: string;
      mode: 'PARTIAL_COD';
      onlineAdvancePaise: bigint;
      deliveryBalancePaise: bigint;
      currency: 'INR';
    };

export interface CreatedObligations {
  online: PaymentObligation;
  cod?: PaymentObligation;
}

export interface CheckoutOwnershipReader {
  assertOwned(tx: Prisma.TransactionClient, merchantId: string, checkoutId: string): Promise<void>;
}

export async function createCheckoutObligations(
  tx: Prisma.TransactionClient,
  ownership: CheckoutOwnershipReader,
  input: CreateCheckoutObligationsInput,
): Promise<CreatedObligations> {
  await ownership.assertOwned(tx, input.merchantId, input.checkoutId);

  if (input.mode === 'PARTIAL_COD') {
    assertAuthoritativeObligation(input.onlineAdvancePaise, input.currency);
    assertAuthoritativeObligation(input.deliveryBalancePaise, input.currency);

    const online = await tx.paymentObligation.create({
      data: obligationData(input, 'ONLINE', 'COD_ADVANCE', input.onlineAdvancePaise),
    });
    const cod = await tx.paymentObligation.create({
      data: obligationData(input, 'COD', 'COD_DELIVERY_BALANCE', input.deliveryBalancePaise),
    });

    return { online, cod };
  }

  assertAuthoritativeObligation(input.fullOnlinePaise, input.currency);

  return {
    online: await tx.paymentObligation.create({
      data: obligationData(input, 'ONLINE', 'FULL_ONLINE', input.fullOnlinePaise),
    }),
  };
}

function assertAuthoritativeObligation(amountPaise: bigint, currency: string) {
  if (currency !== 'INR' || amountPaise < 1n) {
    throw new Error('INVALID_AUTHORITATIVE_OBLIGATION');
  }
}

function obligationData(
  input: CreateCheckoutObligationsInput,
  collectionRail: CollectionRail,
  purpose: ObligationPurpose,
  amountPaise: bigint,
): Prisma.PaymentObligationUncheckedCreateInput {
  return {
    merchantId: input.merchantId,
    checkoutId: input.checkoutId,
    collectionRail,
    purpose,
    amountPaise,
    currency: input.currency,
    status: 'OPEN',
    satisfiedAt: null,
  };
}
