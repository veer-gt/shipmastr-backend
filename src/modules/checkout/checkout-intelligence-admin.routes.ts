import { Router } from "express";
import { z } from "zod";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import { CheckoutIntelligenceAnalyticsService } from "./checkout-intelligence-analytics.service.js";
import {
  buildCheckoutIntelligenceCsvExport,
  CHECKOUT_INTELLIGENCE_EXPORT_REPORT_SEQUENCE
} from "./checkout-intelligence-export.service.js";
import { runCheckoutTelemetryAbandonmentWorkerOnce } from "./checkout-telemetry-abandonment.worker.js";
import { CHECKOUT_TELEMETRY_DEVICE_TYPES } from "./checkout-telemetry.service.js";

const analyticsQueryShape = {
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  merchantId: z.string().trim().min(1).optional(),
  sellerId: z.string().trim().min(1).optional(),
  paymentMethod: z.string().trim().min(1).max(80).optional(),
  gatewayUsed: z.string().trim().min(1).max(80).optional(),
  deviceType: z.enum(CHECKOUT_TELEMETRY_DEVICE_TYPES).optional(),
  failureStage: z.string().trim().min(1).max(80).optional(),
  failureReason: z.string().trim().min(1).max(160).optional(),
  errorCode: z.string().trim().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).optional()
};

function isValidDateRange(query: {
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  startDate?: Date | undefined;
  endDate?: Date | undefined;
}) {
  const dateFrom = query.dateFrom ?? query.from ?? query.startDate;
  const dateTo = query.dateTo ?? query.to ?? query.endDate;
  return !dateFrom || !dateTo || dateFrom <= dateTo;
}

const analyticsQuerySchema = z.object(analyticsQueryShape).refine(isValidDateRange, {
  message: "dateFrom must be before dateTo",
  path: ["dateTo"]
});

const analyticsExportQuerySchema = z.object({
  ...analyticsQueryShape,
  format: z.preprocess((value) => typeof value === "string" ? value.toLowerCase() : value, z.literal("csv").default("csv"))
}).refine(isValidDateRange, {
  message: "dateFrom must be before dateTo",
  path: ["dateTo"]
});

function analyticsFiltersFromParsed(parsed: z.infer<typeof analyticsQuerySchema>) {
  return {
    dateFrom: parsed.dateFrom ?? parsed.from ?? parsed.startDate,
    dateTo: parsed.dateTo ?? parsed.to ?? parsed.endDate,
    merchantId: parsed.merchantId,
    sellerId: parsed.sellerId,
    paymentMethod: parsed.paymentMethod,
    gatewayUsed: parsed.gatewayUsed,
    deviceType: parsed.deviceType,
    failureStage: parsed.failureStage,
    failureReason: parsed.failureReason,
    errorCode: parsed.errorCode,
    limit: parsed.limit,
    cursor: parsed.cursor
  };
}

function parseAnalyticsQuery(query: unknown) {
  return analyticsFiltersFromParsed(analyticsQuerySchema.parse(query));
}

function parseAnalyticsExportQuery(query: unknown) {
  return analyticsFiltersFromParsed(analyticsExportQuerySchema.parse(query));
}

const runAbandonmentWorkerSchema = z.object({
  dryRun: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  maxBatch: z.number().int().positive().max(100).optional(),
  max_batch: z.number().int().positive().max(100).optional(),
  olderThanMinutes: z.number().int().positive().max(1440).optional(),
  older_than_minutes: z.number().int().positive().max(1440).optional(),
  now: z.string().trim().datetime().optional()
}).strict();

export function createAdminCheckoutIntelligenceRouter(
  analyticsService = new CheckoutIntelligenceAnalyticsService()
) {
  const router = Router();

  router.post("/abandonment-worker/run-once", async (req, res) => {
    const body = runAbandonmentWorkerSchema.parse(req.body ?? {});
    const data = await runCheckoutTelemetryAbandonmentWorkerOnce({
      dryRun: body.dryRun,
      dry_run: body.dry_run,
      maxBatch: body.maxBatch,
      max_batch: body.max_batch,
      olderThanMinutes: body.olderThanMinutes,
      older_than_minutes: body.older_than_minutes,
      now: body.now
    });
    return res.json(successEnvelope("Checkout telemetry abandonment worker run-once evaluated safely.", data));
  });

  for (const report of CHECKOUT_INTELLIGENCE_EXPORT_REPORT_SEQUENCE) {
    router.get(`/${report.pathSegment}/export`, async (req, res) => {
      const exported = await buildCheckoutIntelligenceCsvExport({
        report: report.key,
        filters: parseAnalyticsExportQuery(req.query),
        analyticsService
      });

      res.type(exported.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${exported.fileName}"`);
      return res.send(exported.body);
    });
  }

  router.get("/overview", async (req, res) => {
    const data = await analyticsService.getOverview(parseAnalyticsQuery(req.query));
    return res.json(successEnvelope("Checkout intelligence overview loaded.", data));
  });

  router.get("/funnel", async (req, res) => {
    const data = await analyticsService.getFunnel(parseAnalyticsQuery(req.query));
    return res.json(successEnvelope("Checkout intelligence funnel loaded.", data));
  });

  router.get("/revenue-leakage", async (req, res) => {
    const data = await analyticsService.getRevenueLeakage(parseAnalyticsQuery(req.query));
    return res.json(successEnvelope("Checkout intelligence revenue leakage loaded.", data));
  });

  router.get("/payment-failures", async (req, res) => {
    const data = await analyticsService.getPaymentFailures(parseAnalyticsQuery(req.query));
    return res.json(successEnvelope("Checkout intelligence payment failures loaded.", data));
  });

  router.get("/cod-risk", async (req, res) => {
    const data = await analyticsService.getCodRisk(parseAnalyticsQuery(req.query));
    return res.json(successEnvelope("Checkout intelligence COD risk loaded.", data));
  });

  router.get("/merchant-breakdown", async (req, res) => {
    const data = await analyticsService.getMerchantBreakdown(parseAnalyticsQuery(req.query));
    return res.json(successEnvelope("Checkout intelligence merchant breakdown loaded.", data));
  });

  router.get("/abandoned-checkouts", async (req, res) => {
    const data = await analyticsService.getAbandonedCheckouts(parseAnalyticsQuery(req.query));
    return res.json(successEnvelope("Checkout intelligence abandoned checkouts loaded.", data));
  });

  router.get("/events", async (req, res) => {
    const data = await analyticsService.getEventLog(parseAnalyticsQuery(req.query));
    return res.json(successEnvelope("Checkout intelligence event log loaded.", data));
  });

  return router;
}

export const adminCheckoutIntelligenceRouter = createAdminCheckoutIntelligenceRouter();
