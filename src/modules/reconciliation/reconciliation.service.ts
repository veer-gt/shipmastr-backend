import type {
  CourierInvoiceLine,
  DisputeWorkflowStatus,
  Prisma,
  ReconciliationDisputeType,
  ReconciliationStatus,
  SellerSettlementStatus
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { rateCardToReconciliationInput } from "../rateCards/rate-card.service.js";
import { calculateCourierPenalties } from "../sellerSettlements/finance-policy.service.js";
import { credit as creditWallet } from "../wallet/wallet.service.js";
import {
  buildCourierPayableSummary,
  buildReconciliationPlan,
  type ReconciliationCodRemittanceInput,
  type ReconciliationCourierEventInput,
  type ReconciliationInvoiceLineInput,
  type ReconciliationOrderInput,
  type ReconciliationResultPlan,
  type ReconciliationShipmentInput
} from "./reconciliation-engine.js";

type Db = Prisma.TransactionClient | typeof prisma;

function num(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function lineToInput(line: CourierInvoiceLine): ReconciliationInvoiceLineInput {
  return {
    id: line.id,
    merchantId: line.merchantId,
    courierId: line.courierId,
    awb: line.awb,
    orderId: line.orderId,
    externalOrderId: line.externalOrderId,
    chargedWeightGrams: line.chargedWeightGrams,
    billedWeightGrams: line.billedWeightGrams,
    zone: line.zone,
    forwardFreight: num(line.forwardFreight),
    rtoFreight: num(line.rtoFreight),
    codFee: num(line.codFee),
    otherCharges: num(line.otherCharges),
    gstAmount: num(line.gstAmount),
    totalCharge: num(line.totalCharge)
  };
}

function resultMetadata(result: ReconciliationResultPlan) {
  return json({
    ...result.metadata,
    disputes: result.disputes,
    holds: result.holds
  });
}

async function createResult(runId: string, result: ReconciliationResultPlan, client: Db) {
  const created = await client.reconciliationResult.create({
    data: {
      runId,
      merchantId: result.merchantId,
      orderId: result.orderId,
      externalOrderId: result.externalOrderId,
      awb: result.awb,
      courierId: result.courierId,
      status: result.status,
      expectedCourierCharge: result.expectedCourierCharge,
      invoicedCourierCharge: result.invoicedCourierCharge,
      expectedCodAmount: result.expectedCodAmount,
      remittedCodAmount: result.remittedCodAmount,
      sellerPayable: result.sellerPayable,
      courierPayable: result.courierPayable,
      mismatchAmount: result.mismatchAmount,
      disputeAmount: result.disputeAmount,
      paymentHoldAmount: result.paymentHoldAmount,
      reasons: result.reasons,
      metadata: resultMetadata(result)
    }
  });

  for (const dispute of result.disputes) {
    await client.reconciliationDispute.create({
      data: {
        reconciliationResultId: created.id,
        merchantId: result.merchantId === "UNKNOWN" ? null : result.merchantId,
        courierId: result.courierId,
        awb: result.awb,
        orderId: result.orderId,
        type: dispute.type,
        amount: dispute.amount,
        reason: dispute.reason,
        evidence: json({
          expectedCourierCharge: result.expectedCourierCharge,
          invoicedCourierCharge: result.invoicedCourierCharge,
          expectedCodAmount: result.expectedCodAmount,
          remittedCodAmount: result.remittedCodAmount,
          reasons: result.reasons
        })
      }
    });
  }

  for (const hold of result.holds) {
    await client.paymentHold.create({
      data: {
        reconciliationResultId: created.id,
        merchantId: result.merchantId === "UNKNOWN" ? "UNKNOWN" : result.merchantId,
        orderId: result.orderId,
        awb: result.awb,
        reason: hold.reason,
        amount: hold.amount,
        metadata: json({ status: result.status })
      }
    });
  }

  if (result.settlement) {
    await client.sellerSettlement.create({
      data: {
        reconciliationResultId: created.id,
        merchantId: result.merchantId,
        orderId: result.orderId,
        awb: result.awb,
        status: result.settlement.status as SellerSettlementStatus,
        codCollected: result.settlement.codCollected,
        courierCharge: result.settlement.courierCharge,
        platformFee: result.settlement.platformFee,
        adjustmentAmount: result.settlement.adjustmentAmount,
        sellerPayable: result.settlement.sellerPayable,
        approvedAt: new Date(),
        metadata: json({ source: "RECONCILIATION_AUTO_APPROVED" })
      }
    });
  }

  return created;
}

export async function runReconciliation(input: {
  merchantId: string;
  periodStart?: Date | undefined;
  periodEnd?: Date | undefined;
}, client: typeof prisma = prisma) {
  return client.$transaction(async (tx: Prisma.TransactionClient) => {
    const run = await tx.reconciliationRun.create({
      data: {
        merchantId: input.merchantId,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        status: "RUNNING"
      }
    });

    const orders = await tx.order.findMany({
      where: { merchantId: input.merchantId },
      include: { shipmentDetails: true }
    });
    const invoiceLines = await tx.courierInvoiceLine.findMany({
      where: { merchantId: input.merchantId },
      orderBy: { createdAt: "asc" }
    });
    const remittances = await tx.codRemittance.findMany({
      where: { merchantId: input.merchantId },
      orderBy: { createdAt: "asc" }
    });
    const rateCards = await tx.rateCard.findMany();
    const courierPolicies = await tx.courierFinancePolicy.findMany({
      where: {
        merchantId: input.merchantId,
        active: true
      }
    });
    const courierShipments = await tx.courierShipment.findMany({
      where: { orderId: { in: orders.map((order) => order.id) } },
      include: { events: true }
    });

    const orderInputs: ReconciliationOrderInput[] = orders.map((order) => ({
      id: order.id,
      merchantId: order.merchantId,
      externalOrderId: order.externalOrderId,
      codAmount: order.codAmount,
      paymentMode: order.paymentMode,
      weightGrams: order.weightGrams,
      status: order.status
    }));
    const shipmentInputs: ReconciliationShipmentInput[] = orders
      .map((order) => order.shipmentDetails)
      .filter((shipment): shipment is NonNullable<typeof shipment> => Boolean(shipment))
      .map((shipment) => ({
        orderId: shipment.orderId,
        merchantId: shipment.merchantId,
        courierId: shipment.courierId,
        awb: shipment.awb,
        weightGrams: shipment.weightGrams,
        zone: shipment.zone,
        shipmentStatus: shipment.shipmentStatus,
        rtoStatus: shipment.rtoStatus,
        deliveredAt: shipment.deliveredAt
      }));
    const remittanceInputs: ReconciliationCodRemittanceInput[] = remittances.map((remittance) => ({
      merchantId: remittance.merchantId,
      courierId: remittance.courierId,
      awb: remittance.awb,
      orderId: remittance.orderId,
      externalOrderId: remittance.externalOrderId,
      codAmount: num(remittance.codAmount),
      remittedAmount: num(remittance.remittedAmount),
      remittedAt: remittance.remittedAt
    }));
    const eventInputs: ReconciliationCourierEventInput[] = courierShipments.flatMap((shipment) => shipment.events.map((event) => ({
      awb: shipment.awbNumber,
      orderId: shipment.orderId,
      courierId: shipment.courierId,
      eventType: event.eventType,
      status: event.status,
      remarks: event.remarks,
      createdAt: event.createdAt
    })));
    const plan = buildReconciliationPlan({
      orders: orderInputs,
      shipments: shipmentInputs,
      invoiceLines: invoiceLines.map(lineToInput),
      codRemittances: remittanceInputs,
      rateCards: rateCards.map(rateCardToReconciliationInput),
      courierEvents: eventInputs,
      courierPolicies: courierPolicies.map((policy) => ({
        courierId: policy.courierId,
        codRemittanceSlaDays: policy.codRemittanceSlaDays
      }))
    });

    for (const result of plan.results) {
      await createResult(run.id, result, tx);
    }

    const completed = await tx.reconciliationRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        totalResults: plan.results.length,
        autoApprovedCount: plan.results.filter((result) => result.status === "AUTO_APPROVED").length,
        disputeCount: plan.results.reduce((sum, result) => sum + result.disputes.length, 0),
        paymentHoldCount: plan.results.reduce((sum, result) => sum + result.holds.length, 0),
        metadata: json({ dashboard: plan.summary })
      }
    });

    await audit({
      merchantId: input.merchantId,
      action: "RECONCILIATION_RUN_COMPLETED",
      entityType: "ReconciliationRun",
      entityId: completed.id,
      metadata: {
        totalResults: completed.totalResults,
        disputeCount: completed.disputeCount,
        paymentHoldCount: completed.paymentHoldCount
      }
    }, tx);

    const penalties = await calculateCourierPenalties({
      merchantId: input.merchantId,
      runId: completed.id
    }, tx);

    return { run: completed, summary: plan.summary, penalties };
  });
}

export async function listReconciliationRuns(merchantId: string, client: Db = prisma) {
  return client.reconciliationRun.findMany({
    where: { merchantId },
    orderBy: { startedAt: "desc" },
    take: 100
  });
}

export async function listReconciliationResults(input: {
  merchantId: string;
  status?: ReconciliationStatus | undefined;
}, client: Db = prisma) {
  return client.reconciliationResult.findMany({
    where: {
      merchantId: input.merchantId,
      ...(input.status ? { status: input.status } : {})
    },
    include: { disputes: true, paymentHolds: true, settlements: true },
    orderBy: { createdAt: "desc" },
    take: 200
  });
}

export async function listReconciliationDisputes(input: {
  merchantId: string;
  status?: DisputeWorkflowStatus | undefined;
  type?: ReconciliationDisputeType | undefined;
}, client: Db = prisma) {
  return client.reconciliationDispute.findMany({
    where: {
      merchantId: input.merchantId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.type ? { type: input.type } : {})
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function exportReconciliationDisputes(input: {
  merchantId: string;
  format: "csv" | "json";
}, client: Db = prisma) {
  const disputes = await listReconciliationDisputes({ merchantId: input.merchantId }, client);
  const rows = disputes.map((dispute) => ({
    disputeId: dispute.id,
    type: dispute.type,
    status: dispute.status,
    amount: Number(dispute.amount),
    awb: dispute.awb,
    orderId: dispute.orderId,
    courierId: dispute.courierId,
    reason: dispute.reason,
    createdAt: dispute.createdAt.toISOString()
  }));

  if (input.format === "json") return { contentType: "application/json", body: JSON.stringify({ disputes: rows }, null, 2) };

  const headers = ["disputeId", "type", "status", "amount", "awb", "orderId", "courierId", "reason", "createdAt"] as const;
  const body = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ].join("\n");

  return { contentType: "text/csv", body };
}

export async function updateReconciliationDispute(input: {
  id: string;
  merchantId: string;
  status?: DisputeWorkflowStatus | undefined;
  resolution?: Prisma.InputJsonObject | undefined;
}, client: Db = prisma) {
  const dispute = await client.reconciliationDispute.findFirst({
    where: { id: input.id, merchantId: input.merchantId }
  });
  if (!dispute) throw new HttpError(404, "DISPUTE_NOT_FOUND");

  const updated = await client.reconciliationDispute.update({
    where: { id: dispute.id },
    data: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
      ...(input.status === "RESOLVED" ? { resolvedAt: new Date() } : {})
    }
  });

  await audit({
    merchantId: input.merchantId,
    action: "RECONCILIATION_DISPUTE_UPDATED",
    entityType: "ReconciliationDispute",
    entityId: updated.id,
    metadata: { status: updated.status }
  }, client);

  return updated;
}

export async function courierPayables(merchantId: string, client: Db = prisma) {
  const [results, penalties] = await Promise.all([
    client.reconciliationResult.findMany({
      where: { merchantId },
      select: {
        courierId: true,
        expectedCodAmount: true,
        remittedCodAmount: true,
        invoicedCourierCharge: true,
        courierPayable: true,
        disputeAmount: true
      }
    }),
    client.courierPenalty.findMany({
      where: {
        merchantId,
        status: { not: "WAIVED" }
      },
      select: {
        courierId: true,
        penaltyAmount: true
      }
    })
  ]);

  const penaltyByCourier = new Map<string, number>();
  for (const penalty of penalties) {
    penaltyByCourier.set(
      penalty.courierId,
      money((penaltyByCourier.get(penalty.courierId) ?? 0) + num(penalty.penaltyAmount))
    );
  }

  return buildCourierPayableSummary(results.map((result) => ({
    courierId: result.courierId,
    expectedCodAmount: num(result.expectedCodAmount),
    remittedCodAmount: result.remittedCodAmount === null ? null : num(result.remittedCodAmount),
    invoicedCourierCharge: result.invoicedCourierCharge === null ? null : num(result.invoicedCourierCharge),
    courierPayable: result.courierPayable === null ? 0 : num(result.courierPayable),
    disputeAmount: num(result.disputeAmount)
  }))).map((row) => {
    const penaltyAmount = row.courierId ? penaltyByCourier.get(row.courierId) ?? 0 : 0;
    return {
      ...row,
      grossCourierPayable: row.courierPayable,
      penaltyAmount,
      courierPayable: money(Math.max(0, row.courierPayable - penaltyAmount))
    };
  });
}

export async function sellerSettlements(merchantId: string, client: Db = prisma) {
  return client.sellerSettlement.findMany({
    where: { merchantId },
    orderBy: { createdAt: "desc" },
    take: 200
  });
}

export async function approveSellerSettlement(input: {
  merchantId: string;
  settlementId: string;
}, client: typeof prisma = prisma) {
  return client.$transaction(async (tx: Prisma.TransactionClient) => {
    const settlement = await tx.sellerSettlement.findFirst({
      where: { id: input.settlementId, merchantId: input.merchantId }
    });
    if (!settlement) throw new HttpError(404, "SELLER_SETTLEMENT_NOT_FOUND");
    if (settlement.status === "BLOCKED") throw new HttpError(409, "SETTLEMENT_BLOCKED_BY_RECONCILIATION");

    const updated = await tx.sellerSettlement.update({
      where: { id: settlement.id },
      data: {
        status: "SETTLED",
        settledAt: new Date()
      }
    });

    await creditWallet({
      merchantId: input.merchantId,
      orderId: updated.orderId,
      awb: updated.awb,
      entryType: "SELLER_SETTLEMENT",
      amount: updated.sellerPayable,
      referenceType: "SellerSettlement",
      referenceId: updated.id,
      idempotencyKey: `seller-settlement:${updated.id}:direct-approval`,
      description: "Seller settlement released after reconciliation approval.",
      metadata: json({ settlementId: updated.id })
    }, tx);

    if (updated.reconciliationResultId) {
      await tx.reconciliationResult.update({
        where: { id: updated.reconciliationResultId },
        data: { status: "SETTLED" }
      });
    }

    await audit({
      merchantId: input.merchantId,
      action: "SELLER_SETTLEMENT_PAID",
      entityType: "SellerSettlement",
      entityId: updated.id,
      metadata: { amount: num(updated.sellerPayable) }
    }, tx);

    return updated;
  });
}
