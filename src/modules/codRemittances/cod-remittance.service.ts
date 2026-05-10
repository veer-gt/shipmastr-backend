import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";

export type CodRemittanceImportInput = {
  merchantId: string;
  remittances: Array<{
    courierId?: string | undefined;
    awb?: string | undefined;
    orderId?: string | undefined;
    externalOrderId?: string | undefined;
    codAmount?: number | undefined;
    remittedAmount: number;
    remittedAt?: Date | undefined;
    utr?: string | undefined;
    rawPayload?: Prisma.InputJsonValue | undefined;
  }>;
};

export async function importCodRemittances(input: CodRemittanceImportInput, client: typeof prisma = prisma) {
  return client.$transaction(async (tx: Prisma.TransactionClient) => {
    const created = [];

    for (const remittance of input.remittances) {
      created.push(await tx.codRemittance.create({
        data: {
          merchantId: input.merchantId,
          courierId: remittance.courierId ?? null,
          awb: remittance.awb ?? null,
          orderId: remittance.orderId ?? null,
          externalOrderId: remittance.externalOrderId ?? null,
          codAmount: remittance.codAmount ?? 0,
          remittedAmount: remittance.remittedAmount,
          remittedAt: remittance.remittedAt ?? null,
          utr: remittance.utr ?? null,
          rawPayload: remittance.rawPayload ?? Prisma.JsonNull
        }
      }));
    }

    await audit({
      merchantId: input.merchantId,
      action: "COD_REMITTANCE_IMPORTED",
      entityType: "CodRemittance",
      metadata: {
        remittanceCount: created.length,
        remittedAmount: input.remittances.reduce((sum, item) => sum + item.remittedAmount, 0)
      }
    }, tx);

    return created;
  });
}
