import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";

export const courierCertificationStatuses = [
  "NOT_CONFIGURED",
  "BLOCKED",
  "PARTIAL",
  "READY_FOR_DRY_RUN",
  "READY_FOR_PILOT",
  "READY_FOR_LIVE",
  "REVOKED"
] as const;
export type CourierCertificationStatus = typeof courierCertificationStatuses[number];

export const courierCertificationDimensions = [
  "CREDENTIALS",
  "PICKUPS",
  "SERVICEABILITY",
  "RATES",
  "COURIER_ID_MAPPING",
  "AWB",
  "LABEL",
  "TRACKING",
  "WEBHOOKS",
  "PUBLIC_SAFETY"
] as const;
export type CourierCertificationDimensionKey = typeof courierCertificationDimensions[number];

export const courierCertificationDimensionStatuses = [
  "PASS",
  "FAIL",
  "WARN",
  "NOT_RUN",
  "NOT_SUPPORTED"
] as const;
export type CourierCertificationDimensionStatus = typeof courierCertificationDimensionStatuses[number];

export type CourierCertificationBlocker =
  | "PROVIDER_CREDENTIALS_MISSING"
  | "PROVIDER_CREDENTIAL_TEST_NOT_RUN"
  | "PROVIDER_CREDENTIAL_TEST_FAILED"
  | "PROVIDER_PICKUP_NOT_FOUND"
  | "PROVIDER_PICKUP_PINCODE_MISMATCH"
  | "PROVIDER_PICKUP_UNAVAILABLE"
  | "PROVIDER_SERVICEABILITY_NOT_RUN"
  | "PROVIDER_SERVICEABILITY_NO_CANDIDATES"
  | "PROVIDER_RATES_NOT_LIVE"
  | "PROVIDER_LATEST_RATE_REFRESH_NO_ELIGIBLE_RATES"
  | "PROVIDER_COURIER_ID_MISSING"
  | "PROVIDER_AWB_NOT_CERTIFIED"
  | "PROVIDER_LABEL_NOT_CERTIFIED"
  | "PROVIDER_TRACKING_NOT_CERTIFIED"
  | "PROVIDER_PUBLIC_SAFETY_NOT_CERTIFIED"
  | "PROVIDER_MUTATION_NOT_ALLOWED"
  | "PROVIDER_LIVE_ONE_SHOT_REQUIRED";

export type CourierCertificationDimension = {
  key: CourierCertificationDimensionKey;
  status: CourierCertificationDimensionStatus;
  blockers: string[];
  warnings: string[];
  safe_summary: Record<string, unknown>;
};

export type CourierCertificationSnapshot = {
  provider_key: CourierLiveProviderKey;
  provider_label_internal: string;
  public_network_name: "Shipmastr Courier Network";
  status: CourierCertificationStatus;
  live_ready: boolean;
  can_use_for_rates: boolean;
  can_use_for_awb: boolean;
  can_use_for_label: boolean;
  can_use_for_tracking: boolean;
  dimensions: CourierCertificationDimension[];
  blockers: string[];
  warnings: string[];
  next_actions: string[];
  checked_at: string;
};

export type CourierCertificationSummary = {
  merchant_id: string;
  public_network_name: "Shipmastr Courier Network";
  checked_at: string;
  providers: CourierCertificationSnapshot[];
  counts: {
    total: number;
    live_ready: number;
    pilot_ready: number;
    dry_run_ready: number;
    blocked: number;
    not_configured: number;
  };
  blockers: string[];
  warnings: string[];
  next_actions: string[];
};

export type SellerSafeCourierAvailability = {
  status: "AVAILABLE" | "TEMPORARILY_UNAVAILABLE" | "CHECKING" | "CONTACT_SUPPORT";
  message: string;
  next_actions: string[];
};
