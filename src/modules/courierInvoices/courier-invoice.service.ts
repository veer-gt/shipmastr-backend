import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";

export type CourierInvoiceImportInput = {
  merchantId: string;
  courierId: string;
  invoiceNumber?: string | undefined;
  periodStart: Date;
  periodEnd: Date;
  lines: Array<{
    awb?: string | undefined;
    orderId?: string | undefined;
    externalOrderId?: string | undefined;
    chargedWeightGrams?: number | undefined;
    billedWeightGrams?: number | undefined;
    zone?: string | undefined;
    forwardFreight?: number | undefined;
    rtoFreight?: number | undefined;
    codFee?: number | undefined;
    otherCharges?: number | undefined;
    gstAmount?: number | undefined;
    totalCharge: number;
    rawPayload?: Prisma.InputJsonValue | undefined;
  }>;
};

export async function importCourierInvoice(input: CourierInvoiceImportInput, client: typeof prisma = prisma) {
  return client.$transaction(async (tx: Prisma.TransactionClient) => {
    const totalAmount = input.lines.reduce((sum, line) => sum + line.totalCharge, 0);
    const gstAmount = input.lines.reduce((sum, line) => sum + (line.gstAmount ?? 0), 0);
    const invoice = await tx.courierInvoice.create({
      data: {
        courierId: input.courierId,
        invoiceNumber: input.invoiceNumber ?? null,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        shipmentCount: input.lines.length,
        payableAmount: Math.round(totalAmount),
        totalAmount,
        gstAmount,
        status: "imported",
        lines: {
          create: input.lines.map((line) => ({
            merchantId: input.merchantId,
            courierId: input.courierId,
            awb: line.awb ?? null,
            orderId: line.orderId ?? null,
            externalOrderId: line.externalOrderId ?? null,
            chargedWeightGrams: line.chargedWeightGrams ?? null,
            billedWeightGrams: line.billedWeightGrams ?? null,
            zone: line.zone ?? null,
            forwardFreight: line.forwardFreight ?? 0,
            rtoFreight: line.rtoFreight ?? 0,
            codFee: line.codFee ?? 0,
            otherCharges: line.otherCharges ?? 0,
            gstAmount: line.gstAmount ?? 0,
            totalCharge: line.totalCharge,
            rawPayload: line.rawPayload ?? Prisma.JsonNull
          }))
        }
      },
      include: { lines: true }
    });

    await audit({
      merchantId: input.merchantId,
      action: "COURIER_INVOICE_IMPORTED",
      entityType: "CourierInvoice",
      entityId: invoice.id,
      metadata: {
        courierId: input.courierId,
        invoiceNumber: input.invoiceNumber,
        lineCount: input.lines.length,
        totalAmount
      }
    }, tx);

    return invoice;
  });
}
