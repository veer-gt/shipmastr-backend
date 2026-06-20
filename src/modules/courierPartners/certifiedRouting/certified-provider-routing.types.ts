import type { CourierArbitrationCapability } from "../arbitration/courier-arbitration.types.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import type {
  CourierProviderCapability,
  CourierProviderLaneCode,
  CourierProviderRuntimeMode,
  CourierProviderWorkflowGuardStatus
} from "../providerRegistry/courier-provider-registry.types.js";
import type {
  CourierReadinessAutopilotProviderList,
  CourierReadinessAutopilotProviderResult
} from "../readinessAutopilot/courier-readiness-autopilot.types.js";

export const certifiedProviderRoutingOutcomes = [
  "CHEAPEST",
  "FASTEST",
  "SAFEST",
  "BALANCED",
  "COD_SAFE",
  "DEFAULT_SMART"
] as const;
export type CertifiedProviderRoutingOutcome = typeof certifiedProviderRoutingOutcomes[number];

export const certifiedProviderRoutingPublicTiers = [
  "shipmastr_smart",
  "shipmastr_economy",
  "shipmastr_express"
] as const;
export type CertifiedProviderRoutingPublicTier = typeof certifiedProviderRoutingPublicTiers[number];

export const certifiedProviderRoutingDecisions = [
  "ROUTE_READY",
  "RATES_ONLY",
  "AWB_READY",
  "TRY_ALTERNATE_PICKUP",
  "TRY_ALTERNATE_PROVIDER",
  "RUN_PICKUP_TRIAL",
  "SAFE_REVIEW",
  "BLOCKED"
] as const;
export type CertifiedProviderRoutingDecision = typeof certifiedProviderRoutingDecisions[number];

export type CertifiedProviderRoutingInput = {
  shipmentId: string;
  requestedOutcome?: CertifiedProviderRoutingOutcome;
  requestedCapability?: CourierArbitrationCapability;
  pickupLocationId?: string;
  preferredPublicTier?: CertifiedProviderRoutingPublicTier;
};

export type CertifiedProviderRoutingRateCandidate = {
  id: string;
  publicServiceCode?: string | null;
  publicServiceName?: string | null;
  rateBreakup?: unknown;
  createdAt?: Date | string;
};

export type CertifiedProviderRoutingResult = {
  shipment_id: string;
  public_network_name: "Shipmastr Courier Network";
  decision: CertifiedProviderRoutingDecision;
  selected_public_tier: CertifiedProviderRoutingPublicTier | null;
  selected_public_service_name: string | null;
  selected_rate_id: string | null;
  selected_pickup_location_id: string | null;
  internal_selection: {
    provider_key_internal: CourierLiveProviderKey | null;
    internal_courier_id_present: boolean;
    provider_rate_id_present: boolean;
    provider_refs_required: boolean;
  };
  readiness: {
    provider_lifecycle_state: string;
    rates_ready: boolean;
    awb_ready: boolean;
    label_ready: boolean;
    tracking_ready: boolean;
    pickup_available: boolean;
  };
  blockers: string[];
  warnings: string[];
  seller_safe_message: string;
  admin_next_actions: string[];
  admin_diagnostics: {
    fallback_used: boolean;
    no_eligible_provider: boolean;
    evaluated_providers: CertifiedProviderRoutingProviderDiagnostic[];
  };
};

export type CertifiedProviderRoutingDependencies = {
  shipmentProvider?: (merchantId: string, shipmentId: string) => Promise<{
    id: string;
    pickupLocationId?: string | null;
  }>;
  readinessProvider?: (
    merchantId: string,
    input: CertifiedProviderRoutingInput
  ) => Promise<CourierReadinessAutopilotProviderList>;
  arbitrationProvider?: (
    merchantId: string,
    input: {
      shipmentId: string;
      requestedCapability: CourierArbitrationCapability;
      preferredProviderKey?: CourierLiveProviderKey;
      pickupLocationId?: string;
    }
  ) => Promise<{
    decision: string;
    selected_option?: {
      provider_key_internal?: CourierLiveProviderKey;
      pickup_location_id?: string | null;
      public_service_code?: CertifiedProviderRoutingPublicTier;
    } | null;
    blockers: string[];
    warnings: string[];
    seller_safe_message: string;
    admin_next_actions: string[];
  }>;
  ratesProvider?: (merchantId: string, shipmentId: string) => Promise<CertifiedProviderRoutingRateCandidate[]>;
  providerWorkflowGuardProvider?: (
    merchantId: string,
    input: {
      provider: CourierReadinessAutopilotProviderResult;
      providerKey: CourierLiveProviderKey;
      laneCode: CourierProviderLaneCode | null;
      requestedCapability: CourierArbitrationCapability;
      providerCapability: CourierProviderCapability;
      mode: CourierProviderRuntimeMode;
    }
  ) => Promise<CertifiedProviderRoutingWorkflowGuard>;
};

export type CertifiedProviderRoutingSelection = {
  provider: CourierReadinessAutopilotProviderResult | null;
  rate: CertifiedProviderRoutingRateCandidate | null;
  pickupLocationId: string | null;
};

export type CertifiedProviderRoutingWorkflowGuard = {
  lane_code: CourierProviderLaneCode | null;
  capability: CourierProviderCapability;
  requested_mode: CourierProviderRuntimeMode;
  status: CourierProviderWorkflowGuardStatus | "NOT_MODELED";
  allowed: boolean;
  blockers: string[];
  warnings: string[];
  next_actions: string[];
};

export type CertifiedProviderRoutingProviderDiagnostic = {
  provider_key_internal: CourierLiveProviderKey;
  lane_code_internal: CourierProviderLaneCode | null;
  eligible: boolean;
  preferred: boolean;
  selected: boolean;
  fallback_reason: string | null;
  lifecycle_state: string;
  capability_status: string;
  registry_status: CertifiedProviderRoutingWorkflowGuard["status"];
  pickup_available: boolean;
  blockers: string[];
  warnings: string[];
  next_actions: string[];
};
