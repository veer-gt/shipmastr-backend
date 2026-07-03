import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { createCourierAuditLead } from "./courier-audit.service.js";

export const courierAuditRouter = Router();

export const courierAuditLeadRateLimit = {
  windowMs: 60 * 60 * 1000,
  limit: 12
};

const courierAuditLeadLimiter = rateLimit({
  ...courierAuditLeadRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "TOO_MANY_AUDIT_REQUESTS" }
});

const optionalText = z.string().trim().max(240).optional().nullable().or(z.literal(""));
const optionalNumber = z.coerce.number().finite().nonnegative().optional().nullable().or(z.literal(""));

export const courierAuditLeadSchema = z.object({
  brand: z.string().trim().min(1).max(180),
  name: z.string().trim().min(1).max(180),
  email: z.string().trim().email().max(220),
  whatsapp: z.string().trim().min(7).max(32),
  monthly_shipments: z.coerce.number().int().positive().max(1_000_000),
  current_aggregator: optionalText,
  estimated_leak: optionalNumber,
  bump_rate: optionalNumber,
  average_overcharge: optionalNumber,
  utm_source: optionalText,
  utm_medium: optionalText,
  utm_campaign: optionalText,
  utm_term: optionalText,
  utm_content: optionalText,
  landing_path: z.string().trim().max(500).optional().nullable().or(z.literal("")),
  referrer: z.string().trim().max(1000).optional().nullable().or(z.literal("")),
  website: z.string().trim().max(500).optional().nullable().or(z.literal(""))
});

function optionalString(value: string | null | undefined) {
  return value?.trim() || null;
}

function optionalNumeric(value: number | "" | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

courierAuditRouter.post("/leads", courierAuditLeadLimiter, async (req, res) => {
  const body = courierAuditLeadSchema.parse(req.body);

  const result = await createCourierAuditLead({
    brand: body.brand,
    name: body.name,
    email: body.email,
    whatsapp: body.whatsapp,
    monthlyShipments: body.monthly_shipments,
    currentAggregator: optionalString(body.current_aggregator),
    estimatedLeak: optionalNumeric(body.estimated_leak),
    bumpRate: optionalNumeric(body.bump_rate),
    averageOvercharge: optionalNumeric(body.average_overcharge),
    utmSource: optionalString(body.utm_source),
    utmMedium: optionalString(body.utm_medium),
    utmCampaign: optionalString(body.utm_campaign),
    utmTerm: optionalString(body.utm_term),
    utmContent: optionalString(body.utm_content),
    landingPath: optionalString(body.landing_path),
    referrer: optionalString(body.referrer),
    website: optionalString(body.website)
  });

  return res.status(201).json({ ok: true, id: result.stored ? result.id : undefined });
});
