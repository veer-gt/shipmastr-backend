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

export function serializeCertifiedProviderRouting(result: CertifiedProviderRoutingResult): CertifiedProviderRoutingResult {
  return {
    shipment_id: result.shipment_id,
    public_network_name: "Shipmastr Courier Network",
    decision: result.decision,
    selected_public_tier: result.selected_public_tier,
    selected_public_service_name: result.selected_public_service_name,
    selected_rate_id: result.selected_rate_id,
    selected_pickup_location_id: result.selected_pickup_location_id,
    internal_selection: {
      provider_key_internal: result.internal_selection.provider_key_internal,
      internal_courier_id_present: result.internal_selection.internal_courier_id_present,
      provider_rate_id_present: result.internal_selection.provider_rate_id_present,
      provider_refs_required: result.internal_selection.provider_refs_required
    },
    readiness: result.readiness,
    blockers: safeList(result.blockers),
    warnings: safeList(result.warnings),
    seller_safe_message: safeString(result.seller_safe_message) ?? "Shipmastr will keep this shipment in safe review.",
    admin_next_actions: safeList(result.admin_next_actions)
  };
}
