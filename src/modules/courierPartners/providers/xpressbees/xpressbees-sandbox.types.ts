import type {
  CourierProviderCapability,
  CourierProviderLaneCode,
  CourierProviderRuntimeMode
} from "../../providerRegistry/courier-provider-registry.types.js";

export const xpressbeesSandboxLaneCodes = [
  "XPRESSBEES_AIR",
  "XPRESSBEES_SURFACE"
] as const satisfies readonly CourierProviderLaneCode[];

export type XpressbeesSandboxLaneCode = typeof xpressbeesSandboxLaneCodes[number];

export type XpressbeesSandboxBlocker =
  | "OFFICIAL_DOCS_REQUIRED"
  | "SANDBOX_CREDENTIAL_REF_REQUIRED"
  | "EXTERNAL_CALL_DISABLED"
  | "XPRESSBEES_SANDBOX_MODE_REQUIRED"
  | "XPRESSBEES_LANE_UNSUPPORTED"
  | "COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"
  | "COURIER_PROVIDER_LANE_DISABLED"
  | "COURIER_PROVIDER_LANE_SUSPENDED";

export type XpressbeesSandboxReadinessStatus =
  | "BLOCKED"
  | "READY_FOR_CONTRACTED_SANDBOX";

export type XpressbeesSandboxReadiness = {
  provider_code: "XPRESSBEES";
  lane_code: XpressbeesSandboxLaneCode;
  requested_mode: CourierProviderRuntimeMode;
  status: XpressbeesSandboxReadinessStatus;
  blocked: boolean;
  blockers: XpressbeesSandboxBlocker[];
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

export type XpressbeesSandboxAdapterOptions = {
  officialDocsAvailable?: boolean;
  checkedAt?: string;
};

export type XpressbeesSandboxCapabilityContext = {
  capability: CourierProviderCapability;
  mode: CourierProviderRuntimeMode;
  merchantId: string;
};
