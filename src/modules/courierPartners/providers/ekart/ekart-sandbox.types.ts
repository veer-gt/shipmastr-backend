import type {
  CourierProviderCapability,
  CourierProviderLaneCode,
  CourierProviderRuntimeMode
} from "../../providerRegistry/courier-provider-registry.types.js";

export const ekartSandboxLaneCodes = [
  "EKART"
] as const satisfies readonly CourierProviderLaneCode[];

export type EkartSandboxLaneCode = typeof ekartSandboxLaneCodes[number];

export type EkartSandboxBlocker =
  | "OFFICIAL_DOCS_REQUIRED"
  | "SANDBOX_CREDENTIAL_REF_REQUIRED"
  | "EXTERNAL_CALL_DISABLED"
  | "EKART_SANDBOX_MODE_REQUIRED"
  | "EKART_LANE_UNSUPPORTED"
  | "COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"
  | "COURIER_PROVIDER_LANE_DISABLED"
  | "COURIER_PROVIDER_LANE_SUSPENDED";

export type EkartSandboxReadinessStatus =
  | "BLOCKED"
  | "READY_FOR_CONTRACTED_SANDBOX";

export type EkartSandboxReadiness = {
  provider_code: "EKART";
  lane_code: EkartSandboxLaneCode;
  requested_mode: CourierProviderRuntimeMode;
  status: EkartSandboxReadinessStatus;
  blocked: boolean;
  blockers: EkartSandboxBlocker[];
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

export type EkartSandboxAdapterOptions = {
  officialDocsAvailable?: boolean;
  checkedAt?: string;
};

export type EkartSandboxCapabilityContext = {
  capability: CourierProviderCapability;
  mode: CourierProviderRuntimeMode;
  merchantId: string;
};
