import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";

export type CourierLabelCertificationStatus =
  | "READY_FOR_DRY_RUN"
  | "BLOCKED"
  | "READY_FOR_ONE_SHOT"
  | "MISSING_AWB"
  | "MISSING_PROVIDER_REFS"
  | "DRY_RUN_ONLY";

export type CourierLabelCertificationBlocker =
  | "LABEL_CERTIFICATION_AWB_MISSING"
  | "LABEL_CERTIFICATION_PROVIDER_REFS_MISSING"
  | "LABEL_CERTIFICATION_CREDENTIALS_NOT_READY"
  | "LABEL_CERTIFICATION_ADAPTER_MISSING"
  | "LABEL_CERTIFICATION_PUBLIC_SAFETY_NOT_READY"
  | "LABEL_CERTIFICATION_RAW_PROVIDER_URL_BLOCKED"
  | "LABEL_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED"
  | "LABEL_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH"
  | "LABEL_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH"
  | "LABEL_CERTIFICATION_LIVE_MODE_DISABLED"
  | "LABEL_CERTIFICATION_PROVIDER_CALL_FAILED"
  | "LABEL_CERTIFICATION_PROVIDER_RESPONSE_INVALID"
  | "LABEL_CERTIFICATION_EXISTING_LABEL_READY";

export type CourierLabelPayloadReadiness = {
  awb_ready: boolean;
  provider_refs_ready: boolean;
  label_adapter_ready: boolean;
  label_public_safety_ready: boolean;
  no_raw_provider_label_leak: boolean;
};

export type CourierLabelLiveGateReadiness = {
  label_live_enabled: boolean;
  live_mode: boolean;
  pilot_only: boolean;
  allowed_merchant_matched: boolean;
  allowed_shipment_matched: boolean;
  approval_present: boolean;
  one_shot_ready: boolean;
};

export type CourierLabelCertificationDryRunResult = {
  provider_key: CourierLiveProviderKey;
  public_network_name: "Shipmastr Courier Network";
  shipment_id: string;
  pickup_location_id: string | null;
  dry_run_ready: boolean;
  live_one_shot_ready: boolean;
  status: CourierLabelCertificationStatus;
  payload_readiness: CourierLabelPayloadReadiness;
  live_gate_readiness: CourierLabelLiveGateReadiness;
  blockers: CourierLabelCertificationBlocker[];
  warnings: string[];
  seller_safe_message: string;
  admin_next_actions: string[];
};

export type CourierLabelCertificationProviderStatus = {
  provider_key: CourierLiveProviderKey;
  public_network_name: "Shipmastr Courier Network";
  sandbox_available: boolean;
  status: "READY_FOR_DRY_RUN" | "UNSUPPORTED" | "BLOCKED";
  label_dimension_status: string;
  can_use_for_label: boolean;
  blockers: string[];
  warnings: string[];
  next_actions: string[];
};

export type CourierLabelCertificationLiveOneShotStatus =
  | "LABEL_CERTIFIED"
  | "BLOCKED"
  | "ALREADY_CERTIFIED"
  | "PENDING_TRACKING_CERTIFICATION";

export type CourierLabelCertificationLiveOneShotResult = {
  success: boolean;
  provider_key: CourierLiveProviderKey;
  public_network_name: "Shipmastr Courier Network";
  shipment_id: string;
  label_status: "CERTIFIED" | "BLOCKED" | "ALREADY_CERTIFIED";
  public_label_status: "READY" | "NOT_READY";
  shipmastr_label_ref: string | null;
  tracking_ready: boolean;
  certification_status: CourierLabelCertificationLiveOneShotStatus;
  blockers: CourierLabelCertificationBlocker[];
  warnings: string[];
  seller_safe_message: string;
  admin_next_actions: string[];
};
