import { Prisma, ReconciliationStatus, SellerSettlementStatus } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { HttpError } from "../../../lib/httpError.js";
import { audit } from "../../audit/audit.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type ManualSellerPayoutApprovalInput = {
  awbNumber: string;
  amount: number;
  approvalReference?: string | null;
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

async function findReconciledRemittance(input: {
  merchantId: string;
  awbNumber: string;
  orderId: string;
  externalOrderId: string;
}, client: Db) {
  return client.codRemittance.findFirst({
    where: {
      merchantId: input.merchantId,
      OR: [
        { awb: input.awbNumber },
        { orderId: input.orderId },
        { orderId: input.externalOrderId },
        { externalOrderId: input.externalOrderId }
      ]
    },
    orderBy: [
      { updatedAt: "desc" },
      { createdAt: "desc" }
    ]
  });
}

async function findReconciliationResult(input: {
  merchantId: string;
  awbNumber: string;
  orderId: string;
  externalOrderId: string;
}, client: Db) {
  return client.reconciliationResult.findFirst({
    where: {
      merchantId: input.merchantId,
      OR: [
        { awb: input.awbNumber },
        { orderId: input.orderId },
        { orderId: input.externalOrderId },
        { externalOrderId: input.externalOrderId }
      ]
    },
    orderBy: [
      { updatedAt: "desc" },
      { createdAt: "desc" }
    ]
  });
}

async function findExistingSettlement(input: {
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

function approvedPayoutResponse(input: {
  idempotent: boolean;
  merchantId: string;
  awbNumber: string;
  orderId: string;
  externalOrderId: string;
  amount: number;
  approvalReference: string;
  approvedAt: Date | null;
}) {
  return {
    idempotent: input.idempotent,
    payout: {
      merchantId: input.merchantId,
      awbNumber: input.awbNumber,
      orderId: input.orderId,
      externalOrderId: input.externalOrderId,
      amount: input.amount,
      approvalReference: input.approvalReference || null,
      status: "approved_for_review" as const,
      settlementStatus: "APPROVED" as const,
      approvedAt: input.approvedAt,
      paid: false,
      payoutMoved: false,
      nextStep: "AWAITING_PAYOUT_EXECUTION" as const
    },
    message: "Seller payout approved for finance review. Payout is not marked paid."
  };
}

async function approveInClient(input: ManualSellerPayoutApprovalInput, client: Db) {
  const awbNumber = normalizeAwb(input.awbNumber);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "SELLER_PAYOUT_AMOUNT_REQUIRED");

  const shipment = await findShipmentByAwb(awbNumber, client);
  if (!shipment) throw new HttpError(404, "SHIPMENT_NOT_FOUND");
  if (!isCodPaymentMode(shipment.paymentMode)) throw new HttpError(400, "SHIPMENT_NOT_COD");
  if (!isDeliveredStatus(shipment.status)) throw new HttpError(409, "SHIPMENT_NOT_DELIVERED");

  const order = await findOrderForShipment(shipment, client);
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND_FOR_SHIPMENT");
  if (!isCodPaymentMode(order.paymentMode)) throw new HttpError(400, "ORDER_NOT_COD");

  const remittance = await findReconciledRemittance({
    merchantId: order.merchantId,
    awbNumber: shipment.awbNumber,
    orderId: order.id,
    externalOrderId: order.externalOrderId
  }, client);
  if (!remittance) throw new HttpError(409, "COD_REMITTANCE_NOT_RECONCILED");

  const remittanceStatus = normalizedStatus(remittance.status);
  if (!["manual_reconciled", "reconciled"].includes(remittanceStatus)) {
    throw new HttpError(409, "COD_REMITTANCE_NOT_RECONCILED");
  }

  const remittedAmount = decimalToNumber(remittance.remittedAmount);
  if (remittedAmount === null || remittedAmount <= 0) throw new HttpError(409, "COD_REMITTANCE_NOT_RECONCILED");
  if (!moneyMatches(amount, remittedAmount)) throw new HttpError(409, "SELLER_PAYOUT_AMOUNT_MISMATCH");

  const reconciliationResult = await findReconciliationResult({
    merchantId: order.merchantId,
    awbNumber: shipment.awbNumber,
    orderId: order.id,
    externalOrderId: order.externalOrderId
  }, client);
  if (!reconciliationResult) throw new HttpError(409, "COD_RECONCILIATION_RESULT_NOT_FOUND");
  if (reconciliationResult.status !== ReconciliationStatus.AUTO_APPROVED) {
    throw new HttpError(409, "COD_REMITTANCE_NOT_APPROVABLE");
  }

  const expectedCodAmount = decimalToNumber(reconciliationResult.expectedCodAmount) ?? decimalToNumber(remittance.codAmount) ?? 0;
  if (!moneyMatches(remittedAmount, expectedCodAmount)) {
    throw new HttpError(409, "COD_REMITTANCE_SHORTFALL_NOT_APPROVABLE");
  }

  const approvalReference = clean(input.approvalReference);
  const remarks = clean(input.remarks);
  const approvedAt = new Date();
  const existingSettlement = await findExistingSettlement({
    merchantId: order.merchantId,
    awbNumber: shipment.awbNumber,
    orderId: order.id,
    externalOrderId: order.externalOrderId
  }, client);

  if (existingSettlement?.status === SellerSettlementStatus.SETTLED) {
    throw new HttpError(409, "SELLER_PAYOUT_ALREADY_SETTLED");
  }

  if (existingSettlement?.status === SellerSettlementStatus.APPROVED) {
    const metadata = metadataObject(existingSettlement.metadata);
    const existingReference = clean(typeof metadata.approvalReference === "string" ? metadata.approvalReference : "");
    if (approvalReference && existingReference && approvalReference !== existingReference) {
      throw new HttpError(409, "SELLER_PAYOUT_ALREADY_APPROVED");
    }

    await audit({
      actorId: input.actorId,
      merchantId: order.merchantId,
      action: "ADMIN_SELLER_PAYOUT_APPROVAL_IDEMPOTENT",
      entityType: "SellerSettlement",
      entityId: existingSettlement.id,
      metadata: {
        awbNumber: shipment.awbNumber,
        orderId: order.id,
        externalOrderId: order.externalOrderId,
        amount,
        approvalReference: approvalReference || existingReference || null,
        payoutMoved: false,
        paid: false
      }
    }, client);

    return approvedPayoutResponse({
      idempotent: true,
      merchantId: order.merchantId,
      awbNumber: shipment.awbNumber,
      orderId: order.id,
      externalOrderId: order.externalOrderId,
      amount,
      approvalReference: approvalReference || existingReference,
      approvedAt: existingSettlement.approvedAt
    });
  }

  const settlementMetadata = json({
    source: "ADMIN_MANUAL_SELLER_PAYOUT_APPROVAL",
    remittanceId: remittance.id,
    reconciliationResultId: reconciliationResult.id,
    approvalReference: approvalReference || null,
    remarks: remarks || null,
    payoutMoved: false,
    paid: false,
    awaitingPayoutExecution: true
  });

  const settlement = existingSettlement
    ? await client.sellerSettlement.update({
      where: { id: existingSettlement.id },
      data: {
        reconciliationResultId: reconciliationResult.id,
        status: SellerSettlementStatus.APPROVED,
        codCollected: remittedAmount,
        sellerPayable: amount,
        approvedAt,
        settledAt: null,
        metadata: settlementMetadata
      }
    })
    : await client.sellerSettlement.create({
      data: {
        merchantId: order.merchantId,
        orderId: order.id,
        awb: shipment.awbNumber,
        reconciliationResultId: reconciliationResult.id,
        status: SellerSettlementStatus.APPROVED,
        codCollected: remittedAmount,
        sellerPayable: amount,
        approvedAt,
        metadata: settlementMetadata
      }
    });

  await audit({
    actorId: input.actorId,
    merchantId: order.merchantId,
    action: "ADMIN_SELLER_PAYOUT_APPROVED_FOR_REVIEW",
    entityType: "SellerSettlement",
    entityId: settlement.id,
    metadata: {
      source: "admin_manual_seller_payout_approval",
      awbNumber: shipment.awbNumber,
      orderId: order.id,
      externalOrderId: order.externalOrderId,
      amount,
      approvalReference: approvalReference || null,
      payoutMoved: false,
      paid: false,
      nextStep: "AWAITING_PAYOUT_EXECUTION"
    }
  }, client);

  return approvedPayoutResponse({
    idempotent: false,
    merchantId: order.merchantId,
    awbNumber: shipment.awbNumber,
    orderId: order.id,
    externalOrderId: order.externalOrderId,
    amount,
    approvalReference,
    approvedAt
  });
}

export async function approveManualSellerPayout(
  input: ManualSellerPayoutApprovalInput,
  client: Db = prisma
) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction((tx) => approveInClient(input, tx));
  }

  return approveInClient(input, client);
}
