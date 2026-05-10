import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export async function releasePaymentHold(input: {
  merchantId: string;
  paymentHoldId: string;
}, client: Db = prisma) {
  const hold = await client.paymentHold.findFirst({
    where: { id: input.paymentHoldId, merchantId: input.merchantId }
  });
  if (!hold) throw new HttpError(404, "PAYMENT_HOLD_NOT_FOUND");

  const updated = await client.paymentHold.update({
    where: { id: hold.id },
    data: {
      status: "RELEASED",
      releasedAt: new Date()
    }
  });

  await audit({
    merchantId: input.merchantId,
    action: "PAYMENT_HOLD_RELEASED",
    entityType: "PaymentHold",
    entityId: updated.id,
    metadata: { amount: Number(updated.amount), reason: updated.reason }
  }, client);

  return updated;
}
