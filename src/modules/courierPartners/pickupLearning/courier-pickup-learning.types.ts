export type CourierPickupLearningStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";

export type CourierPickupLearningRecommendation =
  | "USE_PICKUP"
  | "TRY_ALTERNATE_PICKUP"
  | "TRY_ALTERNATE_PROVIDER"
  | "KEEP_IN_REVIEW"
  | "RUN_RATE_REFRESH";

export type CourierPickupLearningObservation = {
  provider_key: string;
  pickup_location_id: string | null;
  pickup_pincode: string;
  delivery_pincode: string | null;
  public_service_code: string | null;
  internal_courier_id_present: boolean;
  provider_courier_id_suffix?: string | null;
  live_mode: boolean;
  live_ready: boolean;
  pickup_available: boolean | null;
  delivery_available: boolean | null;
  eligible_rate_count: number;
  candidate_rate_count: number;
  observed_at: string;
};

export type CourierPickupLearningClassification = {
  provider_key: string;
  pickup_pincode: string | null;
  delivery_pincode: string | null;
  status: CourierPickupLearningStatus;
  availability_score: number;
  observation_count: number;
  pickup_available_count: number;
  pickup_unavailable_count: number;
  delivery_available_count: number;
  latest_observed_at: string | null;
  recommendation: CourierPickupLearningRecommendation;
};

export type CourierPickupLearningProviderSummary = {
  provider_key: string;
  status: CourierPickupLearningStatus;
  availability_score: number;
  observation_count: number;
  pickup_count: number;
  unavailable_pickup_count: number;
  latest_observed_at: string | null;
  recommendation: CourierPickupLearningRecommendation;
  pickups: CourierPickupLearningClassification[];
};
