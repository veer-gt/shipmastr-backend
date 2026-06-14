import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";

export const courierOnboardingStepKeys = [
  "CONNECT_CREDENTIALS",
  "TEST_CREDENTIALS",
  "SYNC_PICKUPS",
  "ALIGN_PICKUP",
  "RUN_SERVICEABILITY_PROBE",
  "FETCH_LIVE_RATES",
  "VERIFY_COURIER_ID_MAPPING",
  "CERTIFY_AWB_ONE_SHOT",
  "CERTIFY_LABEL",
  "CERTIFY_TRACKING",
  "CERTIFY_WEBHOOKS",
  "CERTIFY_PUBLIC_SAFETY",
  "ENABLE_PILOT",
  "ENABLE_LIVE"
] as const;
export type CourierOnboardingStepKey = typeof courierOnboardingStepKeys[number];

export const courierOnboardingStepStatuses = ["TODO", "BLOCKED", "READY", "DONE", "SKIPPED", "NOT_SUPPORTED"] as const;
export type CourierOnboardingStepStatus = typeof courierOnboardingStepStatuses[number];

export type CourierOnboardingStep = {
  key: CourierOnboardingStepKey;
  label_internal: string;
  status: CourierOnboardingStepStatus;
  blockers: string[];
  warnings: string[];
  next_action: string;
  safe_summary: Record<string, unknown>;
};

export type CourierOnboardingChecklist = {
  provider_key: CourierLiveProviderKey;
  provider_label_internal: string;
  public_network_name: "Shipmastr Courier Network";
  certification_status: string;
  steps: CourierOnboardingStep[];
  blockers: string[];
  warnings: string[];
  next_actions: string[];
  checked_at: string;
};

export type CourierOnboardingSummary = {
  merchant_id: string;
  public_network_name: "Shipmastr Courier Network";
  checked_at: string;
  providers: CourierOnboardingChecklist[];
  counts: {
    total_providers: number;
    ready_for_pilot: number;
    ready_for_live: number;
    blocked: number;
    dry_run_only: number;
  };
  blockers: string[];
  warnings: string[];
  next_actions: string[];
};
