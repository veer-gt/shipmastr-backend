import { Prisma, ReconciliationStatus } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { HttpError } from "../../../lib/httpError.js";
import { audit } from "../../audit/audit.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type ManualCodRemittanceReconcileInput = {
  awbNumber: string;
  amount: number;
  receivedAt?: Date | null;
  referenceNumber?: string | null;
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

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonObject;
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
    },
    include: {
      courier: { select: { id: true, name: true, code: true } }
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

function expectedCodAmountFor(
  order: { codAmount: number },
  shipment: { codAmount?: number | null }
) {
  const orderCod = Number(order.codAmount || 0);
  if (Number.isFinite(orderCod) && orderCod > 0) return orderCod;

  const shipmentCod = Number(shipment.codAmount || 0);
  return Number.isFinite(shipmentCod) && shipmentCod > 0 ? shipmentCod : 0;
}

async function findExistingRemittance(input: {
  merchantId: string;
  awbNumber: string;
  referenceNumber: string;
}, client: Db) {
  const clauses = [
    input.referenceNumber ? { awb: input.awbNumber, utr: input.referenceNumber } : null,
    { awb: input.awbNumber, status: "manual_reconciled" }
  ].filter((clause): clause is NonNullable<typeof clause> => Boolean(clause));

  return client.codRemittance.findFirst({
    where: {
      merchantId: input.merchantId,
      OR: clauses
    },
    orderBy: [
      { updatedAt: "desc" },
      { createdAt: "desc" }
    ]
  });
}

async function createRemittance(input: {
  merchantId: string;
  courierId: string | null;
  awbNumber: string;
  orderId: string;
  externalOrderId: string;
  expectedCodAmount: number;
  amount: number;
  receivedAt: Date;
  referenceNumber: string;
  remarks: string;
}, client: Db) {
  return client.codRemittance.create({
    data: {
      merchantId: input.merchantId,
      courierId: input.courierId,
      awb: input.awbNumber,
      orderId: input.orderId,
      externalOrderId: input.externalOrderId,
      codAmount: input.expectedCodAmount,
      remittedAmount: input.amount,
      remittedAt: input.receivedAt,
      utr: input.referenceNumber || null,
      status: "manual_reconciled",
      rawPayload: json({
        source: "ADMIN_MANUAL_COD_REMITTANCE",
        referenceNumber: input.referenceNumber || null,
        remarks: input.remarks || null
      })
    }
  });
}

function reconciliationStatusFor(amount: number, expectedCodAmount: number) {
  return amount + 0.01 >= expectedCodAmount
    ? ReconciliationStatus.AUTO_APPROVED
    : ReconciliationStatus.COD_SHORTFALL;
}

async function upsertReconciliationResult(input: {
  merchantId: string;
  courierId: string | null;
  awbNumber: string;
  orderId: string;
  externalOrderId: string;
  expectedCodAmount: number;
  amount: number;
  receivedAt: Date;
  referenceNumber: string;
  remarks: string;
  remittanceId: string;
}, client: Db) {
  const status = reconciliationStatusFor(input.amount, input.expectedCodAmount);
  const mismatchAmount = Math.max(input.expectedCodAmount - input.amount, 0);
  const reasons = status === ReconciliationStatus.AUTO_APPROVED
    ? ["MANUAL_COD_REMITTANCE_RECONCILED"]
    : ["MANUAL_COD_REMITTANCE_SHORTFALL"];
  const metadata = json({
    source: "ADMIN_MANUAL_COD_REMITTANCE",
    remittanceId: input.remittanceId,
    referenceNumber: input.referenceNumber || null,
    receivedAt: input.receivedAt.toISOString(),
    remarks: input.remarks || null,
    payoutMoved: false
  });

  const existing = await client.reconciliationResult.findFirst({
    where: {
      merchantId: input.merchantId,
      OR: [
        { awb: input.awbNumber },
        { orderId: input.orderId },
        { externalOrderId: input.externalOrderId }
      ]
    },
    orderBy: [
      { updatedAt: "desc" },
      { createdAt: "desc" }
    ]
  });

  const data = {
    courierId: input.courierId,
    status,
    expectedCodAmount: input.expectedCodAmount,
    remittedCodAmount: input.amount,
    sellerPayable: null,
    courierPayable: null,
    mismatchAmount,
    disputeAmount: 0,
    paymentHoldAmount: 0,
    reasons,
    metadata
  };

  if (existing) {
    return client.reconciliationResult.update({
      where: { id: existing.id },
      data
    });
  }

  const run = await client.reconciliationRun.create({
    data: {
      merchantId: input.merchantId,
      status: "COMPLETED",
      totalResults: 1,
      autoApprovedCount: status === ReconciliationStatus.AUTO_APPROVED ? 1 : 0,
      disputeCount: 0,
      paymentHoldCount: 0,
      completedAt: input.receivedAt,
      metadata: json({
        source: "ADMIN_MANUAL_COD_REMITTANCE",
        awbNumber: input.awbNumber,
        payoutMoved: false
      })
    }
  });

  return client.reconciliationResult.create({
    data: {
      runId: run.id,
      merchantId: input.merchantId,
      orderId: input.orderId,
      externalOrderId: input.externalOrderId,
      awb: input.awbNumber,
      ...data
    }
  });
}

async function reconcileInClient(input: ManualCodRemittanceReconcileInput, client: Db) {
  const awbNumber = normalizeAwb(input.awbNumber);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "COD_REMITTANCE_AMOUNT_REQUIRED");

  const shipment = await findShipmentByAwb(awbNumber, client);
  if (!shipment) throw new HttpError(404, "SHIPMENT_NOT_FOUND");
  if (!isCodPaymentMode(shipment.paymentMode)) throw new HttpError(400, "SHIPMENT_NOT_COD");
  if (!isDeliveredStatus(shipment.status)) throw new HttpError(409, "SHIPMENT_NOT_DELIVERED");

  const order = await findOrderForShipment(shipment, client);
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND_FOR_SHIPMENT");
  if (!isCodPaymentMode(order.paymentMode)) throw new HttpError(400, "ORDER_NOT_COD");

  const expectedCodAmount = expectedCodAmountFor(order, shipment);
  if (expectedCodAmount <= 0) throw new HttpError(400, "COD_AMOUNT_NOT_AVAILABLE");

  const receivedAt = input.receivedAt ?? new Date();
  const referenceNumber = clean(input.referenceNumber);
  const remarks = clean(input.remarks);
  const existingRemittance = await findExistingRemittance({
    merchantId: order.merchantId,
    awbNumber: shipment.awbNumber,
    referenceNumber
  }, client);
  const remittance = existingRemittance ?? await createRemittance({
    merchantId: order.merchantId,
    courierId: shipment.courierId,
    awbNumber: shipment.awbNumber,
    orderId: order.id,
    externalOrderId: order.externalOrderId,
    expectedCodAmount,
    amount,
    receivedAt,
    referenceNumber,
    remarks
  }, client);
  const result = await upsertReconciliationResult({
    merchantId: order.merchantId,
    courierId: shipment.courierId,
    awbNumber: shipment.awbNumber,
    orderId: order.id,
    externalOrderId: order.externalOrderId,
    expectedCodAmount,
    amount,
    receivedAt,
    referenceNumber,
    remarks,
    remittanceId: remittance.id
  }, client);

  await audit({
    actorId: input.actorId,
    merchantId: order.merchantId,
    action: "ADMIN_MANUAL_COD_REMITTANCE_RECONCILED",
    entityType: "CodRemittance",
    entityId: remittance.id,
    metadata: {
      source: "admin_manual_cod_remittance_reconciliation",
      awbNumber: shipment.awbNumber,
      orderId: order.id,
      externalOrderId: order.externalOrderId,
      courierId: shipment.courierId,
      amount,
      expectedCodAmount,
      referenceNumber: referenceNumber || null,
      idempotent: Boolean(existingRemittance),
      payoutMoved: false
    }
  }, client);

  return {
    idempotent: Boolean(existingRemittance),
    remittance: {
      id: remittance.id,
      merchantId: order.merchantId,
      awbNumber: shipment.awbNumber,
      orderId: order.id,
      externalOrderId: order.externalOrderId,
      amount,
      expectedCodAmount,
      receivedAt,
      referenceNumber: referenceNumber || null,
      status: "reconciled" as const,
      persistence: "DATABASE" as const
    },
    reconciliationResult: {
      id: result.id,
      status: result.status,
      expectedCodAmount,
      remittedCodAmount: amount,
      nextStep: "SELLER_FINANCE_RECONCILED" as const
    },
    message: "COD remittance reconciled manually. No seller payout was moved."
  };
}

export async function reconcileManualCodRemittance(
  input: ManualCodRemittanceReconcileInput,
  client: Db = prisma
) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction((tx) => reconcileInClient(input, tx));
  }

  return reconcileInClient(input, client);
}
