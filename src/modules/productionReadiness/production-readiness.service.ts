import { buildProductionReadinessReport } from "./production-readiness.rules.js";
import { getCourierLiveReadinessSnapshot } from "../courierPartners/liveReadiness/courier-live-readiness.service.js";
import { getLivePilotReadinessSnapshot } from "../livePilot/live-pilot.service.js";
import {
  serializeLiveEnablementPlan,
  serializeProductionReadinessChecks,
  serializeProductionReadinessReport
} from "./production-readiness.serializer.js";
import type { ProductionReadinessQueryInput } from "./production-readiness.validation.js";

export async function getProductionReadinessReport(merchantId: string, _query: ProductionReadinessQueryInput = { include_plan: true }) {
  const pilotReadiness = await getLivePilotReadinessSnapshot(merchantId);
  const courierProviderReadiness = await getCourierLiveReadinessSnapshot(merchantId);
  return serializeProductionReadinessReport(buildProductionReadinessReport(undefined, {
    pilotReadiness,
    courierProviderReadiness: {
      hasActiveProvider: courierProviderReadiness.has_active_provider,
      activeProviderCount: courierProviderReadiness.active_provider_count,
      providers: courierProviderReadiness.providers.map((provider) => ({
        providerKey: provider.provider_key,
        status: provider.credential?.status ?? "MISSING_CREDENTIALS",
        mode: provider.credential?.mode ?? null,
        liveReady: provider.live_ready,
        blockers: provider.blockers
      }))
    }
  }));
}

export async function getProductionReadinessChecks(merchantId: string) {
  const pilotReadiness = await getLivePilotReadinessSnapshot(merchantId);
  const courierProviderReadiness = await getCourierLiveReadinessSnapshot(merchantId);
  return serializeProductionReadinessChecks(buildProductionReadinessReport(undefined, {
    pilotReadiness,
    courierProviderReadiness: {
      hasActiveProvider: courierProviderReadiness.has_active_provider,
      activeProviderCount: courierProviderReadiness.active_provider_count,
      providers: courierProviderReadiness.providers.map((provider) => ({
        providerKey: provider.provider_key,
        status: provider.credential?.status ?? "MISSING_CREDENTIALS",
        mode: provider.credential?.mode ?? null,
        liveReady: provider.live_ready,
        blockers: provider.blockers
      }))
    }
  }));
}

export async function getProductionReadinessLiveEnablementPlan(merchantId: string) {
  const pilotReadiness = await getLivePilotReadinessSnapshot(merchantId);
  const courierProviderReadiness = await getCourierLiveReadinessSnapshot(merchantId);
  return serializeLiveEnablementPlan(buildProductionReadinessReport(undefined, {
    pilotReadiness,
    courierProviderReadiness: {
      hasActiveProvider: courierProviderReadiness.has_active_provider,
      activeProviderCount: courierProviderReadiness.active_provider_count,
      providers: courierProviderReadiness.providers.map((provider) => ({
        providerKey: provider.provider_key,
        status: provider.credential?.status ?? "MISSING_CREDENTIALS",
        mode: provider.credential?.mode ?? null,
        liveReady: provider.live_ready,
        blockers: provider.blockers
      }))
    }
  }));
}
