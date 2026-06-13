import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";

export const courierArbitrationCapabilities = ["RATES", "AWB", "LABEL", "TRACKING"] as const;
export type CourierArbitrationCapability = typeof courierArbitrationCapabilities[number];

export type CourierArbitrationDecision =
  | "USE_SELECTED"
  | "TRY_ALTERNATE_PICKUP"
  | "TRY_ALTERNATE_PROVIDER"
  | "RUN_PICKUP_TRIAL"
  | "SAFE_REVIEW";

export type CourierArbitrationOptionStatus =
  | "READY"
  | "BLOCKED"
  | "DRY_RUN_ONLY"
  | "NOT_CHECKED"
  | "TRIAL_REQUIRED";

export type CourierArbitrationSelectedOption = {
  provider_key_internal?: CourierLiveProviderKey;
  pickup_location_id?: string | null;
  pickup_pincode?: string | null;
  public_network_name: "Shipmastr Courier Network";
  public_service_code?: "shipmastr_smart" | "shipmastr_economy" | "shipmastr_express";
};

export type CourierArbitrationEvaluatedOption = {
  provider_key_internal: CourierLiveProviderKey;
  pickup_location_id: string | null;
  pickup_pincode: string | null;
  status: CourierArbitrationOptionStatus;
  blockers: string[];
  warnings: string[];
  seller_safe_message: string;
};

export type CourierArbitrationResult = {
  shipment_id: string;
  requested_capability: CourierArbitrationCapability;
  decision: CourierArbitrationDecision;
  selected_option: CourierArbitrationSelectedOption | null;
  evaluated_options: CourierArbitrationEvaluatedOption[];
  blockers: string[];
  warnings: string[];
  seller_safe_message: string;
  admin_next_actions: string[];
};
