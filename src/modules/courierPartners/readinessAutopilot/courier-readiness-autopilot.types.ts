import type { CourierCertificationSnapshot } from "../certification/courier-certification.types.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import type { CourierArbitrationCapability } from "../arbitration/courier-arbitration.types.js";

export const courierReadinessAutopilotLifecycleStates = [
  "NOT_CONFIGURED",
  "CREDENTIALS_READY",
  "PICKUP_READY",
  "RATES_READY",
  "AWB_SANDBOX_READY",
  "AWB_CERTIFIED",
  "LABEL_SANDBOX_READY",
  "LABEL_CERTIFIED",
  "TRACKING_SANDBOX_READY",
  "TRACKING_CERTIFIED",
  "PILOT_READY",
  "LIVE_READY",
  "DRY_RUN_ONLY",
  "BLOCKED",
  "REVOKED"
] as const;
export type CourierReadinessAutopilotLifecycleState = typeof courierReadinessAutopilotLifecycleStates[number];

export const courierReadinessAutopilotCapabilityStatuses = [
  "READY",
  "BLOCKED",
  "DRY_RUN_ONLY",
  "NOT_CONFIGURED",
  "ONE_SHOT_READY",
  "LIVE_READ_READY",
  "NOT_CERTIFIED"
] as const;
export type CourierReadinessAutopilotCapabilityStatus = typeof courierReadinessAutopilotCapabilityStatuses[number];

export const courierReadinessAutopilotNextActions = [
  "CONNECT_CREDENTIALS",
  "VERIFY_PICKUP",
  "REFRESH_RATES",
  "RUN_PICKUP_TRIAL",
  "RUN_AWB_DRY_RUN",
  "RUN_AWB_ONE_SHOT",
  "RUN_LABEL_DRY_RUN",
  "RUN_LABEL_ONE_SHOT",
  "RUN_TRACKING_DRY_RUN",
  "RUN_TRACKING_ONE_SHOT",
  "KEEP_IN_REVIEW",
  "READY_FOR_PILOT",
  "READY_FOR_LIVE"
] as const;
export type CourierReadinessAutopilotNextAction = typeof courierReadinessAutopilotNextActions[number];

export type CourierReadinessAutopilotCapabilities = {
  rates: Extract<CourierReadinessAutopilotCapabilityStatus, "READY" | "BLOCKED" | "DRY_RUN_ONLY" | "NOT_CONFIGURED">;
  awb: Extract<CourierReadinessAutopilotCapabilityStatus, "READY" | "BLOCKED" | "ONE_SHOT_READY" | "NOT_CERTIFIED">;
  label: Extract<CourierReadinessAutopilotCapabilityStatus, "READY" | "BLOCKED" | "ONE_SHOT_READY" | "NOT_CERTIFIED">;
  tracking: Extract<CourierReadinessAutopilotCapabilityStatus, "READY" | "BLOCKED" | "LIVE_READ_READY" | "NOT_CERTIFIED">;
};

export type CourierReadinessAutopilotInput = {
  shipmentId?: string;
  pickupLocationId?: string;
  requestedCapability?: CourierArbitrationCapability;
  includeArbitration?: boolean;
  includePickupLearning?: boolean;
  includeSandboxes?: boolean;
};

export type CourierReadinessAutopilotProviderResult = {
  provider_key_internal: CourierLiveProviderKey;
  public_network_name: "Shipmastr Courier Network";
  lifecycle_state: CourierReadinessAutopilotLifecycleState;
  capabilities: CourierReadinessAutopilotCapabilities;
  blockers: string[];
  warnings: string[];
  next_safe_action: CourierReadinessAutopilotNextAction;
  admin_next_actions: string[];
  seller_safe_message: string;
  requested_capability: CourierArbitrationCapability;
  shipment_id: string | null;
  checked_at: string;
};

export type CourierReadinessAutopilotProviderList = {
  public_network_name: "Shipmastr Courier Network";
  shipment_id: string | null;
  requested_capability: CourierArbitrationCapability;
  checked_at: string;
  providers: CourierReadinessAutopilotProviderResult[];
  counts: {
    total: number;
    live_ready: number;
    pilot_ready: number;
    dry_run_only: number;
    blocked: number;
    not_configured: number;
  };
  blockers: string[];
  warnings: string[];
  next_safe_actions: CourierReadinessAutopilotNextAction[];
};

export type CourierReadinessAutopilotDependencies = {
  certificationProvider?: (merchantId: string, providerKey: CourierLiveProviderKey, input: CourierReadinessAutopilotInput) => Promise<CourierCertificationSnapshot>;
  certificationListProvider?: (merchantId: string, input: CourierReadinessAutopilotInput) => Promise<CourierCertificationSnapshot[]>;
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
    blockers: string[];
    warnings: string[];
    seller_safe_message: string;
    admin_next_actions: string[];
  }>;
  checkedAt?: string;
};
