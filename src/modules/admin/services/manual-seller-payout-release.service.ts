import { Prisma, SellerSettlementStatus } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { HttpError } from "../../../lib/httpError.js";
import { audit } from "../../audit/audit.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type ManualSellerPayoutReleaseInput = {
  awbNumber: string;
  amount: number;
  releaseReference?: string | null;
  remarks?: string | null;
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

function releaseConfirmed(metadata: Record<string, unknown>) {
  return metadata.financeReleaseConfirmed === true || metadata.releasedForPayoutProcessing === true;
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

async function findApprovedSettlement(input: {
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

function releasedPayoutResponse(input: {
  idempotent: boolean;
  merchantId: string;
  awbNumber: string;
  orderId: string;
  externalOrderId: string;
  amount: number;
  releaseReference: string;
  releasedAt: Date | null;
}) {
  return {
    idempotent: input.idempotent,
    payout: {
      merchantId: input.merchantId,
      awbNumber: input.awbNumber,
      orderId: input.orderId,
      externalOrderId: input.externalOrderId,
      amount: input.amount,
      releaseReference: input.releaseReference || null,
      status: "finance_released" as const,
      settlementStatus: "APPROVED" as const,
      releasedAt: input.releasedAt,
      paid: false,
      payoutMoved: false,
      bankTransferCreated: false,
      paymentProviderCalled: false,
      nextStep: "AWAITING_EXTERNAL_PAYOUT_EXECUTION" as const
    },
    message: "Finance release confirmed for payout processing. Payout is not marked paid."
  };
}

async function releaseInClient(input: ManualSellerPayoutReleaseInput, client: Db) {
  const awbNumber = normalizeAwb(input.awbNumber);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "SELLER_PAYOUT_RELEASE_AMOUNT_REQUIRED");

  const shipment = await findShipmentByAwb(awbNumber, client);
  if (!shipment) throw new HttpError(404, "SHIPMENT_NOT_FOUND");
  if (!isCodPaymentMode(shipment.paymentMode)) throw new HttpError(400, "SHIPMENT_NOT_COD");
  if (!isDeliveredStatus(shipment.status)) throw new HttpError(409, "SHIPMENT_NOT_DELIVERED");

  const order = await findOrderForShipment(shipment, client);
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND_FOR_SHIPMENT");
  if (!isCodPaymentMode(order.paymentMode)) throw new HttpError(400, "ORDER_NOT_COD");

  const settlement = await findApprovedSettlement({
    merchantId: order.merchantId,
    awbNumber: shipment.awbNumber,
    orderId: order.id,
    externalOrderId: order.externalOrderId
  }, client);

  if (!settlement) throw new HttpError(409, "SELLER_PAYOUT_NOT_APPROVED_FOR_RELEASE");
  if (settlement.status === SellerSettlementStatus.SETTLED) throw new HttpError(409, "SELLER_PAYOUT_ALREADY_SETTLED");
  if (settlement.status !== SellerSettlementStatus.APPROVED) throw new HttpError(409, "SELLER_PAYOUT_NOT_APPROVED_FOR_RELEASE");

  const approvedAmount = decimalToNumber(settlement.sellerPayable);
  if (approvedAmount === null || approvedAmount <= 0) throw new HttpError(409, "SELLER_PAYOUT_NOT_APPROVED_FOR_RELEASE");
  if (!moneyMatches(amount, approvedAmount)) throw new HttpError(409, "SELLER_PAYOUT_RELEASE_AMOUNT_MISMATCH");

  const metadata = metadataObject(settlement.metadata);
  const releaseReference = clean(input.releaseReference);
  const remarks = clean(input.remarks);
  const existingReference = metadataString(metadata, "releaseReference");

  if (releaseConfirmed(metadata)) {
    if (releaseReference && existingReference && releaseReference !== existingReference) {
      throw new HttpError(409, "SELLER_PAYOUT_RELEASE_ALREADY_CONFIRMED");
    }

    await audit({
      actorId: input.actorId,
      merchantId: order.merchantId,
      action: "ADMIN_SELLER_PAYOUT_RELEASE_IDEMPOTENT",
      entityType: "SellerSettlement",
      entityId: settlement.id,
      metadata: {
        awbNumber: shipment.awbNumber,
        orderId: order.id,
        externalOrderId: order.externalOrderId,
        amount,
        releaseReference: releaseReference || existingReference || null,
        paid: false,
        payoutMoved: false,
        bankTransferCreated: false,
        paymentProviderCalled: false
      }
    }, client);

    return releasedPayoutResponse({
      idempotent: true,
      merchantId: order.merchantId,
      awbNumber: shipment.awbNumber,
      orderId: order.id,
      externalOrderId: order.externalOrderId,
      amount,
      releaseReference: releaseReference || existingReference,
      releasedAt: metadataDate(metadata, "financeReleasedAt")
    });
  }

  const releasedAt = new Date();
  const releaseMetadata = json({
    ...metadata,
    financeReleaseConfirmed: true,
    releasedForPayoutProcessing: true,
    financeReleasedAt: releasedAt.toISOString(),
    releaseReference: releaseReference || null,
    releaseRemarks: remarks || null,
    paid: false,
    payoutMoved: false,
    bankTransferCreated: false,
    paymentProviderCalled: false,
    awaitingExternalPayoutExecution: true
  });

  const updatedSettlement = await client.sellerSettlement.update({
    where: { id: settlement.id },
    data: {
      status: SellerSettlementStatus.APPROVED,
      settledAt: null,
      metadata: releaseMetadata
    }
  });

  await audit({
    actorId: input.actorId,
    merchantId: order.merchantId,
    action: "ADMIN_SELLER_PAYOUT_RELEASE_CONFIRMED",
    entityType: "SellerSettlement",
    entityId: updatedSettlement.id,
    metadata: {
      source: "admin_manual_seller_payout_release",
      awbNumber: shipment.awbNumber,
      orderId: order.id,
      externalOrderId: order.externalOrderId,
      amount,
      releaseReference: releaseReference || null,
      paid: false,
      payoutMoved: false,
      bankTransferCreated: false,
      paymentProviderCalled: false,
      nextStep: "AWAITING_EXTERNAL_PAYOUT_EXECUTION"
    }
  }, client);

  return releasedPayoutResponse({
    idempotent: false,
    merchantId: order.merchantId,
    awbNumber: shipment.awbNumber,
    orderId: order.id,
    externalOrderId: order.externalOrderId,
    amount,
    releaseReference,
    releasedAt
  });
}

export async function releaseManualSellerPayout(
  input: ManualSellerPayoutReleaseInput,
  client: Db = prisma
) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction((tx) => releaseInClient(input, tx));
  }

  return releaseInClient(input, client);
}
