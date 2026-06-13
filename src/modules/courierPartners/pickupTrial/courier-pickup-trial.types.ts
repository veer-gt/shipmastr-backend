export type CourierPickupTrialMode = "DRY_RUN" | "CONTROLLED_REFRESH";

export type CourierPickupTrialStatus =
  | "ELIGIBLE_RATES_FOUND"
  | "NO_ELIGIBLE_RATES"
  | "PICKUP_UNAVAILABLE"
  | "NO_PROVIDER_CANDIDATES"
  | "BLOCKED"
  | "CONTROLLED_REFRESH_REQUIRED"
  | "DRY_RUN_ONLY";

export type CourierPickupTrialRateContext = {
  candidate_count: number;
  eligible_count: number;
  pickup_available_count: number;
  delivery_available_count: number;
  numeric_courier_id_count: number;
};

export type CourierPickupTrialRateOption = {
  public_service_code: "shipmastr_smart" | "shipmastr_economy" | "shipmastr_express";
  public_service_name: string;
  amount_paise: number | null;
  estimated_delivery_days: number | null;
};

export type CourierPickupTrialResult = {
  trial_id: string;
  provider_key: "SHIPROCKET" | string;
  public_network_name: "Shipmastr Courier Network";
  shipment_id: string;
  current_pickup_location_id: string | null;
  trial_pickup_location_id: string;
  trial_pickup_pincode: string;
  delivery_pincode: string | null;
  status: CourierPickupTrialStatus;
  rate_context: CourierPickupTrialRateContext;
  public_rate_options: CourierPickupTrialRateOption[];
  blockers: string[];
  warnings: string[];
  seller_safe_message: string;
  admin_next_actions: string[];
};

export type CourierPickupTrialRatePreview = {
  publicServiceCode?: string | null;
  publicServiceName?: string | null;
  amountPaise?: number | null;
  estimatedDeliveryDays?: number | null;
  pickupAvailable?: boolean | null;
  deliveryAvailable?: boolean | null;
  providerCourierId?: string | number | null;
};
