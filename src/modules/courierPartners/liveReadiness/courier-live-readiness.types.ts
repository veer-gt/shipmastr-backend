export const courierLiveProviderKeys = ["BIGSHIP", "SHIPMOZO", "SHIPROCKET"] as const;
export type CourierLiveProviderKey = typeof courierLiveProviderKeys[number];

export const courierLiveReadinessModes = ["SANDBOX", "LIVE", "DRY_RUN", "MOCK"] as const;
export type CourierLiveReadinessMode = typeof courierLiveReadinessModes[number];

export const courierLiveReadinessStatuses = [
  "DRAFT",
  "MISSING_CREDENTIALS",
  "CONFIGURED",
  "TESTING",
  "ACTIVE",
  "FAILED",
  "REVOKED",
  "BLOCKED"
] as const;
export type CourierLiveReadinessStatus = typeof courierLiveReadinessStatuses[number];

export const courierLiveProbeTypes = [
  "ACCOUNT_INFO",
  "WAREHOUSE_LIST",
  "PICKUP_ADDRESS_LIST",
  "PINCODE_SERVICEABILITY",
  "RATE_SERVICEABILITY",
  "WALLET_OR_BALANCE_STATUS"
] as const;
export type CourierLiveProbeType = typeof courierLiveProbeTypes[number];

export const forbiddenCourierLiveProbeTypes = [
  "CREATE_SHIPMENT",
  "CREATE_AWB",
  "CREATE_LABEL",
  "MANIFEST",
  "CANCEL",
  "TRACKING_SYNC",
  "WEBHOOK_REGISTRATION",
  "PLATFORM_WRITE"
] as const;

export type CourierLiveReadinessBlocker =
  | "LIVE_PROVIDER_CREDENTIALS_MISSING"
  | "LIVE_PROVIDER_CREDENTIALS_INCOMPLETE"
  | "LIVE_PROVIDER_RUNTIME_DISABLED"
  | "LIVE_PROVIDER_TEST_NOT_RUN"
  | "LIVE_PROVIDER_TEST_FAILED"
  | "LIVE_PROVIDER_NON_DESTRUCTIVE_PROBE_MISSING"
  | "LIVE_PROVIDER_NOT_PILOT_GATED"
  | "LIVE_PROVIDER_SECRET_STORAGE_INVALID"
  | "LIVE_PROVIDER_UNSUPPORTED";

export type CourierLiveProviderDefinition = {
  providerKey: CourierLiveProviderKey;
  label: string;
  requiredFields: string[];
  supportedProbeTypes: CourierLiveProbeType[];
  supportsAwbLabelReadiness: boolean;
  defaultLiveBaseUrl: string | null;
};

export type CourierLiveProviderSummary = {
  provider_key: CourierLiveProviderKey;
  label: string;
  required_fields: string[];
  supported_probe_types: CourierLiveProbeType[];
  supports_awb_label_readiness: boolean;
  default_live_base_url_configured: boolean;
};

export type CourierLiveCredentialSummary = {
  credential_id: string;
  merchant_id: string | null;
  provider_key: CourierLiveProviderKey;
  mode: CourierLiveReadinessMode;
  status: CourierLiveReadinessStatus;
  configured: boolean;
  credential_ref_configured: boolean;
  required_fields: string[];
  required_fields_present: string[];
  missing_fields: string[];
  safe_meta: Record<string, unknown> | null;
  last_tested_at: Date | string | null;
  last_test_status: string | null;
  last_test_summary: Record<string, unknown> | null;
  live_ready: boolean;
  blockers: CourierLiveReadinessBlocker[];
  created_at: Date | string;
  updated_at: Date | string;
};

export type CourierLiveProbeResult = {
  probe_id: string;
  credential_id: string | null;
  merchant_id: string | null;
  provider_key: CourierLiveProviderKey;
  probe_type: CourierLiveProbeType;
  mode: CourierLiveReadinessMode;
  status: "PASS" | "FAIL" | "SKIPPED";
  safe_summary: Record<string, unknown>;
  warnings: string[];
  errors: string[];
  tested_at: Date | string;
};

export type CourierLiveReadinessSnapshot = {
  merchant_id: string;
  checked_at: string;
  providers: Array<{
    provider_key: CourierLiveProviderKey;
    label: string;
    credential: CourierLiveCredentialSummary | null;
    live_ready: boolean;
    blockers: CourierLiveReadinessBlocker[];
  }>;
  active_provider_count: number;
  has_active_provider: boolean;
  blockers: CourierLiveReadinessBlocker[];
};
