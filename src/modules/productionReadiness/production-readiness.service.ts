import { buildProductionReadinessReport } from "./production-readiness.rules.js";
import {
  serializeLiveEnablementPlan,
  serializeProductionReadinessChecks,
  serializeProductionReadinessReport
} from "./production-readiness.serializer.js";
import type { ProductionReadinessQueryInput } from "./production-readiness.validation.js";

export function getProductionReadinessReport(_merchantId: string, _query: ProductionReadinessQueryInput = { include_plan: true }) {
  return serializeProductionReadinessReport(buildProductionReadinessReport());
}

export function getProductionReadinessChecks(_merchantId: string) {
  return serializeProductionReadinessChecks(buildProductionReadinessReport());
}

export function getProductionReadinessLiveEnablementPlan(_merchantId: string) {
  return serializeLiveEnablementPlan(buildProductionReadinessReport());
}
