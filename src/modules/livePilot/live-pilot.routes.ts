import { Router } from "express";
import { HttpError } from "../../lib/httpError.js";
import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  approveLivePilotCapability,
  disableLivePilotCapability,
  disableLivePilotMerchant,
  enableLivePilotCapability,
  enableLivePilotMerchant,
  getLivePilotMerchant,
  listLivePilotAuditLogs,
  listLivePilotCapabilities,
  listLivePilotMerchants
} from "./live-pilot.service.js";
import {
  livePilotAuditLogQuerySchema,
  livePilotCapabilityActionSchema,
  livePilotMerchantActionSchema,
  parseLivePilotCapability
} from "./live-pilot.validation.js";

export const livePilotRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function scopedMerchantId(authMerchantId: string, requestedMerchantId?: string) {
  if (!requestedMerchantId || requestedMerchantId === authMerchantId) return authMerchantId;
  throw new HttpError(403, "LIVE_PILOT_MERCHANT_SCOPE_MISMATCH");
}

function routeCapability(value: string | string[] | undefined) {
  const parsed = parseLivePilotCapability(routeParam(value));
  if (!parsed) throw new HttpError(400, "LIVE_PILOT_CAPABILITY_UNSUPPORTED");
  return parsed;
}

livePilotRouter.get("/live-pilot/merchants", async (req, res) => {
  const data = await listLivePilotMerchants(req.auth!.merchantId);
  return res.json(successEnvelope("Live pilot merchants fetched safely.", data));
});

livePilotRouter.get("/live-pilot/merchants/:merchantId", async (req, res) => {
  const merchantId = scopedMerchantId(req.auth!.merchantId, routeParam(req.params.merchantId));
  const data = await getLivePilotMerchant(merchantId);
  return res.json(successEnvelope("Live pilot merchant fetched safely.", data));
});

livePilotRouter.post("/live-pilot/merchants/:merchantId/enable", async (req, res) => {
  const merchantId = scopedMerchantId(req.auth!.merchantId, routeParam(req.params.merchantId));
  const body = livePilotMerchantActionSchema.parse(req.body ?? {});
  const data = await enableLivePilotMerchant(merchantId, body);
  return res.status(201).json(successEnvelope("Pilot merchant allowlist enabled safely.", data));
});

livePilotRouter.post("/live-pilot/merchants/:merchantId/disable", async (req, res) => {
  const merchantId = scopedMerchantId(req.auth!.merchantId, routeParam(req.params.merchantId));
  const body = livePilotMerchantActionSchema.parse(req.body ?? {});
  const data = await disableLivePilotMerchant(merchantId, body);
  return res.json(successEnvelope("Pilot merchant allowlist disabled safely.", data));
});

livePilotRouter.get("/live-pilot/merchants/:merchantId/capabilities", async (req, res) => {
  const merchantId = scopedMerchantId(req.auth!.merchantId, routeParam(req.params.merchantId));
  const data = await listLivePilotCapabilities(merchantId);
  return res.json(successEnvelope("Live pilot capabilities fetched safely.", data));
});

livePilotRouter.post("/live-pilot/merchants/:merchantId/capabilities/:capability/approve", async (req, res) => {
  const merchantId = scopedMerchantId(req.auth!.merchantId, routeParam(req.params.merchantId));
  const capability = routeCapability(req.params.capability);
  const body = livePilotCapabilityActionSchema.parse(req.body ?? {});
  const data = await approveLivePilotCapability(merchantId, capability, body);
  return res.status(201).json(successEnvelope("Live pilot capability approved safely.", data));
});

livePilotRouter.post("/live-pilot/merchants/:merchantId/capabilities/:capability/enable", async (req, res) => {
  const merchantId = scopedMerchantId(req.auth!.merchantId, routeParam(req.params.merchantId));
  const capability = routeCapability(req.params.capability);
  const body = livePilotCapabilityActionSchema.parse(req.body ?? {});
  const data = await enableLivePilotCapability(merchantId, capability, body);
  return res.json(successEnvelope("Live pilot capability enabled safely.", data));
});

livePilotRouter.post("/live-pilot/merchants/:merchantId/capabilities/:capability/disable", async (req, res) => {
  const merchantId = scopedMerchantId(req.auth!.merchantId, routeParam(req.params.merchantId));
  const capability = routeCapability(req.params.capability);
  const body = livePilotCapabilityActionSchema.parse(req.body ?? {});
  const data = await disableLivePilotCapability(merchantId, capability, body);
  return res.json(successEnvelope("Live pilot capability disabled safely.", data));
});

livePilotRouter.get("/live-pilot/audit-logs", async (req, res) => {
  const query = livePilotAuditLogQuerySchema.parse(req.query ?? {});
  const data = await listLivePilotAuditLogs(req.auth!.merchantId, query);
  return res.json(successEnvelope("Live pilot audit logs fetched safely.", data));
});
