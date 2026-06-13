import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";

export const courierTrackingPublicStatuses = [
  "created",
  "manifested",
  "pickup_pending",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "rto_initiated",
  "rto_delivered",
  "cancelled",
  "unknown"
] as const;
export type CourierTrackingPublicStatus = typeof courierTrackingPublicStatuses[number];

export type CourierTrackingCertificationStatus =
  | "READY_FOR_DRY_RUN"
  | "BLOCKED"
  | "READY_FOR_LIVE_READ"
  | "MISSING_AWB"
  | "MISSING_TRACKING_REF"
  | "ADAPTER_MISSING"
  | "DRY_RUN_ONLY";

export type CourierTrackingCertificationBlocker =
  | "TRACKING_CERTIFICATION_AWB_MISSING"
  | "TRACKING_CERTIFICATION_REF_MISSING"
  | "TRACKING_CERTIFICATION_ADAPTER_MISSING"
  | "TRACKING_CERTIFICATION_MAPPER_MISSING"
  | "TRACKING_CERTIFICATION_PUBLIC_MAPPING_NOT_READY"
  | "TRACKING_CERTIFICATION_RAW_PROVIDER_PAYLOAD_BLOCKED"
  | "TRACKING_CERTIFICATION_LIVE_MODE_DISABLED"
  | "TRACKING_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH"
  | "TRACKING_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH"
  | "TRACKING_CERTIFICATION_APPROVAL_REQUIRED";

export type CourierTrackingPayloadReadiness = {
  awb_ready: boolean;
  tracking_ref_ready: boolean;
  tracking_adapter_ready: boolean;
  tracking_mapper_ready: boolean;
  public_status_mapping_ready: boolean;
  no_raw_provider_tracking_leak: boolean;
};

export type CourierTrackingLiveGateReadiness = {
  tracking_live_enabled: boolean;
  live_mode: boolean;
  pilot_only: boolean;
  allowed_merchant_matched: boolean;
  allowed_shipment_matched: boolean;
  approval_present: boolean;
  live_read_ready: boolean;
};

export type CourierTrackingCertificationDryRunResult = {
  provider_key: CourierLiveProviderKey;
  public_network_name: "Shipmastr Courier Network";
  shipment_id: string;
  pickup_location_id: string | null;
  dry_run_ready: boolean;
  live_read_ready: boolean;
  status: CourierTrackingCertificationStatus;
  payload_readiness: CourierTrackingPayloadReadiness;
  live_gate_readiness: CourierTrackingLiveGateReadiness;
  blockers: CourierTrackingCertificationBlocker[];
  warnings: string[];
  seller_safe_message: string;
  admin_next_actions: string[];
};

export type CourierTrackingCertificationProviderStatus = {
  provider_key: CourierLiveProviderKey;
  public_network_name: "Shipmastr Courier Network";
  sandbox_available: boolean;
  status: "READY_FOR_DRY_RUN" | "UNSUPPORTED" | "BLOCKED";
  tracking_dimension_status: string;
  can_use_for_tracking: boolean;
  public_status_mapping: Record<string, CourierTrackingPublicStatus>;
  blockers: string[];
  warnings: string[];
  next_actions: string[];
};
