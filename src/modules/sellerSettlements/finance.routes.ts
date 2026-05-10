import { Router, type Request } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import {
  getFinanceDashboard,
  listFinancePaymentHolds,
  type FinanceDashboardFilters
} from "./finance-dashboard.service.js";
import {
  approveFinanceApprovalRequest,
  buildCourierSettlementCalendar,
  calculateCourierPenalties,
  createFinanceApprovalRequest,
  createPaymentBlockNote,
  exportReconciliationStatement,
  listCourierFinancePolicies,
  listCourierPenalties,
  listFinanceApprovals,
  listPaymentBlockNotes,
  rejectFinanceApprovalRequest,
  upsertCourierFinancePolicy
} from "./finance-policy.service.js";
import {
  courierPayables,
  sellerSettlements
} from "./seller-settlements.service.js";

export const financeRouter = Router();

const reconciliationStatuses = [
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
] as const;
const disputeTypes = [
  "INVOICE_MISMATCH",
  "COD_SHORTFALL",
  "COD_DELAY",
  "DUPLICATE_BILLING",
  "UNKNOWN_AWB",
  "WEIGHT_DISPUTE",
  "ZONE_DISPUTE",
  "RTO_CHARGE_ISSUE",
  "FAKE_ATTEMPT_NDR_ISSUE"
] as const;
const disputeStatuses = ["OPEN", "UNDER_REVIEW", "APPROVED", "REJECTED", "RESOLVED"] as const;
const paymentHoldStatuses = ["ACTIVE", "RELEASED", "CANCELLED"] as const;
const settlementStatuses = ["PENDING", "BLOCKED", "APPROVED", "SETTLED"] as const;
const financeApprovalStatuses = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
const settlementFrequencies = ["WEEKLY", "BIWEEKLY", "MONTHLY"] as const;
const statementPeriods = ["monthly", "yearly", "till_date"] as const;
const statementFormats = ["csv", "json"] as const;
const financeStatuses = new Set<string>([
  ...reconciliationStatuses,
  ...disputeStatuses,
  ...paymentHoldStatuses,
  ...settlementStatuses
]);

const financeDashboardQuerySchema = z.object({
  courierId: z.string().min(1).optional(),
  sellerId: z.string().min(1).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  status: z.string().min(1).optional().refine((status) => !status || financeStatuses.has(status), {
    message: "Invalid finance status"
  }),
  disputeType: z.enum(disputeTypes).optional()
}).refine((query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo, {
  message: "dateFrom must be before dateTo",
  path: ["dateTo"]
});

type FinanceDashboard = Awaited<ReturnType<typeof getFinanceDashboard>>;

function dashboardFilters(req: Request): FinanceDashboardFilters {
  const query = financeDashboardQuerySchema.parse(req.query);
  const merchantId = req.auth!.merchantId;

  if (query.sellerId && query.sellerId !== merchantId) {
    throw new HttpError(403, "SELLER_SCOPE_FORBIDDEN");
  }

  return {
    merchantId,
    courierId: query.courierId,
    sellerId: query.sellerId,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    status: query.status,
    disputeType: query.disputeType
  };
}

const policyBodySchema = z.object({
  creditPeriodDays: z.coerce.number().int().min(0).max(90).optional(),
  codRemittanceSlaDays: z.coerce.number().int().min(0).max(45).optional(),
  penaltyGraceDays: z.coerce.number().int().min(0).max(45).optional(),
  codDelayPenaltyRateBps: z.coerce.number().int().min(0).max(10_000).optional(),
  codDelayPenaltyFixedAmount: z.coerce.number().min(0).optional(),
  maxCodDelayPenaltyAmount: z.coerce.number().min(0).nullable().optional(),
  settlementFrequency: z.enum(settlementFrequencies).optional(),
  settlementAnchorDay: z.coerce.number().int().min(1).max(31).optional(),
  makerCheckerRequired: z.coerce.boolean().optional(),
  active: z.coerce.boolean().optional(),
  notes: z.string().max(1_000).nullable().optional()
});

const courierScopedQuerySchema = z.object({
  courierId: z.string().min(1).optional()
});

const courierCalendarQuerySchema = courierScopedQuerySchema.extend({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional()
}).refine((query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo, {
  message: "dateFrom must be before dateTo",
  path: ["dateTo"]
});

const approvalQuerySchema = z.object({
  status: z.enum(financeApprovalStatuses).optional()
});

const statementQuerySchema = z.object({
  period: z.enum(statementPeriods),
  format: z.enum(statementFormats).default("csv"),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  courierId: z.string().min(1).optional()
});

function codSummary(dashboard: FinanceDashboard) {
  const { metrics } = dashboard;
  return {
    totalCodExpected: metrics.totalCodExpected,
    totalCodReceived: metrics.totalCodReceived,
    codPending: metrics.codPending,
    codDelayed: metrics.codDelayed,
    mismatchRatePercent: metrics.mismatchRatePercent
  };
}

function courierSummary(dashboard: FinanceDashboard) {
  const { metrics } = dashboard;
  return {
    courierInvoiceTotal: metrics.courierInvoiceTotal,
    approvedCourierPayable: metrics.approvedCourierPayable,
    disputedAmount: metrics.disputedAmount,
    duplicateBillingCount: metrics.duplicateBillingCount,
    unknownAwbCount: metrics.unknownAwbCount,
    weightDisputeCount: metrics.weightDisputeCount,
    rtoDisputeCount: metrics.rtoDisputeCount,
    mismatchRatePercent: metrics.mismatchRatePercent
  };
}

function disputeSummary(dashboard: FinanceDashboard) {
  const { metrics } = dashboard;
  return {
    disputedAmount: metrics.disputedAmount,
    openDisputes: metrics.openDisputes,
    ageingDisputesOver7Days: metrics.ageingDisputesOver7Days,
    duplicateBillingCount: metrics.duplicateBillingCount,
    unknownAwbCount: metrics.unknownAwbCount,
    weightDisputeCount: metrics.weightDisputeCount,
    rtoDisputeCount: metrics.rtoDisputeCount
  };
}

function sellerSettlementSummary(dashboard: FinanceDashboard) {
  const { metrics } = dashboard;
  return {
    sellerPayable: metrics.sellerPayable,
    sellerSettlementPending: metrics.sellerSettlementPending,
    sellerSettlementReleased: metrics.sellerSettlementReleased,
    sellerSettlementPendingCount: metrics.sellerSettlementPendingCount,
    sellerSettlementReleasedCount: metrics.sellerSettlementReleasedCount
  };
}

financeRouter.get("/courier-policies", async (req, res) => {
  const policies = await listCourierFinancePolicies(req.auth!.merchantId);

  res.json({ policies });
});

financeRouter.patch("/courier-policies/:courierId", async (req, res) => {
  const policy = await upsertCourierFinancePolicy({
    merchantId: req.auth!.merchantId,
    courierId: z.string().min(1).parse(req.params.courierId),
    actorId: req.auth!.userId,
    data: policyBodySchema.parse(req.body)
  });

  res.json({ policy });
});

financeRouter.post("/courier-penalties/calculate", async (req, res) => {
  const body = z.object({
    courierId: z.string().min(1).optional(),
    runId: z.string().min(1).optional()
  }).parse(req.body);
  const penalties = await calculateCourierPenalties({
    merchantId: req.auth!.merchantId,
    courierId: body.courierId,
    runId: body.runId
  });

  res.json({ penalties });
});

financeRouter.get("/courier-penalties", async (req, res) => {
  const query = courierScopedQuerySchema.parse(req.query);
  const penalties = await listCourierPenalties({
    merchantId: req.auth!.merchantId,
    courierId: query.courierId
  });

  res.json({ penalties });
});

financeRouter.get("/courier-settlement-calendar", async (req, res) => {
  const query = courierCalendarQuerySchema.parse(req.query);
  const calendar = await buildCourierSettlementCalendar({
    merchantId: req.auth!.merchantId,
    courierId: query.courierId,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo
  });

  res.json({ calendar });
});

financeRouter.get("/payment-approvals", async (req, res) => {
  const query = approvalQuerySchema.parse(req.query);
  const approvals = await listFinanceApprovals({
    merchantId: req.auth!.merchantId,
    status: query.status
  });

  res.json({ approvals });
});

financeRouter.post("/payment-approvals/:approvalId/approve", async (req, res) => {
  const result = await approveFinanceApprovalRequest({
    merchantId: req.auth!.merchantId,
    approvalId: z.string().min(1).parse(req.params.approvalId),
    checkedBy: req.auth!.userId
  });

  res.json(result);
});

financeRouter.post("/payment-approvals/:approvalId/reject", async (req, res) => {
  const body = z.object({
    rejectionReason: z.string().max(1_000).optional()
  }).parse(req.body);
  const approval = await rejectFinanceApprovalRequest({
    merchantId: req.auth!.merchantId,
    approvalId: z.string().min(1).parse(req.params.approvalId),
    checkedBy: req.auth!.userId,
    rejectionReason: body.rejectionReason
  });

  res.json({ approval });
});

financeRouter.get("/blocked-payment-notes", async (req, res) => {
  const query = courierScopedQuerySchema.parse(req.query);
  const notes = await listPaymentBlockNotes({
    merchantId: req.auth!.merchantId,
    courierId: query.courierId
  });

  res.json({ notes });
});

financeRouter.post("/blocked-payment-notes", async (req, res) => {
  const body = z.object({
    reasonCode: z.string().min(1).max(80),
    note: z.string().min(1).max(1_000),
    paymentHoldId: z.string().min(1).optional(),
    settlementId: z.string().min(1).optional(),
    approvalId: z.string().min(1).optional(),
    courierId: z.string().min(1).optional()
  }).refine((value) => Boolean(value.paymentHoldId || value.settlementId || value.approvalId || value.courierId), {
    message: "A note target is required"
  }).parse(req.body);
  const note = await createPaymentBlockNote({
    merchantId: req.auth!.merchantId,
    createdBy: req.auth!.userId,
    reasonCode: body.reasonCode,
    note: body.note,
    paymentHoldId: body.paymentHoldId,
    settlementId: body.settlementId,
    approvalId: body.approvalId,
    courierId: body.courierId
  });

  res.status(201).json({ note });
});

financeRouter.get("/reconciliation-statements/export", async (req, res) => {
  const query = statementQuerySchema.parse(req.query);
  const exported = await exportReconciliationStatement({
    merchantId: req.auth!.merchantId,
    period: query.period,
    format: query.format,
    year: query.year,
    month: query.month,
    courierId: query.courierId
  });

  res.type(exported.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${exported.fileName}"`);
  res.send(exported.body);
});

financeRouter.get("/dashboard", async (req, res) => {
  const dashboard = await getFinanceDashboard(dashboardFilters(req));

  res.json({ dashboard });
});

financeRouter.get("/cod-summary", async (req, res) => {
  const dashboard = await getFinanceDashboard(dashboardFilters(req));

  res.json({
    summary: codSummary(dashboard),
    groupBy: {
      courier: dashboard.groupBy.courier,
      seller: dashboard.groupBy.seller,
      day: dashboard.groupBy.day,
      reconciliationRun: dashboard.groupBy.reconciliationRun
    }
  });
});

financeRouter.get("/courier-summary", async (req, res) => {
  const dashboard = await getFinanceDashboard(dashboardFilters(req));

  res.json({
    summary: courierSummary(dashboard),
    courier: dashboard.groupBy.courier,
    day: dashboard.groupBy.day,
    reconciliationRun: dashboard.groupBy.reconciliationRun
  });
});

financeRouter.get("/dispute-summary", async (req, res) => {
  const dashboard = await getFinanceDashboard(dashboardFilters(req));

  res.json({
    summary: disputeSummary(dashboard),
    ageingBuckets: dashboard.ageingBuckets,
    groupBy: {
      courier: dashboard.groupBy.courier,
      seller: dashboard.groupBy.seller,
      day: dashboard.groupBy.day,
      reconciliationRun: dashboard.groupBy.reconciliationRun
    }
  });
});

financeRouter.get("/payment-holds", async (req, res) => {
  const filters = dashboardFilters(req);
  const [dashboard, holds] = await Promise.all([
    getFinanceDashboard(filters),
    listFinancePaymentHolds(filters)
  ]);

  res.json({
    summary: {
      paymentHoldAmount: dashboard.metrics.paymentHoldAmount,
      activePaymentHoldCount: holds.filter((hold) => hold.status === "ACTIVE").length
    },
    holds
  });
});

financeRouter.get("/seller-settlement-summary", async (req, res) => {
  const dashboard = await getFinanceDashboard(dashboardFilters(req));

  res.json({
    summary: sellerSettlementSummary(dashboard),
    seller: dashboard.groupBy.seller,
    day: dashboard.groupBy.day,
    reconciliationRun: dashboard.groupBy.reconciliationRun
  });
});

financeRouter.get("/courier-payables", async (req, res) => {
  const payables = await courierPayables(req.auth!.merchantId);

  res.json({ payables });
});

financeRouter.get("/seller-settlements", async (req, res) => {
  const settlements = await sellerSettlements(req.auth!.merchantId);

  res.json({ settlements });
});

financeRouter.post("/payment-approval", async (req, res) => {
  const body = z.object({
    settlementId: z.string().min(1).optional(),
    paymentHoldId: z.string().min(1).optional(),
    courierId: z.string().min(1).optional(),
    amount: z.coerce.number().min(0).optional(),
    reason: z.string().max(1_000).optional()
  }).refine((value) => Boolean(value.settlementId || value.paymentHoldId || value.courierId), {
    message: "settlementId, paymentHoldId, or courierId is required"
  }).parse(req.body);

  const approval = await createFinanceApprovalRequest({
    merchantId: req.auth!.merchantId,
    requestedBy: req.auth!.userId,
    settlementId: body.settlementId,
    paymentHoldId: body.paymentHoldId,
    courierId: body.courierId,
    amount: body.amount,
    reason: body.reason
  });

  res.status(202).json({ approval });
});
