import { COURIER_READINESS_PROBE_CONSTANTS } from "../../liveReadiness/courier-live-readiness.providers.js";

export type ShipmozoReadinessProbe = "WAREHOUSE_LIST" | "PINCODE_SERVICEABILITY" | "RATE_SERVICEABILITY";

export function buildShipmozoReadinessRequest(probeType: ShipmozoReadinessProbe) {
  const endpoints: Record<ShipmozoReadinessProbe, { method: "GET" | "POST"; path: string; destructive: false }> = {
    WAREHOUSE_LIST: { method: "GET", path: "/get-warehouses", destructive: false },
    PINCODE_SERVICEABILITY: { method: "POST", path: "/pincode-serviceability", destructive: false },
    RATE_SERVICEABILITY: { method: "POST", path: "/rate-calculator", destructive: false }
  };
  return {
    provider_key: "SHIPMOZO",
    probe_type: probeType,
    ...endpoints[probeType],
    params: {
      pickup_pincode: COURIER_READINESS_PROBE_CONSTANTS.SHIPMOZO_PROBE_PICKUP_PINCODE,
      delivery_pincode: COURIER_READINESS_PROBE_CONSTANTS.PROBE_DELIVERY_PINCODE,
      weight_grams: COURIER_READINESS_PROBE_CONSTANTS.PROBE_WEIGHT_GRAMS,
      cod: COURIER_READINESS_PROBE_CONSTANTS.PROBE_COD
    },
    credential_fields_provisional: true,
    credential_fields_note: "TODO: Confirm Shipmozo API credential field names from official docs.",
    uses_safe_probe_constants: true,
    uses_merchant_address: false,
    uses_buyer_address: false,
    stores_raw_response: false,
    exposes_credentials: false
  };
}
