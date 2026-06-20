import type {
  CourierProviderCapability,
  CourierProviderCapabilityFlags,
  CourierProviderCode,
  CourierProviderInternalShipmentStatus,
  CourierProviderLaneCode,
  CourierProviderLaneDefinition
} from "./courier-provider-registry.types.js";

const gstConfig = {
  gstEnabled: true,
  gstRatePercent: 18,
  serviceCodeType: "SAC" as const,
  serviceCode: "996812"
};

const fullWorkflowCapabilities: CourierProviderCapabilityFlags = {
  supportsRate: true,
  supportsAwb: true,
  supportsLabel: true,
  supportsCancel: true,
  supportsPickup: true,
  supportsTracking: true,
  supportsStatusMapping: true,
  supportsNdr: true,
  supportsWeightDispute: true,
  supportsCodRemittance: false
};

const aggregatorCapabilities: CourierProviderCapabilityFlags = {
  ...fullWorkflowCapabilities,
  supportsCodRemittance: true
};

function lane(
  input: Omit<CourierProviderLaneDefinition, "mode" | "status" | "credentialReadiness" | "taxConfig" | "notes">
    & Partial<Pick<CourierProviderLaneDefinition, "mode" | "status" | "credentialReadiness">>
    & { notes?: string[] }
): CourierProviderLaneDefinition {
  return {
    ...input,
    mode: input.mode ?? "LIVE",
    status: input.status ?? "TESTING",
    credentialReadiness: input.credentialReadiness ?? "NOT_CONFIGURED",
    taxConfig: gstConfig,
    notes: [
      "Phase 51 registry is config-backed and non-calling.",
      "Official contracted API documentation is required before live adapter enablement.",
      ...(input.notes ?? [])
    ]
  };
}

export const courierProviderLaneDefinitions: readonly CourierProviderLaneDefinition[] = [
  lane({
    code: "DELHIVERY_B2C_AIR",
    providerCode: "DELHIVERY",
    providerLabelInternal: "Delhivery",
    laneType: "B2C_AIR",
    transportMode: "AIR",
    baseUrlRef: "COURIER_BASE_URL_DELHIVERY",
    capabilities: fullWorkflowCapabilities
  }),
  lane({
    code: "DELHIVERY_B2C_SURFACE",
    providerCode: "DELHIVERY",
    providerLabelInternal: "Delhivery",
    laneType: "B2C_SURFACE",
    transportMode: "SURFACE",
    baseUrlRef: "COURIER_BASE_URL_DELHIVERY",
    capabilities: fullWorkflowCapabilities
  }),
  lane({
    code: "XPRESSBEES_AIR",
    providerCode: "XPRESSBEES",
    providerLabelInternal: "Xpressbees",
    laneType: "B2C_AIR",
    transportMode: "AIR",
    baseUrlRef: "COURIER_BASE_URL_XPRESSBEES",
    capabilities: fullWorkflowCapabilities
  }),
  lane({
    code: "XPRESSBEES_SURFACE",
    providerCode: "XPRESSBEES",
    providerLabelInternal: "Xpressbees",
    laneType: "B2C_SURFACE",
    transportMode: "SURFACE",
    baseUrlRef: "COURIER_BASE_URL_XPRESSBEES",
    capabilities: fullWorkflowCapabilities
  }),
  lane({
    code: "SHADOWFAX",
    providerCode: "SHADOWFAX",
    providerLabelInternal: "Shadowfax",
    laneType: "HYPERLOCAL",
    transportMode: "HYPERLOCAL",
    baseUrlRef: "COURIER_BASE_URL_SHADOWFAX",
    capabilities: {
      ...fullWorkflowCapabilities,
      supportsWeightDispute: false
    }
  }),
  lane({
    code: "EKART",
    providerCode: "EKART",
    providerLabelInternal: "Ekart",
    laneType: "B2C_SURFACE",
    transportMode: "SURFACE",
    status: "SUSPENDED",
    baseUrlRef: "COURIER_BASE_URL_EKART",
    capabilities: fullWorkflowCapabilities,
    notes: ["Suspended until official contracted API readiness is confirmed."]
  }),
  lane({
    code: "BIGSHIP",
    providerCode: "BIGSHIP",
    providerLabelInternal: "Bigship",
    laneType: "AGGREGATOR",
    transportMode: "AGGREGATED",
    status: "ACTIVE",
    baseUrlRef: "COURIER_BASE_URL_BIGSHIP",
    capabilities: aggregatorCapabilities,
    notes: ["Existing Bigship adapter/certification foundations remain the source for live adapter behavior."]
  }),
  lane({
    code: "SHIPROCKET",
    providerCode: "SHIPROCKET",
    providerLabelInternal: "Shiprocket",
    laneType: "AGGREGATOR",
    transportMode: "AGGREGATED",
    status: "ACTIVE",
    baseUrlRef: "COURIER_BASE_URL_SHIPROCKET",
    capabilities: aggregatorCapabilities,
    notes: ["Existing Shiprocket adapter/certification foundations remain the source for live adapter behavior."]
  })
] as const;

export const courierProviderPublicOutcomes = [
  "Shipmastr Smart",
  "Shipmastr Economy",
  "Shipmastr Express",
  "Shipmastr COD Shield",
  "Shipmastr Weight Guard",
  "Shipmastr Autopilot"
] as const;

const capabilityToFlag: Record<CourierProviderCapability, keyof CourierProviderCapabilityFlags> = {
  RATE: "supportsRate",
  AWB: "supportsAwb",
  LABEL: "supportsLabel",
  CANCEL: "supportsCancel",
  PICKUP: "supportsPickup",
  TRACKING: "supportsTracking",
  STATUS_MAPPING: "supportsStatusMapping",
  NDR: "supportsNdr",
  WEIGHT_DISPUTE: "supportsWeightDispute",
  COD_REMITTANCE: "supportsCodRemittance"
};

export function providerLaneSupportsCapability(
  lane: CourierProviderLaneDefinition,
  capability: CourierProviderCapability
) {
  return lane.capabilities[capabilityToFlag[capability]];
}

export function getCourierProviderLaneDefinition(code: CourierProviderLaneCode) {
  return courierProviderLaneDefinitions.find((laneDefinition) => laneDefinition.code === code) ?? null;
}

export function isProviderLaneCode(value: string): value is CourierProviderLaneCode {
  return courierProviderLaneDefinitions.some((laneDefinition) => laneDefinition.code === value);
}

export function isProviderCode(value: string): value is CourierProviderCode {
  return courierProviderLaneDefinitions.some((laneDefinition) => laneDefinition.providerCode === value);
}

const statusRules: Array<{
  status: CourierProviderInternalShipmentStatus;
  match: RegExp;
}> = [
  { status: "DELIVERED", match: /\b(delivered|shipment delivered|pod)\b/i },
  { status: "OUT_FOR_DELIVERY", match: /\b(out for delivery|ofd)\b/i },
  { status: "NDR_ACTION_REQUIRED", match: /\b(ndr|undelivered|consignee unavailable|customer unavailable|reattempt)\b/i },
  { status: "RTO_DELIVERED", match: /\b(rto delivered|return delivered|returned to origin delivered)\b/i },
  { status: "RTO_INITIATED", match: /\b(rto|return to origin|returned to origin|return initiated)\b/i },
  { status: "LOST_OR_DAMAGED", match: /\b(lost|damaged|destroyed|shortage)\b/i },
  { status: "CANCELLED", match: /\b(cancelled|canceled)\b/i },
  { status: "PICKUP_SCHEDULED", match: /\b(pickup scheduled|pickup generated|pickup requested|manifested)\b/i },
  { status: "PICKED_UP", match: /\b(picked up|pickup completed|pickup done|in scan)\b/i },
  { status: "IN_TRANSIT", match: /\b(in transit|shipped|dispatched|connected|arrived|departed|hub|bagged)\b/i },
  { status: "READY_TO_SHIP", match: /\b(ready|awb assigned|label generated|shipment created)\b/i },
  { status: "CREATED", match: /\b(created|new|booked|draft)\b/i },
  { status: "EXCEPTION", match: /\b(exception|failed|hold|delay|pending|blocked)\b/i }
];

export function normalizeProviderShipmentStatus(rawStatus: string | null | undefined): CourierProviderInternalShipmentStatus {
  const value = String(rawStatus ?? "").trim();
  if (!value) return "EXCEPTION";
  return statusRules.find((rule) => rule.match.test(value))?.status ?? "EXCEPTION";
}
