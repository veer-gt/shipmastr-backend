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
    stores_raw_response: false,
    exposes_credentials: false
  };
}

