import { COURIER_READINESS_PROBE_CONSTANTS } from "../../liveReadiness/courier-live-readiness.providers.js";

export type BigshipReadinessProbe = "ACCOUNT_INFO" | "WAREHOUSE_LIST" | "PINCODE_SERVICEABILITY" | "RATE_SERVICEABILITY";

export function buildBigshipReadinessProbe(probeType: BigshipReadinessProbe) {
  const endpoints: Record<BigshipReadinessProbe, { method: "GET" | "POST"; path: string; destructive: false }> = {
    ACCOUNT_INFO: { method: "POST", path: "/api/login", destructive: false },
    WAREHOUSE_LIST: { method: "GET", path: "/api/warehouses", destructive: false },
    PINCODE_SERVICEABILITY: { method: "POST", path: "/api/courier-rates", destructive: false },
    RATE_SERVICEABILITY: { method: "POST", path: "/api/courier-rates", destructive: false }
  };
  return {
    provider_key: "BIGSHIP",
    probe_type: probeType,
    ...endpoints[probeType],
    params: {
      pickup_pincode: COURIER_READINESS_PROBE_CONSTANTS.BIGSHIP_PROBE_PICKUP_PINCODE,
      delivery_pincode: COURIER_READINESS_PROBE_CONSTANTS.PROBE_DELIVERY_PINCODE,
      weight_grams: COURIER_READINESS_PROBE_CONSTANTS.PROBE_WEIGHT_GRAMS,
      cod: COURIER_READINESS_PROBE_CONSTANTS.PROBE_COD
    },
    uses_safe_probe_constants: true,
    uses_merchant_address: false,
    uses_buyer_address: false,
    stores_raw_response: false,
    exposes_credentials: false
  };
}
