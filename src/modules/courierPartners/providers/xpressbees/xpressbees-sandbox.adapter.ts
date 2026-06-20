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
  type XpressbeesSandboxAdapterOptions,
  type XpressbeesSandboxBlocker,
  type XpressbeesSandboxLaneCode,
  type XpressbeesSandboxReadiness,
  xpressbeesSandboxLaneCodes
} from "./xpressbees-sandbox.types.js";

type Db = Parameters<typeof getCourierProviderLaneCredentialReadiness>[2];

function isXpressbeesLaneCode(value: string): value is XpressbeesSandboxLaneCode {
  return xpressbeesSandboxLaneCodes.includes(value as XpressbeesSandboxLaneCode);
}

function uniqueBlockers(values: XpressbeesSandboxBlocker[]) {
  return [...new Set(values)];
}

function laneStatusBlockers(status: string): XpressbeesSandboxBlocker[] {
  if (status === "DISABLED") return ["COURIER_PROVIDER_LANE_DISABLED"];
  if (status === "SUSPENDED") return ["COURIER_PROVIDER_LANE_SUSPENDED"];
  return [];
}

function publicMessage(readiness: XpressbeesSandboxReadiness) {
  if (!readiness.blocked) return "Xpressbees sandbox contract is ready for internal dry-run evaluation.";
  if (readiness.blockers.includes("OFFICIAL_DOCS_REQUIRED")) {
    return "Official contracted Xpressbees sandbox documentation is required before this adapter can call external APIs.";
  }
  if (readiness.blockers.includes("SANDBOX_CREDENTIAL_REF_REQUIRED")) {
    return "A safe Xpressbees sandbox credential reference is required before sandbox readiness can proceed.";
  }
  if (readiness.blockers.includes("XPRESSBEES_SANDBOX_MODE_REQUIRED")) {
    return "Xpressbees adapter foundation is sandbox-only and blocks live mode.";
  }
  return "Xpressbees sandbox adapter is blocked by internal readiness gates.";
}

export async function getXpressbeesSandboxReadiness(
  input: {
    merchantId?: string | null;
    laneCode: XpressbeesSandboxLaneCode;
    mode?: "SANDBOX" | "LIVE";
  },
  dependencies: CourierProviderRegistryDependencies & XpressbeesSandboxAdapterOptions = {},
  client: Db = prisma
): Promise<XpressbeesSandboxReadiness> {
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
    ...(requestedMode === "SANDBOX" ? [] : ["XPRESSBEES_SANDBOX_MODE_REQUIRED" as const]),
    ...laneStatusBlockers(lane.status)
  ]);
  const readiness: XpressbeesSandboxReadiness = {
    provider_code: "XPRESSBEES",
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
    laneCode: XpressbeesSandboxLaneCode;
    mode: "SANDBOX" | "LIVE";
    readiness: XpressbeesSandboxReadiness;
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
      provider_code: "XPRESSBEES",
      lane_code: input.laneCode,
      readiness_status: input.readiness.status,
      official_docs_available: input.readiness.official_docs_available,
      sandbox_credential_ref_configured: input.readiness.sandbox_credential_ref_configured,
      external_call_enabled: false,
      blockers,
      next_actions: [
        "Add official contracted Xpressbees sandbox documentation before mapping any API request.",
        "Configure safe sandbox credential references through existing credential readiness foundations."
      ]
    },
    warnings: [
      "Xpressbees adapter is a blocked sandbox shell.",
      "No external courier/provider call was made."
    ],
    provider_raw_response_stored: false,
    provider_headers_stored: false,
    credential_values_exposed: false
  };
}

export class XpressbeesSandboxWorkflowAdapter implements CourierProviderWorkflowAdapter {
  readonly laneCode: XpressbeesSandboxLaneCode;
  private readonly dependencies: CourierProviderRegistryDependencies & XpressbeesSandboxAdapterOptions;
  private readonly client: Db;

  constructor(
    laneCode: XpressbeesSandboxLaneCode,
    dependencies: CourierProviderRegistryDependencies & XpressbeesSandboxAdapterOptions = {},
    client: Db = prisma
  ) {
    if (!isXpressbeesLaneCode(laneCode)) {
      throw new Error("XPRESSBEES_LANE_UNSUPPORTED");
    }
    this.laneCode = laneCode;
    this.dependencies = dependencies;
    this.client = client;
  }

  private async blocked(capability: CourierProviderCapability, context: CourierProviderWorkflowContext) {
    const lane = getCourierProviderLane(this.laneCode).lane;
    const mode = context.requestedMode;
    const readiness = await getXpressbeesSandboxReadiness({
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
        public_message: "Tracking is blocked until official Xpressbees sandbox documentation is configured."
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

export function createXpressbeesSandboxAdapter(
  laneCode: XpressbeesSandboxLaneCode,
  dependencies: CourierProviderRegistryDependencies & XpressbeesSandboxAdapterOptions = {},
  client: Db = prisma
) {
  return new XpressbeesSandboxWorkflowAdapter(laneCode, dependencies, client);
}
