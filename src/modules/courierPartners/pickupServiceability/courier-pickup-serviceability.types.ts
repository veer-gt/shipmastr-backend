export type CourierPickupServiceabilityStatus =
  | "PICKUP_AVAILABLE"
  | "PICKUP_UNAVAILABLE"
  | "NO_ELIGIBLE_RATES"
  | "NO_PROVIDER_CANDIDATES"
  | "PICKUP_CONTEXT_MISMATCH"
  | "NEEDS_PROVIDER_PICKUP_VERIFICATION"
  | "UNKNOWN";

export type CourierPickupTrialStatus =
  | "PICKUP_AVAILABLE"
  | "PICKUP_UNAVAILABLE"
  | "NOT_CHECKED"
  | "MISMATCH"
  | "UNKNOWN";

export type CourierPickupServiceabilityRecommendationAction =
  | "KEEP_SELECTED"
  | "TRY_ALTERNATE_PICKUP"
  | "TRY_ALTERNATE_PROVIDER"
  | "SAFE_REVIEW";

export type CourierPickupServiceabilityContext = {
  live_mode: boolean;
  live_ready: boolean;
  candidate_count: number;
  eligible_count: number;
  pickup_available_count: number;
  delivery_available_count: number;
  numeric_courier_id_count: number;
};

export type CourierPickupServiceabilityResult = {
  provider_key: "SHIPROCKET" | string;
  public_network_name: "Shipmastr Courier Network";
  shipment_id: string;
  pickup_location_id: string | null;
  pickup_pincode: string | null;
  delivery_pincode: string | null;
  status: CourierPickupServiceabilityStatus;
  latest_rate_context: CourierPickupServiceabilityContext;
  blockers: string[];
  warnings: string[];
  next_actions: string[];
  seller_safe_message: string;
  recommended_action: CourierPickupServiceabilityRecommendationAction;
};

export type CourierPickupTrialResult = {
  shipment_id: string;
  provider_key: "SHIPROCKET" | string;
  pickups: Array<{
    pickup_location_id: string;
    name: string | null;
    city: string | null;
    state: string | null;
    pincode: string;
    active: boolean;
    selected: boolean;
    status: CourierPickupTrialStatus;
    blockers: string[];
    seller_safe_message: string;
  }>;
  recommendation: {
    action: CourierPickupServiceabilityRecommendationAction;
    pickup_location_id: string | null;
    reason: string;
  };
};
