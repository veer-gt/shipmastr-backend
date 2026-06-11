import { COURIER_READINESS_PROBE_CONSTANTS } from "../../liveReadiness/courier-live-readiness.providers.js";

export type ShiprocketReadinessProbe = "ACCOUNT_INFO" | "PICKUP_ADDRESS_LIST" | "PINCODE_SERVICEABILITY" | "RATE_SERVICEABILITY";

export function buildShiprocketReadinessRequest(probeType: ShiprocketReadinessProbe) {
  const endpoints: Record<ShiprocketReadinessProbe, { method: "GET" | "POST"; path: string; destructive: false }> = {
    ACCOUNT_INFO: { method: "POST", path: "/v1/external/auth/login", destructive: false },
    PICKUP_ADDRESS_LIST: { method: "GET", path: "/v1/external/settings/company/pickup", destructive: false },
    PINCODE_SERVICEABILITY: { method: "GET", path: "/v1/external/courier/serviceability/", destructive: false },
    RATE_SERVICEABILITY: { method: "GET", path: "/v1/external/courier/serviceability/", destructive: false }
  };
  return {
    provider_key: "SHIPROCKET",
    probe_type: probeType,
    ...endpoints[probeType],
    params: {
      pickup_pincode: COURIER_READINESS_PROBE_CONSTANTS.SHIPROCKET_PROBE_PICKUP_PINCODE,
      delivery_pincode: COURIER_READINESS_PROBE_CONSTANTS.PROBE_DELIVERY_PINCODE,
      weight_grams: COURIER_READINESS_PROBE_CONSTANTS.PROBE_WEIGHT_GRAMS,
      cod: COURIER_READINESS_PROBE_CONSTANTS.PROBE_COD
    },
    auth_model: {
      credential_ref_only: true,
      login_endpoint: "/v1/external/auth/login",
      token_ephemeral: true,
      token_persisted_to_db: false,
      token_stored_in_vault: false,
      token_serialized: false,
      reauthenticate_on_expiry: true
    },
    uses_safe_probe_constants: true,
    uses_merchant_address: false,
    uses_buyer_address: false,
    stores_raw_response: false,
    exposes_credentials: false
  };
}
