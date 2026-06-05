import { Prisma, SellerSettlementStatus } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { HttpError } from "../../../lib/httpError.js";
import { audit } from "../../audit/audit.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type ManualSellerPayoutPaidInput = {
  awbNumber: string;
  amount: number;
  paidReference?: string | null;
  paidAt?: Date | null;
  remarks?: string | null;
  mode: "manual_sandbox";
  actorId: string;
};

function clean(value: string | null | undefined) {
  return value?.trim() || "";
}

function normalizeAwb(value: string) {
  return clean(value).toUpperCase();
}

function normalizedStatus(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isDeliveredStatus(value: unknown) {
  return normalizedStatus(value) === "delivered";
}

function isCodPaymentMode(value: unknown) {
  return String(value || "").trim().toUpperCase() === "COD";
}

function decimalToNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  if (typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    const numeric = value.toNumber();
    return Number.isFinite(numeric) ? numeric : null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function moneyMatches(left: number, right: number) {
  return Math.abs(left - right) <= 0.01;
}

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonObject;
}

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? clean(value) : "";
}

function metadataDate(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function releaseConfirmed(metadata: Record<string, unknown>) {
  return metadata.financeReleaseConfirmed === true || metadata.releasedForPayoutProcessing === true;
}

function sandboxPaidConfirmed(metadata: Record<string, unknown>) {
  return metadata.paid === true && (metadata.sandboxManual === true || metadata.manualSandboxPaid === true);
}

async function findShipmentByAwb(awbNumber: string, client: Db) {
  const awb = normalizeAwb(awbNumber);
  if (!awb) throw new HttpError(400, "AWB_NUMBER_REQUIRED");

  return client.courierShipment.findFirst({
    where: {
      OR: [
        { awbNumber: awb },
        { awbNumber: clean(awbNumber) }
      ]
    }
  });
}

async function findOrderForShipment(
  shipment: { orderId?: string | null },
  client: Db
) {
  const orderKey = clean(shipment.orderId);
  if (!orderKey) return null;

  return client.order.findFirst({
    where: {
      OR: [
        { id: orderKey },
        { externalOrderId: orderKey }
      ]
    }
  });
}

async function findSettlement(input: {
  merchantId: string;
  awbNumber: string;
  orderId: string;
  externalOrderId: string;
}, client: Db) {
  return client.sellerSettlement.findFirst({
    where: {
      merchantId: input.merchantId,
      OR: [
        { awb: input.awbNumber },
        { orderId: input.orderId },
        { orderId: input.externalOrderId }
      ]
    },
    orderBy: [
      { updatedAt: "desc" },
      { createdAt: "desc" }
    ]
  });
}

function paidPayoutResponse(input: {
  idempotent: boolean;
  merchantId: string;
  awbNumber: string;
  orderId: string;
  externalOrderId: string;
  amount: number;
  paidReference: string;
  paidAt: Date | null;
}) {
  return {
    idempotent: input.idempotent,
    payout: {
      merchantId: input.merchantId,
      awbNumber: input.awbNumber,
      orderId: input.orderId,
      externalOrderId: input.externalOrderId,
      amount: input.amount,
      paidReference: input.paidReference || null,
      status: "paid" as const,
      settlementStatus: "SETTLED" as const,
      paidAt: input.paidAt,
      paid: true,
      payoutMoved: false,
      bankTransferCreated: false,
      paymentProviderCalled: false,
      sandboxManual: true,
      nextStep: "PAYOUT_RECORDED_MANUAL_SANDBOX" as const
    },
    message: "Payout marked paid in manual sandbox mode. No payment provider was called."
  };
}

async function markPaidInClient(input: ManualSellerPayoutPaidInput, client: Db) {
  if (input.mode !== "manual_sandbox") throw new HttpError(400, "MANUAL_SANDBOX_MODE_REQUIRED");

  const awbNumber = normalizeAwb(input.awbNumber);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "SELLER_PAYOUT_PAID_AMOUNT_REQUIRED");

  const shipment = await findShipmentByAwb(awbNumber, client);
  if (!shipment) throw new HttpError(404, "SHIPMENT_NOT_FOUND");
  if (!isCodPaymentMode(shipment.paymentMode)) throw new HttpError(400, "SHIPMENT_NOT_COD");
  if (!isDeliveredStatus(shipment.status)) throw new HttpError(409, "SHIPMENT_NOT_DELIVERED");

  const order = await findOrderForShipment(shipment, client);
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND_FOR_SHIPMENT");
  if (!isCodPaymentMode(order.paymentMode)) throw new HttpError(400, "ORDER_NOT_COD");

  const settlement = await findSettlement({
    merchantId: order.merchantId,
    awbNumber: shipment.awbNumber,
    orderId: order.id,
    externalOrderId: order.externalOrderId
  }, client);

  if (!settlement) throw new HttpError(409, "SELLER_PAYOUT_NOT_FINANCE_RELEASED");

  const metadata = metadataObject(settlement.metadata);
  const expectedAmount = decimalToNumber(settlement.sellerPayable);
  if (expectedAmount === null || expectedAmount <= 0) throw new HttpError(409, "SELLER_PAYOUT_NOT_FINANCE_RELEASED");
  if (!moneyMatches(amount, expectedAmount)) throw new HttpError(409, "SELLER_PAYOUT_PAID_AMOUNT_MISMATCH");

  const paidReference = clean(input.paidReference);
  const remarks = clean(input.remarks);
  const existingPaidReference = metadataString(metadata, "paidReference");

  if (settlement.status === SellerSettlementStatus.SETTLED || sandboxPaidConfirmed(metadata)) {
    if (paidReference && existingPaidReference && paidReference !== existingPaidReference) {
      throw new HttpError(409, "SELLER_PAYOUT_ALREADY_PAID");
    }

    await audit({
      actorId: input.actorId,
      merchantId: order.merchantId,
      action: "ADMIN_SELLER_PAYOUT_MARK_PAID_IDEMPOTENT",
      entityType: "SellerSettlement",
      entityId: settlement.id,
      metadata: {
        awbNumber: shipment.awbNumber,
        orderId: order.id,
        externalOrderId: order.externalOrderId,
        amount,
        paidReference: paidReference || existingPaidReference || null,
        paid: true,
        sandboxManual: true,
        payoutMoved: false,
        bankTransferCreated: false,
        paymentProviderCalled: false
      }
    }, client);

    return paidPayoutResponse({
      idempotent: true,
      merchantId: order.merchantId,
      awbNumber: shipment.awbNumber,
      orderId: order.id,
      externalOrderId: order.externalOrderId,
      amount,
      paidReference: paidReference || existingPaidReference,
      paidAt: metadataDate(metadata, "manualSandboxPaidAt") ?? metadataDate(metadata, "paidAt") ?? settlement.settledAt
    });
  }

  if (settlement.status !== SellerSettlementStatus.APPROVED || !releaseConfirmed(metadata)) {
    throw new HttpError(409, "SELLER_PAYOUT_NOT_FINANCE_RELEASED");
  }

  const paidAt = input.paidAt && !Number.isNaN(input.paidAt.getTime()) ? input.paidAt : new Date();
  const paidMetadata = json({
    ...metadata,
    paid: true,
    manualSandboxPaid: true,
    sandboxManual: true,
    paidMode: "manual_sandbox",
    manualSandboxPaidAt: paidAt.toISOString(),
    paidAt: paidAt.toISOString(),
    paidReference: paidReference || null,
    paidRemarks: remarks || null,
    payoutMoved: false,
    bankTransferCreated: false,
    paymentProviderCalled: false,
    awaitingExternalPayoutExecution: false
  });

  const updatedSettlement = await client.sellerSettlement.update({
    where: { id: settlement.id },
    data: {
      status: SellerSettlementStatus.SETTLED,
      settledAt: paidAt,
      metadata: paidMetadata
    }
  });

  await audit({
    actorId: input.actorId,
    merchantId: order.merchantId,
    action: "ADMIN_SELLER_PAYOUT_MARKED_PAID_MANUAL_SANDBOX",
    entityType: "SellerSettlement",
    entityId: updatedSettlement.id,
    metadata: {
      source: "admin_manual_seller_payout_paid_sandbox",
      awbNumber: shipment.awbNumber,
      orderId: order.id,
      externalOrderId: order.externalOrderId,
      amount,
      paidReference: paidReference || null,
      paid: true,
      sandboxManual: true,
      payoutMoved: false,
      bankTransferCreated: false,
      paymentProviderCalled: false,
      nextStep: "PAYOUT_RECORDED_MANUAL_SANDBOX"
    }
  }, client);

  return paidPayoutResponse({
    idempotent: false,
    merchantId: order.merchantId,
    awbNumber: shipment.awbNumber,
    orderId: order.id,
    externalOrderId: order.externalOrderId,
    amount,
    paidReference,
    paidAt
  });
}

export async function markManualSellerPayoutPaid(
  input: ManualSellerPayoutPaidInput,
  client: Db = prisma
) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction((tx) => markPaidInClient(input, tx));
  }

  return markPaidInClient(input, client);
}
