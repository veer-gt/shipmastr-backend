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
  CourierProviderCodPayoutActionRequest,
  CourierProviderCodRemittanceReadRequest,
  CourierProviderCodRemittanceReconciliationRequest,
  CourierProviderCodRemittanceRequest,
  CourierProviderCourierImageMetadataRequest,
  CourierProviderLabelRequest,
  CourierProviderNdrContactUpdateRequest,
  CourierProviderNdrPreviewRequest,
  CourierProviderNdrRequest,
  CourierProviderPickupRequest,
  CourierProviderRateRequest,
  CourierProviderTrackingRequest,
  CourierProviderWeightDiscrepancyAcceptRequest,
  CourierProviderWeightDiscrepancyHistoryRequest,
  CourierProviderWeightDiscrepancyReadRequest,
  CourierProviderWeightDiscrepancyRemarkRequest,
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
  | "NDR_PREVIEW"
  | "NDR_CONTACT_UPDATE"
  | "WEIGHT_DISPUTE"
  | "WEIGHT_DISCREPANCY_READ"
  | "WEIGHT_DISCREPANCY_HISTORY"
  | "WEIGHT_DISCREPANCY_REMARK"
  | "WEIGHT_DISCREPANCY_ACCEPT"
  | "COURIER_IMAGE_METADATA"
  | "COD_REMITTANCE"
  | "COD_REMITTANCE_READ"
  | "COD_REMITTANCE_RECONCILIATION"
  | "COD_PAYOUT_ACTION";

export type CourierProviderWorkflowDispatchInput =
  | { operation: "RATE"; request: CourierProviderRateRequest }
  | { operation: "AWB"; request: CourierProviderAwbRequest }
  | { operation: "LABEL"; request: CourierProviderLabelRequest }
  | { operation: "CANCEL"; request: CourierProviderCancelRequest }
  | { operation: "PICKUP"; request: CourierProviderPickupRequest }
  | { operation: "TRACKING"; request: CourierProviderTrackingRequest }
  | { operation: "NDR"; request: CourierProviderNdrRequest }
  | { operation: "NDR_PREVIEW"; request: CourierProviderNdrPreviewRequest }
  | { operation: "NDR_CONTACT_UPDATE"; request: CourierProviderNdrContactUpdateRequest }
  | { operation: "WEIGHT_DISPUTE"; request: CourierProviderWeightDisputeRequest }
  | { operation: "WEIGHT_DISCREPANCY_READ"; request: CourierProviderWeightDiscrepancyReadRequest }
  | { operation: "WEIGHT_DISCREPANCY_HISTORY"; request: CourierProviderWeightDiscrepancyHistoryRequest }
  | { operation: "WEIGHT_DISCREPANCY_REMARK"; request: CourierProviderWeightDiscrepancyRemarkRequest }
  | { operation: "WEIGHT_DISCREPANCY_ACCEPT"; request: CourierProviderWeightDiscrepancyAcceptRequest }
  | { operation: "COURIER_IMAGE_METADATA"; request: CourierProviderCourierImageMetadataRequest }
  | { operation: "COD_REMITTANCE"; request: CourierProviderCodRemittanceRequest }
  | { operation: "COD_REMITTANCE_READ"; request: CourierProviderCodRemittanceReadRequest }
  | { operation: "COD_REMITTANCE_RECONCILIATION"; request: CourierProviderCodRemittanceReconciliationRequest }
  | { operation: "COD_PAYOUT_ACTION"; request: CourierProviderCodPayoutActionRequest };

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
  contract_data: Record<string, unknown> | null;
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
  NDR_PREVIEW: "NDR",
  NDR_CONTACT_UPDATE: "NDR",
  WEIGHT_DISPUTE: "WEIGHT_DISPUTE",
  WEIGHT_DISCREPANCY_READ: "WEIGHT_DISPUTE",
  WEIGHT_DISCREPANCY_HISTORY: "WEIGHT_DISPUTE",
  WEIGHT_DISCREPANCY_REMARK: "WEIGHT_DISPUTE",
  WEIGHT_DISCREPANCY_ACCEPT: "WEIGHT_DISPUTE",
  COURIER_IMAGE_METADATA: "WEIGHT_DISPUTE",
  COD_REMITTANCE: "COD_REMITTANCE",
  COD_REMITTANCE_READ: "COD_REMITTANCE",
  COD_REMITTANCE_RECONCILIATION: "COD_REMITTANCE",
  COD_PAYOUT_ACTION: "COD_REMITTANCE"
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
  contractData?: Record<string, unknown> | null;
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
    contract_data: input.contractData ?? null,
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

function stagedContractResult(input: {
  operation: CourierProviderWorkflowOperation;
  lane: CourierProviderLaneDefinition;
  capability: CourierProviderCapability;
  requestedMode: CourierProviderRuntimeMode;
  credentialStatus: string | null;
  credentialReferenceConfigured: boolean | null;
  contractData: Record<string, unknown>;
  warnings?: string[];
}) {
  return {
    operation: input.operation,
    lane_code: input.lane.code,
    capability: input.capability,
    requested_mode: input.requestedMode,
    status: "DISPATCHED" as const,
    safe_status: "STAGED" as const,
    blocked: false,
    blockers: [],
    warnings: uniqueStrings([
      ...(input.warnings ?? []),
      "No external courier/provider call was made.",
      "This is a guarded workflow contract only."
    ]),
    adapter_result: null,
    contract_data: input.contractData,
    public_network_name: "Shipmastr Courier Network" as const,
    public_outcomes: courierProviderPublicOutcomes,
    provider_raw_response_stored: false as const,
    provider_headers_stored: false as const,
    credential_values_exposed: false as const,
    admin_diagnostics: {
      lane_code: input.lane.code,
      provider_code: input.lane.providerCode,
      capability: input.capability,
      requested_mode: input.requestedMode,
      lane_status: input.lane.status,
      credential_status: input.credentialStatus,
      credential_reference_configured: input.credentialReferenceConfigured,
      adapter_wired: false,
      adapter_result_status: null,
      blockers: [],
      next_actions: []
    }
  } satisfies CourierProviderWorkflowDispatchResult;
}

function safeLast4(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.slice(-4);
}

function ndrPreviewData(request: CourierProviderNdrPreviewRequest) {
  return {
    contract: "NDR_ACTION_PREVIEW",
    ndr_case_id_configured: Boolean(request.ndrCaseId),
    action: request.action,
    reattempt_date_configured: Boolean(request.reattemptDate),
    safe_reason_code: request.safeReasonCode ?? null,
    phone_last4: safeLast4(request.phoneLast4),
    address_quality_signal: request.addressQualitySignal ?? "UNKNOWN",
    provider_mutation_enabled: false,
    payload_summary: {
      awb_configured: Boolean(request.awbNumber),
      safe_remarks_configured: Boolean(request.safeRemarks),
      no_full_phone_or_address: true
    }
  };
}

function ndrContactUpdateData(request: CourierProviderNdrContactUpdateRequest) {
  return {
    contract: "NDR_CONTACT_UPDATE",
    action: request.action,
    phone_last4: safeLast4(request.phoneLast4),
    address_update_summary_configured: Boolean(request.addressUpdateSummary),
    provider_mutation_enabled: false,
    no_full_phone_or_address: true
  };
}

function weightDiscrepancyData(
  operation: CourierProviderWorkflowOperation,
  request:
    | CourierProviderWeightDiscrepancyReadRequest
    | CourierProviderWeightDiscrepancyHistoryRequest
    | CourierProviderWeightDiscrepancyRemarkRequest
    | CourierProviderWeightDiscrepancyAcceptRequest
    | CourierProviderCourierImageMetadataRequest
) {
  const maybeWeight = request as Partial<CourierProviderWeightDisputeRequest>;
  const maybeImage = request as CourierProviderCourierImageMetadataRequest;
  return {
    contract: operation,
    discrepancy_case_id_configured: Boolean((request as CourierProviderWeightDiscrepancyReadRequest).discrepancyCaseId),
    awb_configured: Boolean((request as CourierProviderWeightDiscrepancyReadRequest).awbNumber),
    charged_weight_kg: typeof maybeWeight.chargedWeightKg === "number" ? maybeWeight.chargedWeightKg : null,
    expected_weight_kg: typeof maybeWeight.expectedWeightKg === "number" ? maybeWeight.expectedWeightKg : null,
    safe_evidence_ref_count: Array.isArray(maybeWeight.safeEvidenceRefs) ? maybeWeight.safeEvidenceRefs.length : 0,
    safe_remark_configured: Boolean((request as CourierProviderWeightDiscrepancyRemarkRequest).safeRemark),
    acceptance_reason_configured: Boolean((request as CourierProviderWeightDiscrepancyAcceptRequest).acceptanceReason),
    image_metadata_only: operation === "COURIER_IMAGE_METADATA",
    fixture_only: operation === "COURIER_IMAGE_METADATA" ? maybeImage.fixtureOnly !== false : null,
    image_content_type: operation === "COURIER_IMAGE_METADATA" ? maybeImage.metadata?.contentType ?? null : null,
    image_byte_size: operation === "COURIER_IMAGE_METADATA" ? maybeImage.metadata?.byteSize ?? null : null,
    provider_mutation_enabled: false
  };
}

function codRemittanceData(
  operation: CourierProviderWorkflowOperation,
  request: CourierProviderCodRemittanceReadRequest | CourierProviderCodRemittanceReconciliationRequest | CourierProviderCodPayoutActionRequest
) {
  return {
    contract: operation,
    remittance_reference_configured: Boolean(request.remittanceReference),
    reconciliation_reference_configured: Boolean((request as CourierProviderCodRemittanceReadRequest).reconciliationReference),
    amount_paise_configured: typeof request.amountPaise === "number",
    safe_period_label_configured: Boolean(request.safePeriodLabel),
    provider_amount_paise_configured: typeof (request as CourierProviderCodRemittanceReconciliationRequest).providerAmountPaise === "number",
    ledger_source_of_truth: "SHIPMASTR_WALLET_LEDGER",
    wallet_ledger_overwrite_enabled: false,
    payout_action: (request as CourierProviderCodPayoutActionRequest).payoutAction ?? null,
    provider_mutation_enabled: false
  };
}

function guardedContractResult(input: {
  operation: CourierProviderWorkflowOperation;
  request: CourierProviderWorkflowDispatchInput["request"];
  lane: CourierProviderLaneDefinition;
  capability: CourierProviderCapability;
  requestedMode: CourierProviderRuntimeMode;
  credentialStatus: string | null;
  credentialReferenceConfigured: boolean | null;
}): CourierProviderWorkflowDispatchResult | null {
  switch (input.operation) {
    case "NDR_PREVIEW":
      return stagedContractResult({
        operation: input.operation,
        lane: input.lane,
        capability: input.capability,
        requestedMode: input.requestedMode,
        credentialStatus: input.credentialStatus,
        credentialReferenceConfigured: input.credentialReferenceConfigured,
        contractData: ndrPreviewData(input.request as CourierProviderNdrPreviewRequest)
      });
    case "NDR_CONTACT_UPDATE":
      return blockedResult({
        operation: input.operation,
        laneCode: input.lane.code,
        capability: input.capability,
        requestedMode: input.requestedMode,
        lane: input.lane,
        blockers: ["PROVIDER_NDR_CONTACT_UPDATE_BLOCKED", "EXTERNAL_CALL_DISABLED"],
        credentialStatus: input.credentialStatus,
        credentialReferenceConfigured: input.credentialReferenceConfigured,
        contractData: ndrContactUpdateData(input.request as CourierProviderNdrContactUpdateRequest)
      });
    case "WEIGHT_DISCREPANCY_READ":
    case "WEIGHT_DISCREPANCY_HISTORY":
    case "COURIER_IMAGE_METADATA":
      return stagedContractResult({
        operation: input.operation,
        lane: input.lane,
        capability: input.capability,
        requestedMode: input.requestedMode,
        credentialStatus: input.credentialStatus,
        credentialReferenceConfigured: input.credentialReferenceConfigured,
        contractData: weightDiscrepancyData(input.operation, input.request as never),
        warnings: input.operation === "COURIER_IMAGE_METADATA"
          ? ["Courier images are metadata-only in this phase and use fake fixture references only."]
          : []
      });
    case "WEIGHT_DISCREPANCY_REMARK":
    case "WEIGHT_DISCREPANCY_ACCEPT":
      return blockedResult({
        operation: input.operation,
        laneCode: input.lane.code,
        capability: input.capability,
        requestedMode: input.requestedMode,
        lane: input.lane,
        blockers: ["PROVIDER_WEIGHT_DISCREPANCY_MUTATION_BLOCKED", "EXTERNAL_CALL_DISABLED"],
        credentialStatus: input.credentialStatus,
        credentialReferenceConfigured: input.credentialReferenceConfigured,
        contractData: weightDiscrepancyData(input.operation, input.request as never)
      });
    case "COD_REMITTANCE_READ":
    case "COD_REMITTANCE_RECONCILIATION":
      return stagedContractResult({
        operation: input.operation,
        lane: input.lane,
        capability: input.capability,
        requestedMode: input.requestedMode,
        credentialStatus: input.credentialStatus,
        credentialReferenceConfigured: input.credentialReferenceConfigured,
        contractData: codRemittanceData(input.operation, input.request as never),
        warnings: ["Shipmastr wallet/COD ledger remains the source of truth."]
      });
    case "COD_PAYOUT_ACTION":
      return blockedResult({
        operation: input.operation,
        laneCode: input.lane.code,
        capability: input.capability,
        requestedMode: input.requestedMode,
        lane: input.lane,
        blockers: ["COD_PAYOUT_ACTION_UNSUPPORTED", "PROVIDER_COD_PAYOUT_MUTATION_BLOCKED"],
        credentialStatus: input.credentialStatus,
        credentialReferenceConfigured: input.credentialReferenceConfigured,
        contractData: codRemittanceData(input.operation, input.request as CourierProviderCodPayoutActionRequest),
        status: "UNSUPPORTED"
      });
    default:
      return null;
  }
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
  if (input.operation === "COD_REMITTANCE") return adapter.reconcileCodRemittance(input.request);
  throw new Error(`Unsupported adapter-backed provider workflow operation: ${input.operation}`);
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

  const guardedContract = guardedContractResult({
    operation: input.operation,
    request: input.request,
    lane,
    capability,
    requestedMode,
    credentialStatus: credentialReadiness.status,
    credentialReferenceConfigured: credentialReadiness.reference.configured
  });
  if (guardedContract) return guardedContract;

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
    contract_data: null,
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

export function previewCourierProviderNdrAction(
  request: CourierProviderNdrPreviewRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "NDR_PREVIEW", request }, dependencies, client);
}

export function dispatchCourierProviderNdrSubmit(
  request: CourierProviderNdrRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "NDR", request }, dependencies, client);
}

export function dispatchCourierProviderNdrContactUpdate(
  request: CourierProviderNdrContactUpdateRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "NDR_CONTACT_UPDATE", request }, dependencies, client);
}

export function readCourierProviderWeightDiscrepancy(
  request: CourierProviderWeightDiscrepancyReadRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "WEIGHT_DISCREPANCY_READ", request }, dependencies, client);
}

export function readCourierProviderWeightDiscrepancyHistory(
  request: CourierProviderWeightDiscrepancyHistoryRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "WEIGHT_DISCREPANCY_HISTORY", request }, dependencies, client);
}

export function dispatchCourierProviderWeightDiscrepancyRemark(
  request: CourierProviderWeightDiscrepancyRemarkRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "WEIGHT_DISCREPANCY_REMARK", request }, dependencies, client);
}

export function dispatchCourierProviderWeightDiscrepancyAccept(
  request: CourierProviderWeightDiscrepancyAcceptRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "WEIGHT_DISCREPANCY_ACCEPT", request }, dependencies, client);
}

export function readCourierProviderCourierImageMetadata(
  request: CourierProviderCourierImageMetadataRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "COURIER_IMAGE_METADATA", request }, dependencies, client);
}

export function readCourierProviderCodRemittance(
  request: CourierProviderCodRemittanceReadRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "COD_REMITTANCE_READ", request }, dependencies, client);
}

export function reconcileCourierProviderCodRemittance(
  request: CourierProviderCodRemittanceReconciliationRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "COD_REMITTANCE_RECONCILIATION", request }, dependencies, client);
}

export function dispatchCourierProviderCodPayoutAction(
  request: CourierProviderCodPayoutActionRequest,
  dependencies: CourierProviderWorkflowDispatcherDependencies = {},
  client: Db = prisma
) {
  return dispatchCourierProviderWorkflow({ operation: "COD_PAYOUT_ACTION", request }, dependencies, client);
}
