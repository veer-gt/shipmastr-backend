import { Router } from "express";
import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  getProductionReadinessChecks,
  getProductionReadinessLiveEnablementPlan,
  getProductionReadinessReport
} from "./production-readiness.service.js";
import { productionReadinessQuerySchema } from "./production-readiness.validation.js";

export const productionReadinessRouter = Router();

productionReadinessRouter.get("/production-readiness/report", async (req, res) => {
  const query = productionReadinessQuerySchema.parse(req.query ?? {});
  const data = await getProductionReadinessReport(req.auth!.merchantId, query);
  return res.json(successEnvelope("Production readiness report generated safely.", data));
});

productionReadinessRouter.get("/production-readiness/checks", async (req, res) => {
  const data = await getProductionReadinessChecks(req.auth!.merchantId);
  return res.json(successEnvelope("Production readiness checks fetched safely.", data));
});

productionReadinessRouter.get("/production-readiness/live-enablement-plan", async (req, res) => {
  const data = await getProductionReadinessLiveEnablementPlan(req.auth!.merchantId);
  return res.json(successEnvelope("Live enablement plan fetched safely.", data));
});
