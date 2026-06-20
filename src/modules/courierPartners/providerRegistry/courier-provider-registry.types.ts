import type { Prisma } from "@prisma/client";

export const courierProviderCodes = [
  "DELHIVERY",
  "XPRESSBEES",
  "SHADOWFAX",
  "EKART",
  "BIGSHIP",
  "SHIPROCKET"
] as const;
export type CourierProviderCode = typeof courierProviderCodes[number];

export const courierProviderLaneCodes = [
  "DELHIVERY_B2C_AIR",
  "DELHIVERY_B2C_SURFACE",
  "XPRESSBEES_AIR",
  "XPRESSBEES_SURFACE",
  "SHADOWFAX",
  "EKART",
  "BIGSHIP",
  "SHIPROCKET"
] as const;
export type CourierProviderLaneCode = typeof courierProviderLaneCodes[number];

export const courierProviderLaneTypes = [
  "B2C_AIR",
  "B2C_SURFACE",
  "B2C_EXPRESS",
  "HYPERLOCAL",
  "AGGREGATOR"
] as const;
export type CourierProviderLaneType = typeof courierProviderLaneTypes[number];

export const courierProviderTransportModes = [
  "AIR",
  "SURFACE",
  "HYPERLOCAL",
  "AGGREGATED"
] as const;
export type CourierProviderTransportMode = typeof courierProviderTransportModes[number];

export const courierProviderRuntimeModes = ["SANDBOX", "LIVE"] as const;
export type CourierProviderRuntimeMode = typeof courierProviderRuntimeModes[number];

export const courierProviderLaneStatuses = ["DISABLED", "TESTING", "ACTIVE", "SUSPENDED"] as const;
export type CourierProviderLaneStatus = typeof courierProviderLaneStatuses[number];

export const courierProviderCredentialReadinessStatuses = [
  "NOT_CONFIGURED",
  "REFERENCE_CONFIGURED",
  "READY",
  "BLOCKED"
] as const;
export type CourierProviderCredentialReadinessStatus = typeof courierProviderCredentialReadinessStatuses[number];

export const courierProviderCredentialReferenceTypes = [
  "NONE",
  "CREDENTIAL_REF",
  "ENV_REF",
  "SECRET_MANAGER_REF"
] as const;
export type CourierProviderCredentialReferenceType = typeof courierProviderCredentialReferenceTypes[number];

export const courierProviderCapabilities = [
  "RATE",
  "AWB",
  "LABEL",
  "CANCEL",
  "PICKUP",
  "TRACKING",
  "STATUS_MAPPING",
  "NDR",
  "WEIGHT_DISPUTE",
  "COD_REMITTANCE"
] as const;
export type CourierProviderCapability = typeof courierProviderCapabilities[number];

export type CourierProviderCapabilityFlags = {
  supportsRate: boolean;
  supportsAwb: boolean;
  supportsLabel: boolean;
  supportsCancel: boolean;
  supportsPickup: boolean;
  supportsTracking: boolean;
  supportsStatusMapping: boolean;
  supportsNdr: boolean;
  supportsWeightDispute: boolean;
  supportsCodRemittance: boolean;
};

export const courierProviderInternalShipmentStatuses = [
  "CREATED",
  "READY_TO_SHIP",
  "PICKUP_SCHEDULED",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "NDR_ACTION_REQUIRED",
  "RTO_INITIATED",
  "RTO_DELIVERED",
  "CANCELLED",
  "LOST_OR_DAMAGED",
  "EXCEPTION"
] as const;
export type CourierProviderInternalShipmentStatus = typeof courierProviderInternalShipmentStatuses[number];

export type CourierProviderLaneDefinition = {
  code: CourierProviderLaneCode;
  providerCode: CourierProviderCode;
  providerLabelInternal: string;
  laneType: CourierProviderLaneType;
  transportMode: CourierProviderTransportMode;
  mode: CourierProviderRuntimeMode;
  status: CourierProviderLaneStatus;
  credentialReadiness: CourierProviderCredentialReadinessStatus;
  baseUrlRef: string;
  taxConfig: {
    gstEnabled: boolean;
    gstRatePercent: number;
    serviceCodeType: "SAC";
    serviceCode: string;
  };
  capabilities: CourierProviderCapabilityFlags;
  notes: string[];
};

export type CourierProviderLaneCredentialReadiness = {
  status: CourierProviderCredentialReadinessStatus;
  credential_ref_configured: boolean;
  env_ref_configured: boolean;
  secret_manager_ref_configured: boolean;
  reference: {
    configured: boolean;
    ref_type: CourierProviderCredentialReferenceType;
    display_label: string;
    credential_ref_configured: boolean;
    env_ref_configured: boolean;
    secret_manager_ref_configured: boolean;
  };
  mode: CourierProviderRuntimeMode;
  last_test_status: string | null;
  checked_at: string;
  blockers: string[];
};

export type CourierProviderCapabilityReadiness = {
  capability: CourierProviderCapability;
  supported: boolean;
  status: "READY" | "BLOCKED" | "UNSUPPORTED";
  blockers: string[];
  next_actions: string[];
};

export type CourierProviderLaneReadinessDiagnostic = {
  lane_code: CourierProviderLaneCode;
  provider_code: CourierProviderCode;
  requested_mode: CourierProviderRuntimeMode;
  lane_status: CourierProviderLaneStatus;
  status: CourierProviderCredentialReadinessStatus;
  blocked: boolean;
  blockers: string[];
  next_actions: string[];
  credential_readiness: CourierProviderLaneCredentialReadiness;
  capability_matrix: CourierProviderCapabilityReadiness[];
  public_network_name: "Shipmastr Courier Network";
  public_outcomes: readonly [
    "Shipmastr Smart",
    "Shipmastr Economy",
    "Shipmastr Express",
    "Shipmastr COD Shield",
    "Shipmastr Weight Guard",
    "Shipmastr Autopilot"
  ];
  admin_context: {
    provider_label_internal: string;
    lane_type: CourierProviderLaneType;
    transport_mode: CourierProviderTransportMode;
    base_url_ref: string;
    credential_reference_state: CourierProviderLaneCredentialReadiness["reference"];
  };
};

export type CourierProviderWorkflowGuardStatus =
  | "ALLOWED"
  | "BLOCKED"
  | "UNSUPPORTED"
  | "DRY_RUN_ONLY";

export type CourierProviderWorkflowGuardResult = {
  lane_code: CourierProviderLaneCode;
  capability: CourierProviderCapability;
  requested_mode: CourierProviderRuntimeMode;
  status: CourierProviderWorkflowGuardStatus;
  allowed: boolean;
  public_network_name: "Shipmastr Courier Network";
  public_outcomes: readonly [
    "Shipmastr Smart",
    "Shipmastr Economy",
    "Shipmastr Express",
    "Shipmastr COD Shield",
    "Shipmastr Weight Guard",
    "Shipmastr Autopilot"
  ];
  seller_safe_message: string;
  blockers: string[];
  warnings: string[];
  credential_readiness: CourierProviderLaneCredentialReadiness;
  admin_context: {
    provider_code: CourierProviderCode;
    lane_type: CourierProviderLaneType;
    transport_mode: CourierProviderTransportMode;
    lane_status: CourierProviderLaneStatus;
    base_url_ref: string;
  };
};

export type CourierProviderRegistryListQuery = {
  providerCode?: CourierProviderCode;
  status?: CourierProviderLaneStatus;
  mode?: CourierProviderRuntimeMode;
  capability?: CourierProviderCapability;
};

export type CourierProviderRegistryDependencies = {
  credentialReadinessProvider?: (
    merchantId: string | null,
    lane: CourierProviderLaneDefinition,
    mode: CourierProviderRuntimeMode
  ) => Promise<CourierProviderLaneCredentialReadiness>;
  checkedAt?: string;
};

export type CourierProviderRegistryDb = Prisma.TransactionClient;
