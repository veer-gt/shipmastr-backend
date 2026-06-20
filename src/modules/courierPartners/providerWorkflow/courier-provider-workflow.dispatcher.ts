import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import {
  getCourierProviderLaneCredentialReadiness
} from "../providerRegistry/courier-provider-registry.service.js";
import {
  courierProviderPublicOutcomes,
  getCourierProviderLaneDefinition,
  isProviderLaneCode,
  providerLaneSupportsCapability
} from "../providerRegistry/courier-provider-registry.rules.js";
import type {
  CourierProviderCapability,
  CourierProviderLaneCode,
  CourierProviderLaneDefinition,
  CourierProviderRuntimeMode,
  CourierProviderRegistryDependencies
} from "../providerRegistry/courier-provider-registry.types.js";
import type {
  CourierProviderAwbRequest,
  CourierProviderCancelRequest,
  CourierProviderCodRemittanceRequest,
  CourierProviderLabelRequest,
  CourierProviderNdrRequest,
  CourierProviderPickupRequest,
  CourierProviderRateRequest,
  CourierProviderTrackingRequest,
  CourierProviderWeightDisputeRequest,
  CourierProviderWorkflowAdapter,
  CourierProviderWorkflowResult
} from "../providerRegistry/courier-provider-workflow.contracts.js";
import { createDelhiverySandboxAdapter } from "../providers/delhivery/delhivery-sandbox.adapter.js";
import { createEkartSandboxAdapter } from "../providers/ekart/ekart-sandbox.adapter.js";
import { createShadowfaxSandboxAdapter } from "../providers/shadowfax/shadowfax-sandbox.adapter.js";
import { createXpressbeesSandboxAdapter } from "../providers/xpressbees/xpressbees-sandbox.adapter.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type CourierProviderWorkflowOperation =
  | "RATE"
  | "AWB"
  | "LABEL"
  | "CANCEL"
  | "PICKUP"
  | "TRACKING"
  | "NDR"
  | "WEIGHT_DISPUTE"
  | "COD_REMITTANCE";

export type CourierProviderWorkflowDispatchInput =
  | { operation: "RATE"; request: CourierProviderRateRequest }
  | { operation: "AWB"; request: CourierProviderAwbRequest }
  | { operation: "LABEL"; request: CourierProviderLabelRequest }
  | { operation: "CANCEL"; request: CourierProviderCancelRequest }
  | { operation: "PICKUP"; request: CourierProviderPickupRequest }
  | { operation: "TRACKING"; request: CourierProviderTrackingRequest }
  | { operation: "NDR"; request: CourierProviderNdrRequest }
  | { operation: "WEIGHT_DISPUTE"; request: CourierProviderWeightDisputeRequest }
  | { operation: "COD_REMITTANCE"; request: CourierProviderCodRemittanceRequest };

export type CourierProviderWorkflowDispatchStatus =
  | "BLOCKED"
  | "UNSUPPORTED"
  | "DISPATCHED";

export type CourierProviderWorkflowDispatchResult = {
  operation: CourierProviderWorkflowOperation;
  lane_code: CourierProviderLaneCode | string;
  capability: CourierProviderCapability;
  requested_mode: CourierProviderRuntimeMode;
  status: CourierProviderWorkflowDispatchStatus;
  safe_status: "BLOCKED" | "UNSUPPORTED" | "STAGED" | "READY" | "FAILED" | "DRY_RUN";
  blocked: boolean;
  blockers: string[];
  warnings: string[];
  adapter_result: CourierProviderWorkflowResult | null;
  public_network_name: "Shipmastr Courier Network";
  public_outcomes: typeof courierProviderPublicOutcomes;
  provider_raw_response_stored: false;
  provider_headers_stored: false;
  credential_values_exposed: false;
  admin_diagnostics: {
    lane_code: CourierProviderLaneCode | string;
    provider_code: string | null;
    capability: CourierProviderCapability;
    requested_mode: CourierProviderRuntimeMode;
    lane_status: string | null;
    credential_status: string | null;
    credential_reference_configured: boolean | null;
    adapter_wired: boolean;
    adapter_result_status: string | null;
    blockers: string[];
    next_actions: string[];
  };
};

export type CourierProviderWorkflowDispatcherDependencies = CourierProviderRegistryDependencies & {
  adapterFactory?: (
    lane: CourierProviderLaneDefinition,
    dependencies: CourierProviderWorkflowDispatcherDependencies,
    client: Db
  ) => CourierProviderWorkflowAdapter | null;
  liveOneShotApproved?: boolean;
};

const operationToCapability: Record<CourierProviderWorkflowOperation, CourierProviderCapability> = {
  RATE: "RATE",
  AWB: "AWB",
  LABEL: "LABEL",
  CANCEL: "CANCEL",
  PICKUP: "PICKUP",
  TRACKING: "TRACKING",
  NDR: "NDR",
  WEIGHT_DISPUTE: "WEIGHT_DISPUTE",
  COD_REMITTANCE: "COD_REMITTANCE"
};

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))];
}

function laneStatusBlockers(lane: CourierProviderLaneDefinition, requestedMode: CourierProviderRuntimeMode) {
  if (lane.status === "DISABLED") return ["COURIER_PROVIDER_LANE_DISABLED"];
  if (lane.status === "SUSPENDED") return ["COURIER_PROVIDER_LANE_SUSPENDED"];
  if (lane.status === "TESTING" && requestedMode === "LIVE") return ["COURIER_PROVIDER_LANE_TESTING_ONLY"];
  return [];
}

function modeBlockers(lane: CourierProviderLaneDefinition, requestedMode: CourierProviderRuntimeMode) {
  if (requestedMode === "LIVE" && lane.mode !== "LIVE") return ["COURIER_PROVIDER_LANE_LIVE_DISABLED"];
  return [];
}

function nextActionsForBlockers(blockers: readonly string[]) {
  const actions = new Set<string>();
  for (const blocker of blockers) {
    if (blocker.includes("UNKNOWN") || blocker.includes("NOT_FOUND")) {
      actions.add("Choose a configured Shipmastr courier provider lane.");
    }
    if (blocker.includes("UNSUPPORTED")) {
      actions.add("Choose a supported Shipmastr shipping capability.");
    }
    if (blocker.includes("CREDENTIAL") || blocker.includes("SANDBOX_CREDENTIAL")) {
      actions.add("Configure and test safe credential references before running this workflow.");
    }
    if (blocker.includes("SUSPENDED") || blocker.includes("DISABLED") || blocker.includes("TESTING_ONLY")) {
      actions.add("Review lane status and approvals before enabling this workflow.");
    }
    if (blocker.includes("LIVE_GUARD") || blocker.includes("LIVE_DISABLED")) {
      actions.add("Keep live mode blocked until an explicit one-shot approval and live readiness gate pass.");
    }
    if (blocker.includes("ADAPTER_NOT_WIRED")) {
      actions.add("Wire an official guarded adapter before dispatching this workflow.");
    }
    if (blocker.includes("OFFICIAL_DOCS")) {
      actions.add("Add official contracted API documentation before enabling external calls.");
    }
    if (blocker.includes("EXTERNAL_CALL_DISABLED")) {
      actions.add("Keep the workflow in guarded dry-run until external calls are explicitly approved.");
    }
  }
  return [...actions];
}

function blockedResult(input: {
  operation: CourierProviderWorkflowOperation;
  laneCode: CourierProviderLaneCode | string;
  capability: CourierProviderCapability;
  requestedMode: CourierProviderRuntimeMode;
  blockers: string[];
  lane?: CourierProviderLaneDefinition | null;
  credentialStatus?: string | null;
  credentialReferenceConfigured?: boolean | null;
  adapterWired?: boolean;
  adapterResult?: CourierProviderWorkflowResult | null;
  status?: CourierProviderWorkflowDispatchStatus;
}) {
  const blockers = uniqueStrings(input.blockers);
  return {
    operation: input.operation,
    lane_code: input.laneCode,
    capability: input.capability,
    requested_mode: input.requestedMode,
    status: input.status ?? "BLOCKED",
    safe_status: input.status === "UNSUPPORTED" ? "UNSUPPORTED" : "BLOCKED",
    blocked: true,
    blockers,
    warnings: ["No external courier/provider call was made."],
    adapter_result: input.adapterResult ?? null,
    public_network_name: "Shipmastr Courier Network" as const,
    public_outcomes: courierProviderPublicOutcomes,
    provider_raw_response_stored: false as const,
    provider_headers_stored: false as const,
    credential_values_exposed: false as const,
    admin_diagnostics: {
      lane_code: input.laneCode,
      provider_code: input.lane?.providerCode ?? null,
      capability: input.capability,
      requested_mode: input.requestedMode,
      lane_status: input.lane?.status ?? null,
      credential_status: input.credentialStatus ?? null,
      credential_reference_configured: input.credentialReferenceConfigured ?? null,
      adapter_wired: input.adapterWired ?? false,
      adapter_result_status: input.adapterResult?.safe_status ?? null,
      blockers,
      next_actions: nextActionsForBlockers(blockers)
    }
  } satisfies CourierProviderWorkflowDispatchResult;
}

function defaultAdapterFactory(
  lane: CourierProviderLaneDefinition,
  dependencies: CourierProviderWorkflowDispatcherDependencies,
  client: Db
) {
  if (lane.code === "DELHIVERY_B2C_AIR" || lane.code === "DELHIVERY_B2C_SURFACE") {
    return createDelhiverySandboxAdapter(lane.code, dependencies, client);
  }
  if (lane.code === "XPRESSBEES_AIR" || lane.code === "XPRESSBEES_SURFACE") {
    return createXpressbeesSandboxAdapter(lane.code, dependencies, client);
  }
  if (lane.code === "SHADOWFAX") return createShadowfaxSandboxAdapter(lane.code, dependencies, client);
  if (lane.code === "EKART") return createEkartSandboxAdapter(lane.code, dependencies, client);
  return null;
}

async function callAdapter(
  adapter: CourierProviderWorkflowAdapter,
  input: CourierProviderWorkflowDispatchInput
) {
  if (input.operation === "RATE") return adapter.calculateRates(input.request);
  if (input.operation === "AWB") return adapter.createAwb(input.request);
  if (input.operation === "LABEL") return adapter.fetchLabel(input.request);
  if (input.operation === "CANCEL") return adapter.cancelShipment(input.request);
  if (input.operation === "PICKUP") return adapter.requestPickup(input.request);
  if (input.operation === "TRACKING") return adapter.trackShipment(input.request);
  if (input.operation === "NDR") return adapter.submitNdrAction(input.request);
  if (input.operation === "WEIGHT_DISPUTE") return adapter.submitWeightDispute(input.request);
  return adapter.reconcileCodRemittance(input.request);
}

export async function dispatchCourierProviderWorkflow(
  input: CourierProviderWorkflowDispatchInput,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
): Promise<CourierProviderWorkflowDispatchResult> {
  const capability = operationToCapability[input.operation];
  const requestedMode = input.request.requestedMode;
  const laneCode = input.request.laneCode;

  if (!isProviderLaneCode(laneCode)) {
    return blockedResult({
      operation: input.operation,
      laneCode,
      capability,
      requestedMode,
      blockers: ["COURIER_PROVIDER_LANE_NOT_FOUND"]
    });
  }

  const lane = getCourierProviderLaneDefinition(laneCode);
  if (!lane) {
    return blockedResult({
      operation: input.operation,
      laneCode,
      capability,
      requestedMode,
      blockers: ["COURIER_PROVIDER_LANE_NOT_FOUND"]
    });
  }

  const supported = providerLaneSupportsCapability(lane, capability);
  if (!supported) {
    return blockedResult({
      operation: input.operation,
      laneCode,
      capability,
      requestedMode,
      lane,
      blockers: ["COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"],
      status: "UNSUPPORTED"
    });
  }

  const credentialReadiness = await getCourierProviderLaneCredentialReadiness(
    input.request.merchantId,
    lane,
    client,
    dependencies,
    requestedMode
  );
  const credentialReady = requestedMode === "LIVE"
    ? credentialReadiness.status === "READY"
    : credentialReadiness.reference.configured;
  const gateBlockers = uniqueStrings([
    ...laneStatusBlockers(lane, requestedMode),
    ...modeBlockers(lane, requestedMode),
    ...(credentialReady ? [] : [
      requestedMode === "SANDBOX" ? "SANDBOX_CREDENTIAL_REF_REQUIRED" : "COURIER_PROVIDER_CREDENTIALS_NOT_READY"
    ]),
    ...credentialReadiness.blockers,
    ...(requestedMode === "LIVE" && dependencies.liveOneShotApproved !== true
      ? ["PROVIDER_WORKFLOW_LIVE_GUARD_REQUIRED"]
      : [])
  ]);

  if (gateBlockers.length) {
    return blockedResult({
      operation: input.operation,
      laneCode,
      capability,
      requestedMode,
      lane,
      blockers: gateBlockers,
      credentialStatus: credentialReadiness.status,
      credentialReferenceConfigured: credentialReadiness.reference.configured
    });
  }

  const adapter = (dependencies.adapterFactory ?? defaultAdapterFactory)(lane, dependencies, client);
  if (!adapter) {
    return blockedResult({
      operation: input.operation,
      laneCode,
      capability,
      requestedMode,
      lane,
      blockers: ["PROVIDER_WORKFLOW_ADAPTER_NOT_WIRED"],
      credentialStatus: credentialReadiness.status,
      credentialReferenceConfigured: credentialReadiness.reference.configured
    });
  }

  const adapterResult = await callAdapter(adapter, input);
  const safeData = adapterResult.safe_data as Record<string, unknown>;
  const adapterBlockers = Array.isArray(safeData.blockers)
    ? safeData.blockers.filter((value): value is string => typeof value === "string")
    : [];
  const blockers = uniqueStrings([...adapterBlockers]);
  const blocked = adapterResult.safe_status === "BLOCKED" || adapterResult.safe_status === "FAILED" || blockers.length > 0;

  return {
    operation: input.operation,
    lane_code: laneCode,
    capability,
    requested_mode: requestedMode,
    status: blocked ? "BLOCKED" : "DISPATCHED",
    safe_status: adapterResult.safe_status,
    blocked,
    blockers,
    warnings: uniqueStrings([
      ...adapterResult.warnings,
      "No real courier/provider call is enabled by the dispatcher."
    ]),
    adapter_result: adapterResult,
    public_network_name: "Shipmastr Courier Network",
    public_outcomes: courierProviderPublicOutcomes,
    provider_raw_response_stored: false,
    provider_headers_stored: false,
    credential_values_exposed: false,
    admin_diagnostics: {
      lane_code: laneCode,
      provider_code: lane.providerCode,
      capability,
      requested_mode: requestedMode,
      lane_status: lane.status,
      credential_status: credentialReadiness.status,
      credential_reference_configured: credentialReadiness.reference.configured,
      adapter_wired: true,
      adapter_result_status: adapterResult.safe_status,
      blockers,
      next_actions: nextActionsForBlockers(blockers)
    }
  };
}

export function dispatchCourierProviderRate(
  request: CourierProviderRateRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "RATE", request }, dependencies, client);
}

export function dispatchCourierProviderAwb(
  request: CourierProviderAwbRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "AWB", request }, dependencies, client);
}

export function dispatchCourierProviderLabel(
  request: CourierProviderLabelRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "LABEL", request }, dependencies, client);
}

export function dispatchCourierProviderPickup(
  request: CourierProviderPickupRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "PICKUP", request }, dependencies, client);
}
