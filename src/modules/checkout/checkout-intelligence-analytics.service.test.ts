import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";

import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { requireMasterAdminJwt } from "../../middleware/jwtAuth.js";
import { errorHandler } from "../../middleware/error.js";
import {
  CheckoutIntelligenceAnalyticsService,
  sanitizeCheckoutIntelligencePayload
} from "./checkout-intelligence-analytics.service.js";
import { createAdminCheckoutIntelligenceRouter } from "./checkout-intelligence-admin.routes.js";
import {
  buildCheckoutIntelligenceCsvExport,
  CHECKOUT_INTELLIGENCE_EXPORT_REPORT_SEQUENCE
} from "./checkout-intelligence-export.service.js";

const now = new Date("2026-07-06T12:00:00.000Z");
const merchantId = "merchant_skymax";
const otherMerchantId = "merchant_other";
const originalUserFindUnique = prisma.user.findUnique.bind(prisma.user);

type Row = Record<string, any>;

afterEach(() => {
  Object.defineProperty(prisma.user, "findUnique", {
    configurable: true,
    value: originalUserFindUnique
  });
});

function mockUserFindUnique(role: "MASTER_ADMIN" | "ADMIN") {
  Object.defineProperty(prisma.user, "findUnique", {
    configurable: true,
    value: async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: role === "MASTER_ADMIN" ? "indraveer.chauhan@gmail.com" : "ops-admin@shipmastr.test",
      userType: "INTERNAL_SHIPMASTR",
      role
    })
  });
}

function signRole(role: string) {
  return jwt.sign({
    userId: "user_1",
    merchantId: "merchant_1",
    role
  }, env.JWT_SECRET);
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withCheckoutIntelligenceApp<T>(
  service: CheckoutIntelligenceAnalyticsService,
  callback: (baseUrl: string) => Promise<T>
) {
  const app = express();
  app.use(
    "/admin/checkout-intelligence",
    requireMasterAdminJwt,
    createAdminCheckoutIntelligenceRouter(service)
  );
  app.use(errorHandler);
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CHECKOUT_INTELLIGENCE_TEST_SERVER_ADDRESS_UNAVAILABLE");

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

function matchesScalar(value: any, condition: any): boolean {
  if (condition && typeof condition === "object" && !(condition instanceof Date) && !Array.isArray(condition)) {
    if ("in" in condition) return condition.in.includes(value);
    if ("gte" in condition && value < condition.gte) return false;
    if ("lte" in condition && value > condition.lte) return false;
    if ("not" in condition && value === condition.not) return false;
    return true;
  }
  return value === condition;
}

function matchesWhere(row: Row, where: Row = {}): boolean {
  if (where.AND && !where.AND.every((child: Row) => matchesWhere(row, child))) return false;
  if (where.OR && !where.OR.some((child: Row) => matchesWhere(row, child))) return false;

  for (const [key, condition] of Object.entries(where)) {
    if (key === "AND" || key === "OR") continue;
    if (!matchesScalar(row[key], condition)) return false;
  }

  return true;
}

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined) {
  const sorters = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...rows].sort((left, right) => {
    for (const sorter of sorters) {
      const [field, direction] = Object.entries(sorter)[0] ?? [];
      if (!field) continue;
      const leftValue = left[field] ?? "";
      const rightValue = right[field] ?? "";
      if (leftValue === rightValue) continue;
      const result = leftValue > rightValue ? 1 : -1;
      return direction === "desc" ? -result : result;
    }
    return 0;
  });
}

function delegate(rows: Row[], options: { attempts?: Row[] } = {}) {
  return {
    async findMany(args: Row = {}) {
      let result = rows.filter((row) => matchesWhere(row, args.where ?? {}));
      result = sortRows(result, args.orderBy);
      if (args.cursor?.id) {
        const index = result.findIndex((row) => row.id === args.cursor.id);
        result = index >= 0 ? result.slice(index + (args.skip ?? 0)) : result;
      }
      if (args.take) result = result.slice(0, args.take);
      if (args.include?.telemetryPaymentAttempt) {
        return result.map((row) => ({
          ...row,
          telemetryPaymentAttempt: options.attempts?.find((attempt) => attempt.id === row.telemetryPaymentAttemptId) ?? null
        }));
      }
      return result;
    },
    async count(args: Row = {}) {
      return rows.filter((row) => matchesWhere(row, args.where ?? {})).length;
    }
  };
}

function createClient() {
  const sessions = [
    {
      id: "session_completed",
      merchantId,
      sellerId: "seller_populated",
      checkoutOrderId: "order_completed",
      sessionId: "sess_completed",
      deviceType: "MOBILE",
      status: "COMPLETED",
      cartValueMinor: 150000n,
      currency: "INR",
      startedAt: new Date("2026-07-06T09:00:00.000Z")
    },
    {
      id: "session_refund_due",
      merchantId,
      sellerId: null,
      checkoutOrderId: "order_refund_due",
      sessionId: "sess_refund_due",
      deviceType: "DESKTOP",
      status: "STARTED",
      cartValueMinor: 1000n,
      currency: "INR",
      startedAt: new Date("2026-07-06T09:05:00.000Z")
    },
    {
      id: "session_abandoned",
      merchantId,
      sellerId: null,
      checkoutOrderId: "order_abandoned",
      sessionId: "sess_abandoned",
      deviceType: "DESKTOP",
      status: "ABANDONED",
      cartValueMinor: 2000n,
      currency: "INR",
      startedAt: new Date("2026-07-06T09:10:00.000Z"),
      abandonedAt: new Date("2026-07-06T11:10:00.000Z")
    },
    {
      id: "session_other",
      merchantId: otherMerchantId,
      sellerId: null,
      checkoutOrderId: "order_other",
      sessionId: "sess_other",
      deviceType: "TABLET",
      status: "COMPLETED",
      cartValueMinor: 999n,
      currency: "INR",
      startedAt: new Date("2026-07-06T09:20:00.000Z")
    }
  ];
  const events = [
    { id: "event_order_1", eventName: "order_placed", telemetrySessionId: "session_completed", merchantId, sellerId: "seller_populated", checkoutOrderId: "order_completed", source: "ORDER_SERVICE", occurredAt: new Date("2026-07-06T09:00:00.000Z"), payloadJson: { orderState: "confirmed" } },
    { id: "event_success_1", eventName: "payment_succeeded", telemetrySessionId: "session_completed", merchantId, sellerId: "seller_populated", checkoutOrderId: "order_completed", checkoutPaymentId: "payment_captured", source: "PAYMENT_WEBHOOK", occurredAt: new Date("2026-07-06T09:01:00.000Z"), payloadJson: { gateway: "mock" } },
    { id: "event_order_2", eventName: "order_placed", telemetrySessionId: "session_refund_due", merchantId, sellerId: null, checkoutOrderId: "order_refund_due", source: "ORDER_SERVICE", occurredAt: new Date("2026-07-06T09:05:00.000Z"), payloadJson: { orderState: "cancelled" } },
    { id: "event_failed_refund", eventName: "payment_failed", telemetrySessionId: "session_refund_due", merchantId, sellerId: null, checkoutOrderId: "order_refund_due", checkoutPaymentId: "payment_refund_due", source: "PAYMENT_WEBHOOK", occurredAt: new Date("2026-07-06T09:06:00.000Z"), payloadJson: { reason: "late_capture" } },
    { id: "event_order_3", eventName: "order_placed", telemetrySessionId: "session_abandoned", merchantId, sellerId: null, checkoutOrderId: "order_abandoned", source: "ORDER_SERVICE", occurredAt: new Date("2026-07-06T09:10:00.000Z"), payloadJson: { buyerEmail: "buyer@example.test" } },
    { id: "event_abandoned", eventName: "checkout_abandoned", telemetrySessionId: "session_abandoned", merchantId, sellerId: null, checkoutOrderId: "order_abandoned", source: "WORKER", occurredAt: new Date("2026-07-06T11:10:00.000Z"), payloadJson: { phone: "+919999999999", ipAddress: "203.0.113.10", safe: "visible", neutral: "203.0.113.10", note: "Ship to 221B Market Road" } },
    { id: "event_order_other", eventName: "order_placed", telemetrySessionId: "session_other", merchantId: otherMerchantId, sellerId: null, checkoutOrderId: "order_other", source: "ORDER_SERVICE", occurredAt: new Date("2026-07-06T09:20:00.000Z"), payloadJson: {} }
  ];
  const attempts = [
    { id: "attempt_success", telemetrySessionId: "session_completed", merchantId, sellerId: "seller_populated", checkoutOrderId: "order_completed", paymentMethod: "prepaid", gatewayUsed: "mock", status: "SUCCEEDED", amountMinor: 150000n, currency: "INR", createdAt: new Date("2026-07-06T09:00:30.000Z") },
    { id: "attempt_refund_due", telemetrySessionId: "session_refund_due", merchantId, sellerId: null, checkoutOrderId: "order_refund_due", paymentMethod: "partial_cod", gatewayUsed: "mock", status: "FAILED", errorCode: "CHECKOUT_PAYMENT_REFUND_DUE", amountMinor: 1000n, currency: "INR", createdAt: new Date("2026-07-06T09:05:30.000Z") }
  ];
  const failures = [
    { id: "failure_refund_due", telemetrySessionId: "session_refund_due", merchantId, sellerId: null, checkoutOrderId: "order_refund_due", checkoutPaymentId: "payment_refund_due", telemetryPaymentAttemptId: "attempt_refund_due", failureStage: "PAYMENT", failureReason: "late_capture_refund_due", failureCode: "CHECKOUT_PAYMENT_REFUND_DUE", amountAtRiskMinor: 1000n, currency: "INR", source: "PAYMENT_WEBHOOK", createdAt: new Date("2026-07-06T09:06:00.000Z") },
    { id: "failure_abandoned", telemetrySessionId: "session_abandoned", merchantId, sellerId: null, checkoutOrderId: "order_abandoned", telemetryPaymentAttemptId: null, failureStage: "UNKNOWN", failureReason: "checkout_abandoned", failureCode: "CHECKOUT_ABANDONED", amountAtRiskMinor: 2000n, currency: "INR", source: "WORKER", createdAt: new Date("2026-07-06T11:10:00.000Z") }
  ];
  const orders = [
    { id: "order_completed", merchantId, mode: "prepaid", createdAt: new Date("2026-07-06T09:00:00.000Z") },
    { id: "order_refund_due", merchantId, mode: "partial_cod", createdAt: new Date("2026-07-06T09:05:00.000Z") },
    { id: "order_cod", merchantId, mode: "full_cod", createdAt: new Date("2026-07-06T09:15:00.000Z") },
    { id: "order_other", merchantId: otherMerchantId, mode: "partial_cod", createdAt: new Date("2026-07-06T09:20:00.000Z") }
  ];
  const merchants = [
    { id: merchantId, name: "Skymax Demo Merchant" },
    { id: otherMerchantId, name: "Other Merchant" }
  ];

  return {
    checkoutTelemetrySession: delegate(sessions),
    checkoutTelemetryEvent: delegate(events),
    checkoutTelemetryPaymentAttempt: delegate(attempts),
    checkoutTelemetryFailure: delegate(failures, { attempts }),
    checkoutOrder: delegate(orders),
    merchant: delegate(merchants)
  };
}

function createService() {
  return new CheckoutIntelligenceAnalyticsService(createClient(), () => now);
}

describe("CheckoutIntelligenceAnalyticsService", () => {
  it("returns overview with partial conversion semantics and refund_due as payment leakage", async () => {
    const overview = await createService().getOverview({ merchantId });

    assert.equal(overview.metrics.checkoutStartedSessions, 3);
    assert.equal(overview.metrics.orderPlaced, 3);
    assert.equal(overview.metrics.paymentSucceeded, 1);
    assert.equal(overview.metrics.paymentFailed, 1);
    assert.equal(overview.metrics.checkoutAbandoned, 1);
    assert.equal(overview.metrics.conversionRateMeaningful, false);
    assert.equal(overview.metrics.paymentFailureValueMinor, "1000");
    assert.equal(overview.metrics.abandonedCheckoutValueMinor, "2000");
    assert.equal(overview.dataAvailability.checkoutConversionRate, "partial_current_sessions_begin_at_order_placement");
    assert.match(overview.dataAvailability.refundDue, /CHECKOUT_PAYMENT_REFUND_DUE/);
  });

  it("marks frontend funnel stages as unavailable while counting backend telemetry", async () => {
    const funnel = await createService().getFunnel({ merchantId });
    const stage = (key: string) => funnel.stages.find((row) => row.key === key);

    assert.equal(stage("cart_viewed")?.count, 0);
    assert.equal(stage("cart_viewed")?.instrumented, false);
    assert.equal(stage("order_placed")?.count, 3);
    assert.equal(stage("payment_succeeded")?.count, 1);
    assert.equal(stage("payment_failed")?.revenueAtRiskMinor, "1000");
    assert.equal(stage("checkout_abandoned")?.revenueAtRiskMinor, "2000");
    assert.match(funnel.dataAvailability.note, /future frontend telemetry/);
  });

  it("summarizes revenue leakage and payment failures without treating refund_due as success", async () => {
    const service = createService();
    const leakage = await service.getRevenueLeakage({ merchantId });
    const paymentFailures = await service.getPaymentFailures({ merchantId });
    const byMerchant = leakage.byMerchant as any[];
    const byErrorCode = leakage.byErrorCode as any[];

    assert.equal(leakage.totalAmountAtRiskMinor, "3000");
    assert.equal(byMerchant[0]?.merchantName, "Skymax Demo Merchant");
    assert.equal(byErrorCode.some((row) => row.key === "CHECKOUT_PAYMENT_REFUND_DUE"), true);
    assert.equal(paymentFailures.totalAttempts, 2);
    assert.equal(paymentFailures.failedAttempts, 1);
    assert.equal(paymentFailures.totalAmountAtRiskMinor, "1000");
    assert.equal(paymentFailures.refundDueFailureCode, "CHECKOUT_PAYMENT_REFUND_DUE");
  });

  it("keeps COD OTP metrics zero unless checkout COD telemetry events exist", async () => {
    const codRisk = await createService().getCodRisk({ merchantId });

    assert.equal(codRisk.metrics.codSelected, 0);
    assert.equal(codRisk.metrics.checkoutCodOtpRequested, 0);
    assert.equal(codRisk.metrics.checkoutCodOtpVerified, 0);
    assert.equal(codRisk.metrics.checkoutCodOtpFailed, 0);
    assert.equal(codRisk.metrics.checkoutCodOtpAbandoned, 0);
    assert.equal(codRisk.metrics.codOrderPlaced, 2);
    assert.match(codRisk.dataAvailability.note, /Checkout COD OTP telemetry is not instrumented yet/);
  });

  it("returns merchant breakdown without seller breakdown or inferred seller attribution", async () => {
    const service = createService();
    const allMerchants = await service.getMerchantBreakdown({});
    const sellerFiltered = await service.getMerchantBreakdown({ sellerId: "seller_populated" });
    const forbiddenBreakdownKey = "seller" + "Breakdown";

    assert.equal(allMerchants.merchants.some((row) => row.merchantName === "Skymax Demo Merchant"), true);
    assert.equal(forbiddenBreakdownKey in allMerchants, false);
    assert.equal(allMerchants.dataAvailability.breakdownScope, "merchant_only");
    assert.equal(sellerFiltered.merchants.length, 1);
    assert.equal(sellerFiltered.merchants[0]?.merchantId, merchantId);
  });

  it("lists abandoned checkouts from worker-derived session state", async () => {
    const abandoned = await createService().getAbandonedCheckouts({ merchantId });

    assert.equal(abandoned.abandonedCheckouts.length, 1);
    assert.equal(abandoned.abandonedCheckouts[0]?.telemetrySessionId, "session_abandoned");
    assert.equal(abandoned.abandonedCheckouts[0]?.merchantName, "Skymax Demo Merchant");
    assert.equal(abandoned.abandonedCheckouts[0]?.failureCode, "CHECKOUT_ABANDONED");
    assert.equal(abandoned.abandonedCheckouts[0]?.amountAtRiskMinor, "2000");
  });

  it("sanitizes event payloads before exposing the admin event log", async () => {
    const eventLog = await createService().getEventLog({ merchantId });
    const abandoned = eventLog.events.find((event: any) => event.eventName === "checkout_abandoned");

    assert.deepEqual(abandoned?.payload, { safe: "visible", neutral: "[redacted]", note: "[redacted]" });
    assert.deepEqual(sanitizeCheckoutIntelligencePayload({ note: "email buyer@example.test phone 9999999999" }), {
      note: "[redacted]"
    });
    assert.deepEqual(sanitizeCheckoutIntelligencePayload({ note: "Client IP 203.0.113.10" }), {
      note: "[redacted]"
    });
    assert.deepEqual(sanitizeCheckoutIntelligencePayload({ note: "Ship to 221B Market Road" }), {
      note: "[redacted]"
    });
    assert.deepEqual(sanitizeCheckoutIntelligencePayload({
      delivery: { line1: "221B Market Road", city: "Delhi", safe: "visible" }
    }), {
      delivery: { safe: "visible" }
    });
  });

  it("keeps Checkout Intelligence endpoints on the existing guarded router and avoids master routes", () => {
    const adminRoutes = readFileSync("src/modules/checkout/checkout-intelligence-admin.routes.ts", "utf8");
    const exportService = readFileSync("src/modules/checkout/checkout-intelligence-export.service.ts", "utf8");
    const indexRoutes = readFileSync("src/routes/index.ts", "utf8");

    for (const route of [
      "overview",
      "funnel",
      "revenue-leakage",
      "payment-failures",
      "cod-risk",
      "merchant-breakdown",
      "abandoned-checkouts",
      "events"
    ]) {
      assert.match(adminRoutes, new RegExp(`router\\.get\\("\\/${route}"`));
      assert.match(exportService, new RegExp(`pathSegment: "${route}"`));
    }

    assert.match(adminRoutes, /CHECKOUT_INTELLIGENCE_EXPORT_REPORT_SEQUENCE/);
    assert.match(adminRoutes, /report\.pathSegment\}\/export/);
    assert.match(adminRoutes, /abandonment-worker\/run-once/);
    assert.match(indexRoutes, /apiRouter\.use\("\/admin\/checkout-intelligence", requireMasterAdminJwt, adminCheckoutIntelligenceRouter\)/);
    assert.doesNotMatch(indexRoutes, /\/api\/master|\/master\/checkout-intelligence/);
    assert.doesNotMatch(adminRoutes, new RegExp(`${["Seller", "Breakdown"].join(" ")}|seller-breakdown`));
  });
});

describe("Checkout Intelligence CSV export", () => {
  it("builds CSV exports for every supported report with metadata, filters, and report filenames", async () => {
    for (const report of CHECKOUT_INTELLIGENCE_EXPORT_REPORT_SEQUENCE) {
      const exported = await buildCheckoutIntelligenceCsvExport({
        report: report.key,
        filters: { merchantId, dateFrom: new Date("2026-07-06T00:00:00.000Z") },
        analyticsService: createService(),
        generatedAt: now
      });

      assert.equal(exported.contentType, "text/csv");
      assert.equal(exported.fileName, `checkout-intelligence-${report.fileSegment}-20260706-1200.csv`);
      assert.match(exported.body, /generatedAt,2026-07-06T12:00:00.000Z/);
      assert.match(exported.body, new RegExp(`reportName,${report.reportName}`));
      assert.match(exported.body, /filter\.merchantId,merchant_skymax/);
      assert.match(exported.body, /note\.conversionRateMeaningful,false/);
    }
  });

  it("exports revenue and payment leakage without treating refund_due as success", async () => {
    const paymentFailures = await buildCheckoutIntelligenceCsvExport({
      report: "paymentFailures",
      filters: { merchantId },
      analyticsService: createService(),
      generatedAt: now
    });
    const leakage = await buildCheckoutIntelligenceCsvExport({
      report: "revenueLeakage",
      filters: { merchantId },
      analyticsService: createService(),
      generatedAt: now
    });

    assert.match(paymentFailures.body, /CHECKOUT_PAYMENT_REFUND_DUE/);
    assert.match(paymentFailures.body, /refund_due is payment leakage, not payment success/);
    assert.match(paymentFailures.body, /failedAttempts,1/);
    assert.match(leakage.body, /CHECKOUT_PAYMENT_REFUND_DUE/);
    assert.match(leakage.body, /totalAmountAtRiskMinor,3000/);
  });

  it("keeps COD Risk export on current COD OTP semantics without pre-shipment OTP terminology", async () => {
    const exported = await buildCheckoutIntelligenceCsvExport({
      report: "codRisk",
      filters: { merchantId },
      analyticsService: createService(),
      generatedAt: now
    });

    assert.match(exported.body, /COD OTP metrics are not instrumented yet/);
    assert.match(exported.body, /checkoutCodOtpRequested,0/);
    assert.doesNotMatch(exported.body, new RegExp(["OTP", "BEFORE", "SHIPMENT"].join("_")));
  });

  it("sanitizes Event Log payloads in CSV and omits raw email, phone, IP, and address fields", async () => {
    const exported = await buildCheckoutIntelligenceCsvExport({
      report: "eventLog",
      filters: { merchantId },
      analyticsService: createService(),
      generatedAt: now
    });

    assert.match(exported.body, /safe/);
    assert.doesNotMatch(exported.body, /buyer@example\.test/);
    assert.doesNotMatch(exported.body, /9999999999/);
    assert.doesNotMatch(exported.body, /203\.0\.113\.10/);
    assert.doesNotMatch(exported.body, /221B Market Road/);
  });

  it("honors merchant filters and succeeds for empty report exports with headers and metadata", async () => {
    const otherMerchant = await buildCheckoutIntelligenceCsvExport({
      report: "merchantBreakdown",
      filters: { merchantId: otherMerchantId },
      analyticsService: createService(),
      generatedAt: now
    });
    const empty = await buildCheckoutIntelligenceCsvExport({
      report: "merchantBreakdown",
      filters: { merchantId: "merchant_missing" },
      analyticsService: createService(),
      generatedAt: now
    });

    assert.match(otherMerchant.body, /Other Merchant/);
    assert.doesNotMatch(otherMerchant.body, /Skymax Demo Merchant/);
    assert.match(empty.body, /reportName,Merchant Breakdown/);
    assert.match(empty.body, /section,merchants/);
    assert.match(empty.body, /merchantId,merchantName,checkoutStartedSessions/);
  });

  it("guards export routes for MASTER_ADMIN only and returns CSV content headers", async () => {
    await withCheckoutIntelligenceApp(createService(), async (baseUrl) => {
      mockUserFindUnique("MASTER_ADMIN");

      for (const report of CHECKOUT_INTELLIGENCE_EXPORT_REPORT_SEQUENCE) {
        const response = await fetch(`${baseUrl}/admin/checkout-intelligence/${report.pathSegment}/export?format=csv&merchantId=${merchantId}`, {
          headers: { authorization: `Bearer ${signRole("MASTER_ADMIN")}` }
        });
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
        assert.match(
          response.headers.get("content-disposition") ?? "",
          new RegExp(`attachment; filename="checkout-intelligence-${report.fileSegment}-\\d{8}-\\d{4}\\.csv"`)
        );
        assert.match(body, new RegExp(`reportName,${report.reportName}`));
      }

      const unauthenticated = await fetch(`${baseUrl}/admin/checkout-intelligence/overview/export?format=csv`);
      assert.equal(unauthenticated.status, 401);

      mockUserFindUnique("ADMIN");
      const nonMaster = await fetch(`${baseUrl}/admin/checkout-intelligence/overview/export?format=csv`, {
        headers: { authorization: `Bearer ${signRole("ADMIN")}` }
      });
      assert.equal(nonMaster.status, 403);

      mockUserFindUnique("MASTER_ADMIN");
      const missingSellerBreakdown = await fetch(`${baseUrl}/admin/checkout-intelligence/seller-breakdown/export?format=csv`, {
        headers: { authorization: `Bearer ${signRole("MASTER_ADMIN")}` }
      });
      assert.equal(missingSellerBreakdown.status, 404);

      const invalidFormat = await fetch(`${baseUrl}/admin/checkout-intelligence/overview/export?format=xlsx`, {
        headers: { authorization: `Bearer ${signRole("MASTER_ADMIN")}` }
      });
      assert.equal(invalidFormat.status, 400);
    });
  });
});
