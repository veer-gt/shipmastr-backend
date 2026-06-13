import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";

export const courierAwbCertificationTiers = ["smart", "economy", "express"] as const;
export type CourierAwbCertificationTier = typeof courierAwbCertificationTiers[number];

export type CourierAwbCertificationStatus =
  | "READY_FOR_DRY_RUN"
  | "BLOCKED"
  | "READY_FOR_ONE_SHOT"
  | "ALREADY_HAS_AWB"
  | "DRY_RUN_ONLY";

export type CourierAwbCertificationBlocker =
  | "AWB_CERTIFICATION_CREDENTIALS_NOT_READY"
  | "AWB_CERTIFICATION_PICKUP_NOT_READY"
  | "AWB_CERTIFICATION_PICKUP_UNAVAILABLE"
  | "AWB_CERTIFICATION_DELIVERY_NOT_READY"
  | "AWB_CERTIFICATION_PACKAGE_NOT_READY"
  | "AWB_CERTIFICATION_INVOICE_NOT_READY"
  | "AWB_CERTIFICATION_RATE_NOT_READY"
  | "AWB_CERTIFICATION_COURIER_ID_MISSING"
  | "AWB_CERTIFICATION_EXISTING_AWB"
  | "AWB_CERTIFICATION_PUBLIC_SAFETY_NOT_READY"
  | "AWB_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED"
  | "AWB_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH"
  | "AWB_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH"
  | "AWB_CERTIFICATION_LIVE_MODE_DISABLED"
  | "AWB_CERTIFICATION_PROVIDER_CALL_FAILED"
  | "AWB_CERTIFICATION_PROVIDER_RESPONSE_INVALID";

export type CourierAwbPayloadReadiness = {
  merchant_ready: boolean;
  credential_ready: boolean;
  pickup_ready: boolean;
  delivery_ready: boolean;
  package_ready: boolean;
  invoice_ready: boolean;
  selected_rate_ready: boolean;
  courier_id_ready: boolean;
  no_existing_awb: boolean;
  public_safety_ready: boolean;
};

export type CourierAwbLiveGateReadiness = {
  live_awb_enabled: boolean;
  live_mode: boolean;
  pilot_only: boolean;
  allowed_merchant_matched: boolean;
  allowed_shipment_matched: boolean;
  approval_present: boolean;
  one_shot_ready: boolean;
};

export type CourierAwbCertificationDryRunResult = {
  provider_key: CourierLiveProviderKey;
  public_network_name: "Shipmastr Courier Network";
  shipment_id: string;
  pickup_location_id: string | null;
  requested_tier: CourierAwbCertificationTier | null;
  dry_run_ready: boolean;
  live_one_shot_ready: boolean;
  status: CourierAwbCertificationStatus;
  payload_readiness: CourierAwbPayloadReadiness;
  live_gate_readiness: CourierAwbLiveGateReadiness;
  blockers: CourierAwbCertificationBlocker[];
  warnings: string[];
  seller_safe_message: string;
  admin_next_actions: string[];
};

export type CourierAwbCertificationProviderStatus = {
  provider_key: CourierLiveProviderKey;
  public_network_name: "Shipmastr Courier Network";
  sandbox_available: boolean;
  status: "READY_FOR_DRY_RUN" | "UNSUPPORTED" | "BLOCKED";
  awb_dimension_status: string;
  can_use_for_awb: boolean;
  blockers: string[];
  warnings: string[];
  next_actions: string[];
};

export type CourierAwbCertificationLiveOneShotStatus =
  | "AWB_CERTIFIED"
  | "BLOCKED"
  | "ALREADY_CERTIFIED"
  | "PENDING_LABEL_CERTIFICATION";

export type CourierAwbCertificationLiveOneShotResult = {
  success: boolean;
  provider_key: CourierLiveProviderKey;
  public_network_name: "Shipmastr Courier Network";
  shipment_id: string;
  public_awb_status: "CREATED" | "BLOCKED" | "ALREADY_EXISTS";
  shipmastr_awb_number: string | null;
  label_ready: boolean;
  tracking_ready: boolean;
  certification_status: CourierAwbCertificationLiveOneShotStatus;
  blockers: CourierAwbCertificationBlocker[];
  warnings: string[];
  seller_safe_message: string;
  admin_next_actions: string[];
};
