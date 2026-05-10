import type {
  DisputeWorkflowStatus,
  PaymentHoldStatus,
  Prisma,
  ReconciliationDisputeType,
  ReconciliationStatus,
  SellerSettlementStatus
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type FinanceDashboardFilters = {
  merchantId: string;
  courierId?: string | undefined;
  sellerId?: string | undefined;
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
  status?: string | undefined;
  disputeType?: ReconciliationDisputeType | undefined;
};

export type FinanceDashboardResultRecord = {
  id: string;
  runId: string;
  merchantId: string;
  courierId: string | null;
  status: ReconciliationStatus;
  expectedCodAmount: unknown;
  remittedCodAmount: unknown;
  invoicedCourierCharge: unknown;
  courierPayable: unknown;
  disputeAmount: unknown;
  paymentHoldAmount: unknown;
  sellerPayable: unknown;
  mismatchAmount: unknown;
  createdAt: Date;
};

export type FinanceDashboardDisputeRecord = {
  id: string;
  reconciliationResultId: string | null;
  merchantId: string | null;
  courierId: string | null;
  type: ReconciliationDisputeType;
  status: DisputeWorkflowStatus;
  amount: unknown;
  createdAt: Date;
};

export type FinanceDashboardPaymentHoldRecord = {
  id: string;
  reconciliationResultId: string | null;
  merchantId: string;
  orderId: string | null;
  awb: string | null;
  reason: string;
  status: PaymentHoldStatus;
  amount: unknown;
  createdAt: Date;
};

export type FinanceDashboardSettlementRecord = {
  id: string;
  reconciliationResultId: string | null;
  merchantId: string;
  status: SellerSettlementStatus;
  sellerPayable: unknown;
  createdAt: Date;
  settledAt: Date | null;
};

export type FinanceDashboardPaymentHoldListItem = {
  id: string;
  orderId: string | null;
  awb: string | null;
  reason: string;
  status: PaymentHoldStatus;
  amount: number;
  amountPaise: number;
  createdAt: Date;
  releasedAt: Date | null;
};

type DashboardInput = {
  results: FinanceDashboardResultRecord[];
  disputes: FinanceDashboardDisputeRecord[];
  paymentHolds: FinanceDashboardPaymentHoldRecord[];
  settlements: FinanceDashboardSettlementRecord[];
  now?: Date | undefined;
};

const reconciliationStatuses = new Set<ReconciliationStatus>([
  "AUTO_APPROVED",
  "PARTIAL_MATCH",
  "COD_SHORTFALL",
  "COD_DELAYED",
  "INVOICE_MISMATCH",
  "WEIGHT_DISPUTE",
  "ZONE_DISPUTE",
  "DUPLICATE_BILLING",
  "MISSING_REMITTANCE",
  "RTO_CHARGE_REVIEW",
  "FAKE_ATTEMPT_REVIEW",
  "MANUAL_REVIEW",
  "PAYMENT_HOLD",
  "SETTLED"
]);

const disputeStatuses = new Set<DisputeWorkflowStatus>(["OPEN", "UNDER_REVIEW", "APPROVED", "REJECTED", "RESOLVED"]);
const holdStatuses = new Set<PaymentHoldStatus>(["ACTIVE", "RELEASED", "CANCELLED"]);
const settlementStatuses = new Set<SellerSettlementStatus>(["PENDING", "BLOCKED", "APPROVED", "SETTLED"]);

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function paise(value: unknown) {
  return Math.round(numberValue(value) * 100);
}

function dayKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function ageDays(createdAt: Date, now: Date) {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000)));
}

function ageingBucket(days: number) {
  if (days <= 3) return "0-3 days" as const;
  if (days <= 7) return "4-7 days" as const;
  if (days <= 15) return "8-15 days" as const;
  return "15+ days" as const;
}

function roundPercent(value: number) {
  return Math.round(value * 100) / 100;
}

function sum<T>(items: T[], selector: (item: T) => unknown) {
  return items.reduce((total, item) => total + numberValue(selector(item)), 0);
}

function isMismatch(result: FinanceDashboardResultRecord) {
  return result.status !== "AUTO_APPROVED" && result.status !== "SETTLED";
}

function addGroup<T extends Record<string, unknown>>(
  groups: Map<string, T>,
  key: string,
  seed: () => T,
  update: (group: T) => void
) {
  const group = groups.get(key) ?? seed();
  update(group);
  groups.set(key, group);
}

function baseGroup(key: string) {
  return {
    key,
    totalCodExpected: 0,
    totalCodReceived: 0,
    courierInvoiceTotal: 0,
    approvedCourierPayable: 0,
    disputedAmount: 0,
    paymentHoldAmount: 0,
    sellerPayable: 0,
    totalResults: 0,
    mismatchedResults: 0,
    mismatchRatePercent: 0
  };
}

function resultGroupMetrics(results: FinanceDashboardResultRecord[], keyFn: (result: FinanceDashboardResultRecord) => string) {
  const groups = new Map<string, ReturnType<typeof baseGroup>>();

  for (const result of results) {
    addGroup(groups, keyFn(result), () => baseGroup(keyFn(result)), (group) => {
      group.totalCodExpected += paise(result.expectedCodAmount);
      group.totalCodReceived += paise(result.remittedCodAmount);
      group.courierInvoiceTotal += paise(result.invoicedCourierCharge);
      group.approvedCourierPayable += result.status === "AUTO_APPROVED" || result.status === "SETTLED" ? paise(result.courierPayable) : 0;
      group.disputedAmount += paise(result.disputeAmount);
      group.paymentHoldAmount += paise(result.paymentHoldAmount);
      group.sellerPayable += paise(result.sellerPayable);
      group.totalResults += 1;
      group.mismatchedResults += isMismatch(result) ? 1 : 0;
    });
  }

  return [...groups.values()].map((group) => ({
    ...group,
    codPending: Math.max(0, group.totalCodExpected - group.totalCodReceived),
    mismatchRatePercent: group.totalResults ? roundPercent((group.mismatchedResults / group.totalResults) * 100) : 0
  }));
}

export function buildFinanceDashboardProjection(input: DashboardInput) {
  const now = input.now ?? new Date();
  const openDisputes = input.disputes.filter((dispute) => dispute.status === "OPEN" || dispute.status === "UNDER_REVIEW");
  const activeHolds = input.paymentHolds.filter((hold) => hold.status === "ACTIVE");
  const pendingSettlements = input.settlements.filter((settlement) => settlement.status === "PENDING" || settlement.status === "APPROVED");
  const releasedSettlements = input.settlements.filter((settlement) => settlement.status === "SETTLED");
  const totalResults = input.results.length;
  const mismatchedResults = input.results.filter(isMismatch).length;
  const ageingBuckets = {
    "0-3 days": 0,
    "4-7 days": 0,
    "8-15 days": 0,
    "15+ days": 0
  };

  for (const dispute of openDisputes) {
    ageingBuckets[ageingBucket(ageDays(dispute.createdAt, now))] += 1;
  }

  const totalCodExpected = paise(sum(input.results, (result) => result.expectedCodAmount));
  const totalCodReceived = paise(sum(input.results, (result) => result.remittedCodAmount));
  const codDelayed = paise(sum(input.disputes.filter((dispute) => dispute.type === "COD_DELAY"), (dispute) => dispute.amount));
  const courierInvoiceTotal = paise(sum(input.results, (result) => result.invoicedCourierCharge));
  const approvedCourierPayable = paise(sum(
    input.results.filter((result) => result.status === "AUTO_APPROVED" || result.status === "SETTLED"),
    (result) => result.courierPayable
  ));
  const disputedAmount = paise(sum(openDisputes, (dispute) => dispute.amount));
  const paymentHoldAmount = paise(sum(activeHolds, (hold) => hold.amount));
  const sellerPayable = paise(sum(input.results, (result) => result.sellerPayable));
  const sellerSettlementPending = paise(sum(pendingSettlements, (settlement) => settlement.sellerPayable));
  const sellerSettlementReleased = paise(sum(releasedSettlements, (settlement) => settlement.sellerPayable));

  return {
    metrics: {
      totalCodExpected,
      totalCodReceived,
      codPending: Math.max(0, totalCodExpected - totalCodReceived),
      codDelayed,
      courierInvoiceTotal,
      approvedCourierPayable,
      disputedAmount,
      paymentHoldAmount,
      sellerPayable,
      sellerSettlementPending,
      sellerSettlementReleased,
      sellerSettlementPendingCount: pendingSettlements.length,
      sellerSettlementReleasedCount: releasedSettlements.length,
      openDisputes: openDisputes.length,
      ageingDisputesOver7Days: openDisputes.filter((dispute) => ageDays(dispute.createdAt, now) > 7).length,
      duplicateBillingCount: input.disputes.filter((dispute) => dispute.type === "DUPLICATE_BILLING").length,
      unknownAwbCount: input.disputes.filter((dispute) => dispute.type === "UNKNOWN_AWB").length,
      weightDisputeCount: input.disputes.filter((dispute) => dispute.type === "WEIGHT_DISPUTE").length,
      rtoDisputeCount: input.disputes.filter((dispute) => dispute.type === "RTO_CHARGE_ISSUE").length,
      mismatchRatePercent: totalResults ? roundPercent((mismatchedResults / totalResults) * 100) : 0
    },
    ageingBuckets,
    groupBy: {
      courier: resultGroupMetrics(input.results, (result) => result.courierId ?? "UNKNOWN"),
      seller: resultGroupMetrics(input.results, (result) => result.merchantId),
      day: resultGroupMetrics(input.results, (result) => dayKey(result.createdAt)),
      reconciliationRun: resultGroupMetrics(input.results, (result) => result.runId)
    }
  };
}

function dateFilter(filters: FinanceDashboardFilters) {
  return {
    ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
    ...(filters.dateTo ? { lte: filters.dateTo } : {})
  };
}

function hasDateFilter(filters: FinanceDashboardFilters) {
  return Boolean(filters.dateFrom || filters.dateTo);
}

function resultStatus(status: string | undefined): ReconciliationStatus | undefined {
  return status && reconciliationStatuses.has(status as ReconciliationStatus) ? status as ReconciliationStatus : undefined;
}

function disputeStatus(status: string | undefined): DisputeWorkflowStatus | undefined {
  return status && disputeStatuses.has(status as DisputeWorkflowStatus) ? status as DisputeWorkflowStatus : undefined;
}

function holdStatus(status: string | undefined): PaymentHoldStatus | undefined {
  return status && holdStatuses.has(status as PaymentHoldStatus) ? status as PaymentHoldStatus : undefined;
}

function settlementStatus(status: string | undefined): SellerSettlementStatus | undefined {
  return status && settlementStatuses.has(status as SellerSettlementStatus) ? status as SellerSettlementStatus : undefined;
}

function shouldScopeByResults(filters: FinanceDashboardFilters) {
  return Boolean(filters.courierId || resultStatus(filters.status) || filters.disputeType);
}

export async function getFinanceDashboard(filters: FinanceDashboardFilters, client: Db = prisma) {
  const createdAt = dateFilter(filters);
  const reconciledStatus = resultStatus(filters.status);
  const reconciledDisputeStatus = disputeStatus(filters.status);
  const reconciledHoldStatus = holdStatus(filters.status);
  const reconciledSettlementStatus = settlementStatus(filters.status);
  const [results, disputes, paymentHolds, settlements] = await Promise.all([
    client.reconciliationResult.findMany({
      where: {
        merchantId: filters.merchantId,
        ...(filters.courierId ? { courierId: filters.courierId } : {}),
        ...(reconciledStatus ? { status: reconciledStatus } : {}),
        ...(filters.disputeType ? { disputes: { some: { type: filters.disputeType } } } : {}),
        ...(hasDateFilter(filters) ? { createdAt } : {})
      }
    }),
    client.reconciliationDispute.findMany({
      where: {
        merchantId: filters.merchantId,
        ...(filters.courierId ? { courierId: filters.courierId } : {}),
        ...(filters.disputeType ? { type: filters.disputeType } : {}),
        ...(reconciledDisputeStatus ? { status: reconciledDisputeStatus } : {}),
        ...(hasDateFilter(filters) ? { createdAt } : {})
      }
    }),
    client.paymentHold.findMany({
      where: {
        merchantId: filters.merchantId,
        ...(reconciledHoldStatus ? { status: reconciledHoldStatus } : {}),
        ...(hasDateFilter(filters) ? { createdAt } : {})
      }
    }),
    client.sellerSettlement.findMany({
      where: {
        merchantId: filters.merchantId,
        ...(reconciledSettlementStatus ? { status: reconciledSettlementStatus } : {}),
        ...(hasDateFilter(filters) ? { createdAt } : {})
      }
    })
  ]);

  const resultIds = new Set(results.map((result) => result.id));
  const scopedPaymentHolds = shouldScopeByResults(filters)
    ? paymentHolds.filter((hold) => hold.reconciliationResultId && resultIds.has(hold.reconciliationResultId))
    : paymentHolds;
  const scopedSettlements = shouldScopeByResults(filters)
    ? settlements.filter((settlement) => settlement.reconciliationResultId && resultIds.has(settlement.reconciliationResultId))
    : settlements;

  return buildFinanceDashboardProjection({
    results,
    disputes,
    paymentHolds: scopedPaymentHolds,
    settlements: scopedSettlements
  });
}

export async function listFinancePaymentHolds(filters: FinanceDashboardFilters, client: Db = prisma) {
  const createdAt = dateFilter(filters);
  const reconciledStatus = resultStatus(filters.status);
  const reconciledHoldStatus = holdStatus(filters.status);
  const resultWhere = {
    merchantId: filters.merchantId,
    ...(filters.courierId ? { courierId: filters.courierId } : {}),
    ...(reconciledStatus ? { status: reconciledStatus } : {}),
    ...(filters.disputeType ? { disputes: { some: { type: filters.disputeType } } } : {}),
    ...(hasDateFilter(filters) ? { createdAt } : {})
  };
  const [results, holds] = await Promise.all([
    shouldScopeByResults(filters)
      ? client.reconciliationResult.findMany({ where: resultWhere, select: { id: true } })
      : Promise.resolve([]),
    client.paymentHold.findMany({
      where: {
        merchantId: filters.merchantId,
        ...(reconciledHoldStatus ? { status: reconciledHoldStatus } : {}),
        ...(hasDateFilter(filters) ? { createdAt } : {})
      },
      orderBy: { createdAt: "desc" }
    })
  ]);

  const resultIds = new Set(results.map((result) => result.id));
  const scopedHolds = shouldScopeByResults(filters)
    ? holds.filter((hold) => hold.reconciliationResultId && resultIds.has(hold.reconciliationResultId))
    : holds;

  return scopedHolds.map((hold) => ({
    id: hold.id,
    orderId: hold.orderId,
    awb: hold.awb,
    reason: hold.reason,
    status: hold.status,
    amount: numberValue(hold.amount),
    amountPaise: paise(hold.amount),
    createdAt: hold.createdAt,
    releasedAt: hold.releasedAt
  }));
}
