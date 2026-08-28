import { Prisma, PrismaClient, type PaymentAttempt, type PaymentObligation } from '@prisma/client';

type DbClient = Prisma.TransactionClient | PrismaClient;

export async function getOwnedObligationOrThrow(
  client: DbClient,
  merchantId: string,
  obligationId: string,
): Promise<PaymentObligation> {
  const obligation = await client.paymentObligation.findFirst({
    where: { id: obligationId, merchantId },
  });

  if (!obligation) {
    throw new Error('OBLIGATION_NOT_FOUND');
  }

  return obligation;
}

export async function listOwnedAttemptsForObligationOrThrow(
  client: DbClient,
  merchantId: string,
  obligationId: string,
): Promise<PaymentAttempt[]> {
  await getOwnedObligationOrThrow(client, merchantId, obligationId);

  return client.paymentAttempt.findMany({
    where: { merchantId, obligationId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getOwnedAttemptForObligationOrThrow(
  client: DbClient,
  merchantId: string,
  obligationId: string,
  attemptId: string,
): Promise<PaymentAttempt> {
  await getOwnedObligationOrThrow(client, merchantId, obligationId);

  const attempt = await client.paymentAttempt.findFirst({
    where: {
      id: attemptId,
      merchantId,
      obligationId,
    },
  });

  if (!attempt) {
    throw new Error('OBLIGATION_NOT_FOUND');
  }

  return attempt;
}

export async function findRequestReplayAttempt(
  client: DbClient,
  merchantId: string,
  requestIdempotencyKey: string,
): Promise<PaymentAttempt | null> {
  return client.paymentAttempt.findUnique({
    where: {
      merchantId_requestIdempotencyKey: {
        merchantId,
        requestIdempotencyKey,
      },
    },
  });
}

export async function findUnresolvedAttemptForOwnedObligation(
  client: DbClient,
  merchantId: string,
  obligationId: string,
): Promise<PaymentAttempt | null> {
  return client.paymentAttempt.findFirst({
    where: {
      merchantId,
      obligationId,
      resolvedAt: null,
    },
    orderBy: { createdAt: 'asc' },
  });
}
