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
    stores_raw_response: false,
    exposes_credentials: false
  };
}

