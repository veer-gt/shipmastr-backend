import type {
  CourierProviderCapability,
  CourierProviderLaneCode,
  CourierProviderRuntimeMode
} from "../../providerRegistry/courier-provider-registry.types.js";

export const shadowfaxSandboxLaneCodes = [
  "SHADOWFAX"
] as const satisfies readonly CourierProviderLaneCode[];

export type ShadowfaxSandboxLaneCode = typeof shadowfaxSandboxLaneCodes[number];

export type ShadowfaxSandboxBlocker =
  | "OFFICIAL_DOCS_REQUIRED"
  | "SANDBOX_CREDENTIAL_REF_REQUIRED"
  | "EXTERNAL_CALL_DISABLED"
  | "SHADOWFAX_SANDBOX_MODE_REQUIRED"
  | "SHADOWFAX_LANE_UNSUPPORTED"
  | "COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"
  | "COURIER_PROVIDER_LANE_DISABLED"
  | "COURIER_PROVIDER_LANE_SUSPENDED";

export type ShadowfaxSandboxReadinessStatus =
  | "BLOCKED"
  | "READY_FOR_CONTRACTED_SANDBOX";

export type ShadowfaxSandboxReadiness = {
  provider_code: "SHADOWFAX";
  lane_code: ShadowfaxSandboxLaneCode;
  requested_mode: CourierProviderRuntimeMode;
  status: ShadowfaxSandboxReadinessStatus;
  blocked: boolean;
  blockers: ShadowfaxSandboxBlocker[];
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

export type ShadowfaxSandboxAdapterOptions = {
  officialDocsAvailable?: boolean;
  checkedAt?: string;
};

export type ShadowfaxSandboxCapabilityContext = {
  capability: CourierProviderCapability;
  mode: CourierProviderRuntimeMode;
  merchantId: string;
};
