import { Router } from "express";
import { HttpError } from "../../lib/httpError.js";
import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  getPilotLaunchChecklist,
  getPilotLaunchGoNoGo,
  getPilotLaunchRollbackPlan,
  getPilotLaunchSmokeChecklist
} from "./pilot-launch.service.js";
import { pilotLaunchMerchantIdSchema } from "./pilot-launch.validation.js";

export const pilotLaunchRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function scopedMerchantId(authMerchantId: string, requestedMerchantId?: string) {
  const merchantId = pilotLaunchMerchantIdSchema.parse(routeParam(requestedMerchantId));
  if (merchantId === authMerchantId) return merchantId;
  throw new HttpError(403, "PILOT_LAUNCH_MERCHANT_SCOPE_MISMATCH");
}

pilotLaunchRouter.get("/pilot-launch/:merchantId/checklist", async (req, res) => {
  const merchantId = scopedMerchantId(req.auth!.merchantId, req.params.merchantId);
  const data = await getPilotLaunchChecklist(merchantId);
  return res.json(successEnvelope("Controlled pilot launch checklist generated safely.", data));
});

pilotLaunchRouter.get("/pilot-launch/:merchantId/go-no-go", async (req, res) => {
  const merchantId = scopedMerchantId(req.auth!.merchantId, req.params.merchantId);
  const data = await getPilotLaunchGoNoGo(merchantId);
  return res.json(successEnvelope("Controlled pilot go/no-go report generated safely.", data));
});

pilotLaunchRouter.get("/pilot-launch/:merchantId/rollback-plan", async (req, res) => {
  const merchantId = scopedMerchantId(req.auth!.merchantId, req.params.merchantId);
  const data = await getPilotLaunchRollbackPlan(merchantId);
  return res.json(successEnvelope("Controlled pilot rollback plan fetched safely.", data));
});

pilotLaunchRouter.get("/pilot-launch/:merchantId/smoke-checklist", async (req, res) => {
  const merchantId = scopedMerchantId(req.auth!.merchantId, req.params.merchantId);
  const data = await getPilotLaunchSmokeChecklist(merchantId);
  return res.json(successEnvelope("Controlled pilot smoke checklist fetched safely.", data));
});
