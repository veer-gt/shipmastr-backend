import type {
  CourierProviderCapability,
  CourierProviderLaneCode,
  CourierProviderRuntimeMode
} from "../../providerRegistry/courier-provider-registry.types.js";

export const delhiverySandboxLaneCodes = [
  "DELHIVERY_B2C_AIR",
  "DELHIVERY_B2C_SURFACE"
] as const satisfies readonly CourierProviderLaneCode[];

export type DelhiverySandboxLaneCode = typeof delhiverySandboxLaneCodes[number];

export type DelhiverySandboxBlocker =
  | "OFFICIAL_DOCS_REQUIRED"
  | "SANDBOX_CREDENTIAL_REF_REQUIRED"
  | "EXTERNAL_CALL_DISABLED"
  | "DELHIVERY_SANDBOX_MODE_REQUIRED"
  | "DELHIVERY_LANE_UNSUPPORTED"
  | "COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"
  | "COURIER_PROVIDER_LANE_DISABLED"
  | "COURIER_PROVIDER_LANE_SUSPENDED";

export type DelhiverySandboxReadinessStatus =
  | "BLOCKED"
  | "READY_FOR_CONTRACTED_SANDBOX";

export type DelhiverySandboxReadiness = {
  provider_code: "DELHIVERY";
  lane_code: DelhiverySandboxLaneCode;
  requested_mode: CourierProviderRuntimeMode;
  status: DelhiverySandboxReadinessStatus;
  blocked: boolean;
  blockers: DelhiverySandboxBlocker[];
  official_docs_available: boolean;
  sandbox_credential_ref_configured: boolean;
  external_call_enabled: false;
  credential_reference_state: {
    configured: boolean;
    ref_type: string;
    display_label: string;
  };
  safe_message: string;
};

export type DelhiverySandboxAdapterOptions = {
  officialDocsAvailable?: boolean;
  checkedAt?: string;
};

export type DelhiverySandboxCapabilityContext = {
  capability: CourierProviderCapability;
  mode: CourierProviderRuntimeMode;
  merchantId: string;
};
