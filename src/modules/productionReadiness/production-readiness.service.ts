import { buildProductionReadinessReport } from "./production-readiness.rules.js";
import { getLivePilotReadinessSnapshot } from "../livePilot/live-pilot.service.js";
import {
  serializeLiveEnablementPlan,
  serializeProductionReadinessChecks,
  serializeProductionReadinessReport
} from "./production-readiness.serializer.js";
import type { ProductionReadinessQueryInput } from "./production-readiness.validation.js";

export async function getProductionReadinessReport(merchantId: string, _query: ProductionReadinessQueryInput = { include_plan: true }) {
  const pilotReadiness = await getLivePilotReadinessSnapshot(merchantId);
  return serializeProductionReadinessReport(buildProductionReadinessReport(undefined, { pilotReadiness }));
}

export async function getProductionReadinessChecks(merchantId: string) {
  const pilotReadiness = await getLivePilotReadinessSnapshot(merchantId);
  return serializeProductionReadinessChecks(buildProductionReadinessReport(undefined, { pilotReadiness }));
}

export async function getProductionReadinessLiveEnablementPlan(merchantId: string) {
  const pilotReadiness = await getLivePilotReadinessSnapshot(merchantId);
  return serializeLiveEnablementPlan(buildProductionReadinessReport(undefined, { pilotReadiness }));
}
