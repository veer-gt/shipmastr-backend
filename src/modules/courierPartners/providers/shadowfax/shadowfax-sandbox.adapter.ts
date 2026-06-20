import { prisma } from "../../../../lib/prisma.js";
import {
  getCourierProviderLane,
  getCourierProviderLaneCredentialReadiness
} from "../../providerRegistry/courier-provider-registry.service.js";
import {
  normalizeProviderShipmentStatus,
  providerLaneSupportsCapability
} from "../../providerRegistry/courier-provider-registry.rules.js";
import type {
  CourierProviderCapability,
  CourierProviderInternalShipmentStatus,
  CourierProviderRegistryDependencies
} from "../../providerRegistry/courier-provider-registry.types.js";
import type {
  CourierProviderAwbRequest,
  CourierProviderCancelRequest,
  CourierProviderCodRemittanceRequest,
  CourierProviderLabelRequest,
  CourierProviderNdrRequest,
  CourierProviderPickupRequest,
  CourierProviderRateRequest,
  CourierProviderStatusMappingRequest,
  CourierProviderTrackingRequest,
  CourierProviderWeightDisputeRequest,
  CourierProviderWorkflowAdapter,
  CourierProviderWorkflowContext,
  CourierProviderWorkflowResult
} from "../../providerRegistry/courier-provider-workflow.contracts.js";
import {
  type ShadowfaxSandboxAdapterOptions,
  type ShadowfaxSandboxBlocker,
  type ShadowfaxSandboxLaneCode,
  type ShadowfaxSandboxReadiness,
  shadowfaxSandboxLaneCodes
} from "./shadowfax-sandbox.types.js";

type Db = Parameters<typeof getCourierProviderLaneCredentialReadiness>[2];

function isShadowfaxLaneCode(value: string): value is ShadowfaxSandboxLaneCode {
  return shadowfaxSandboxLaneCodes.includes(value as ShadowfaxSandboxLaneCode);
}

function uniqueBlockers(values: ShadowfaxSandboxBlocker[]) {
  return [...new Set(values)];
}

function laneStatusBlockers(status: string): ShadowfaxSandboxBlocker[] {
  if (status === "DISABLED") return ["COURIER_PROVIDER_LANE_DISABLED"];
  if (status === "SUSPENDED") return ["COURIER_PROVIDER_LANE_SUSPENDED"];
  return [];
}

function publicMessage(readiness: ShadowfaxSandboxReadiness) {
  if (!readiness.blocked) return "Shadowfax sandbox contract is ready for internal dry-run evaluation.";
  if (readiness.blockers.includes("OFFICIAL_DOCS_REQUIRED")) {
    return "Official contracted Shadowfax sandbox documentation is required before this adapter can call external APIs.";
  }
  if (readiness.blockers.includes("SANDBOX_CREDENTIAL_REF_REQUIRED")) {
    return "A safe Shadowfax sandbox credential reference is required before sandbox readiness can proceed.";
  }
  if (readiness.blockers.includes("SHADOWFAX_SANDBOX_MODE_REQUIRED")) {
    return "Shadowfax adapter foundation is sandbox-only and blocks live mode.";
  }
  return "Shadowfax sandbox adapter is blocked by internal readiness gates.";
}

export async function getShadowfaxSandboxReadiness(
  input: {
    merchantId?: string | null;
    laneCode: ShadowfaxSandboxLaneCode;
    mode?: "SANDBOX" | "LIVE";
  },
  dependencies: CourierProviderRegistryDependencies & ShadowfaxSandboxAdapterOptions = {},
  client: Db = prisma
): Promise<ShadowfaxSandboxReadiness> {
  const requestedMode = input.mode ?? "SANDBOX";
  const lane = getCourierProviderLane(input.laneCode).lane;
  const officialDocsAvailable = dependencies.officialDocsAvailable === true;
  const credentialReadiness = await getCourierProviderLaneCredentialReadiness(
    input.merchantId ?? null,
    lane,
    client,
    dependencies,
    "SANDBOX"
  );
  const credentialRefConfigured = credentialReadiness.reference.configured;
  const blockers = uniqueBlockers([
    ...(officialDocsAvailable ? [] : ["OFFICIAL_DOCS_REQUIRED" as const]),
    ...(credentialRefConfigured ? [] : ["SANDBOX_CREDENTIAL_REF_REQUIRED" as const]),
    ...(requestedMode === "SANDBOX" ? [] : ["SHADOWFAX_SANDBOX_MODE_REQUIRED" as const]),
    ...laneStatusBlockers(lane.status)
  ]);
  const readiness: ShadowfaxSandboxReadiness = {
    provider_code: "SHADOWFAX",
    lane_code: input.laneCode,
    requested_mode: requestedMode,
    status: blockers.length ? "BLOCKED" : "READY_FOR_CONTRACTED_SANDBOX",
    blocked: blockers.length > 0,
    blockers,
    official_docs_available: officialDocsAvailable,
    sandbox_credential_ref_configured: credentialRefConfigured,
    external_call_enabled: false,
    credential_reference_state: {
      configured: credentialReadiness.reference.configured,
      ref_type: credentialReadiness.reference.ref_type,
      display_label: credentialReadiness.reference.display_label
    },
    safe_message: ""
  };
  return {
    ...readiness,
    safe_message: publicMessage(readiness)
  };
}

function blockedWorkflowResult(
  input: {
    capability: CourierProviderCapability;
    laneCode: ShadowfaxSandboxLaneCode;
    mode: "SANDBOX" | "LIVE";
    readiness: ShadowfaxSandboxReadiness;
    capabilitySupported: boolean;
  }
): CourierProviderWorkflowResult {
  const blockers = uniqueBlockers([
    ...(input.capabilitySupported ? [] : ["COURIER_PROVIDER_CAPABILITY_UNSUPPORTED" as const]),
    ...input.readiness.blockers,
    "EXTERNAL_CALL_DISABLED"
  ]);
  return {
    capability: input.capability,
    mode: input.mode,
    lane_code: input.laneCode,
    safe_status: "BLOCKED",
    safe_data: {
      provider_code: "SHADOWFAX",
      lane_code: input.laneCode,
      readiness_status: input.readiness.status,
      official_docs_available: input.readiness.official_docs_available,
      sandbox_credential_ref_configured: input.readiness.sandbox_credential_ref_configured,
      external_call_enabled: false,
      blockers,
      next_actions: [
        "Add official contracted Shadowfax sandbox documentation before mapping any API request.",
        "Configure safe sandbox credential references through existing credential readiness foundations."
      ]
    },
    warnings: [
      "Shadowfax adapter is a blocked sandbox shell.",
      "No external courier/provider call was made."
    ],
    provider_raw_response_stored: false,
    provider_headers_stored: false,
    credential_values_exposed: false
  };
}

export class ShadowfaxSandboxWorkflowAdapter implements CourierProviderWorkflowAdapter {
  readonly laneCode: ShadowfaxSandboxLaneCode;
  private readonly dependencies: CourierProviderRegistryDependencies & ShadowfaxSandboxAdapterOptions;
  private readonly client: Db;

  constructor(
    laneCode: ShadowfaxSandboxLaneCode,
    dependencies: CourierProviderRegistryDependencies & ShadowfaxSandboxAdapterOptions = {},
    client: Db = prisma
  ) {
    if (!isShadowfaxLaneCode(laneCode)) {
      throw new Error("SHADOWFAX_LANE_UNSUPPORTED");
    }
    this.laneCode = laneCode;
    this.dependencies = dependencies;
    this.client = client;
  }

  private async blocked(capability: CourierProviderCapability, context: CourierProviderWorkflowContext) {
    const lane = getCourierProviderLane(this.laneCode).lane;
    const mode = context.requestedMode;
    const readiness = await getShadowfaxSandboxReadiness({
      merchantId: context.merchantId,
      laneCode: this.laneCode,
      mode
    }, this.dependencies, this.client);
    return blockedWorkflowResult({
      capability,
      laneCode: this.laneCode,
      mode,
      readiness,
      capabilitySupported: providerLaneSupportsCapability(lane, capability)
    });
  }

  calculateRates(input: CourierProviderRateRequest): Promise<CourierProviderWorkflowResult> {
    return this.blocked("RATE", input);
  }

  createAwb(input: CourierProviderAwbRequest): Promise<CourierProviderWorkflowResult> {
    return this.blocked("AWB", input);
  }

  fetchLabel(input: CourierProviderLabelRequest): Promise<CourierProviderWorkflowResult> {
    return this.blocked("LABEL", input);
  }

  cancelShipment(input: CourierProviderCancelRequest): Promise<CourierProviderWorkflowResult> {
    return this.blocked("CANCEL", input);
  }

  requestPickup(input: CourierProviderPickupRequest): Promise<CourierProviderWorkflowResult> {
    return this.blocked("PICKUP", input);
  }

  async trackShipment(input: CourierProviderTrackingRequest): Promise<CourierProviderWorkflowResult<{
    status: CourierProviderInternalShipmentStatus;
    public_message: string;
  }>> {
    const result = await this.blocked("TRACKING", input);
    return {
      ...result,
      safe_data: {
        ...result.safe_data,
        status: "EXCEPTION",
        public_message: "Tracking is blocked until official Shadowfax sandbox documentation is configured."
      }
    };
  }

  mapRawStatus(input: CourierProviderStatusMappingRequest): CourierProviderInternalShipmentStatus {
    if (input.laneCode !== this.laneCode) return "EXCEPTION";
    return normalizeProviderShipmentStatus(input.rawStatus);
  }

  submitNdrAction(input: CourierProviderNdrRequest): Promise<CourierProviderWorkflowResult> {
    return this.blocked("NDR", input);
  }

  submitWeightDispute(input: CourierProviderWeightDisputeRequest): Promise<CourierProviderWorkflowResult> {
    return this.blocked("WEIGHT_DISPUTE", input);
  }

  reconcileCodRemittance(input: CourierProviderCodRemittanceRequest): Promise<CourierProviderWorkflowResult> {
    return this.blocked("COD_REMITTANCE", input);
  }
}

export function createShadowfaxSandboxAdapter(
  laneCode: ShadowfaxSandboxLaneCode,
  dependencies: CourierProviderRegistryDependencies & ShadowfaxSandboxAdapterOptions = {},
  client: Db = prisma
) {
  return new ShadowfaxSandboxWorkflowAdapter(laneCode, dependencies, client);
}
