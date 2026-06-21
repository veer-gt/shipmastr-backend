import type { CertifiedProviderRoutingResult } from "./certified-provider-routing.types.js";

const unsafeStringPattern = /shiprocket|shipmozo|bigship|blue dart|provider pickup id|provider order id|provider shipment id|provider raw|authorization|bearer|token|secret|password|credential|api[_-]?key|rawpayload|rawheaders|rawresponse/i;

function safeString(value: string | null | undefined) {
  if (!value) return value ?? null;
  return unsafeStringPattern.test(value) ? "Shipmastr Courier Network" : value.slice(0, 240);
}

function safeList(values: string[]) {
  return [...new Set(values
    .map((value) => safeString(value))
    .filter((value): value is string => Boolean(value)))];
}

export function serializeCertifiedProviderRouting(result: CertifiedProviderRoutingResult) {
  return {
    shipment_id: result.shipment_id,
    public_network_name: "Shipmastr Courier Network",
    decision: result.decision,
    selected_public_tier: result.selected_public_tier,
    selected_public_service_name: result.selected_public_service_name,
    selected_rate_id: result.selected_rate_id,
    selected_pickup_location_id: result.selected_pickup_location_id,
    internal_selection: {
      provider_key_internal: null,
      internal_courier_id_present: result.internal_selection.internal_courier_id_present,
      provider_rate_id_present: result.internal_selection.provider_rate_id_present,
      provider_refs_required: result.internal_selection.provider_refs_required
    },
    readiness: result.readiness,
    blockers: safeList(result.blockers),
    warnings: safeList(result.warnings),
    seller_safe_message: safeString(result.seller_safe_message) ?? "Shipmastr will keep this shipment in safe review.",
    admin_next_actions: safeList(result.admin_next_actions),
    admin_diagnostics: {
      fallback_used: result.admin_diagnostics.fallback_used,
      no_eligible_provider: result.admin_diagnostics.no_eligible_provider,
      evaluated_providers: result.admin_diagnostics.evaluated_providers.map((provider) => ({
        provider_key_internal: null,
        lane_code_internal: null,
        eligible: provider.eligible,
        preferred: provider.preferred,
        selected: provider.selected,
        fallback_reason: safeString(provider.fallback_reason),
        lifecycle_state: safeString(provider.lifecycle_state) ?? "CHECKING",
        capability_status: safeString(provider.capability_status) ?? "CHECKING",
        registry_status: provider.registry_status,
        pickup_available: provider.pickup_available,
        blockers: safeList(provider.blockers),
        warnings: safeList(provider.warnings),
        next_actions: safeList(provider.next_actions)
      }))
    }
  };
}
