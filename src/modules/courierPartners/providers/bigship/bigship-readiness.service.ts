export type BigshipReadinessProbe = "ACCOUNT_INFO" | "WAREHOUSE_LIST" | "PINCODE_SERVICEABILITY" | "RATE_SERVICEABILITY";

export function buildBigshipReadinessProbe(probeType: BigshipReadinessProbe) {
  const endpoints: Record<BigshipReadinessProbe, { method: "GET" | "POST"; path: string; destructive: false }> = {
    ACCOUNT_INFO: { method: "POST", path: "/api/login", destructive: false },
    WAREHOUSE_LIST: { method: "POST", path: "/api/save-warehouse", destructive: false },
    PINCODE_SERVICEABILITY: { method: "POST", path: "/api/courier-rates", destructive: false },
    RATE_SERVICEABILITY: { method: "POST", path: "/api/courier-rates", destructive: false }
  };
  return {
    provider_key: "BIGSHIP",
    probe_type: probeType,
    ...endpoints[probeType],
    stores_raw_response: false,
    exposes_credentials: false
  };
}

