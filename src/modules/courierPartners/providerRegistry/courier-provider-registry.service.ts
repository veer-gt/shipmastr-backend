import type { Prisma } from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import {
  courierProviderLaneDefinitions,
  courierProviderPublicOutcomes,
  getCourierProviderLaneDefinition,
  normalizeProviderShipmentStatus,
  providerLaneSupportsCapability
} from "./courier-provider-registry.rules.js";
import type {
  CourierProviderCapability,
  CourierProviderInternalShipmentStatus,
  CourierProviderLaneCode,
  CourierProviderLaneCredentialReadiness,
  CourierProviderLaneDefinition,
  CourierProviderRegistryDependencies,
  CourierProviderRegistryListQuery,
  CourierProviderRuntimeMode,
  CourierProviderWorkflowGuardResult
} from "./courier-provider-registry.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

function checkedAt(dependencies: CourierProviderRegistryDependencies) {
  return dependencies.checkedAt ?? new Date().toISOString();
}

function cloneLane(lane: CourierProviderLaneDefinition): CourierProviderLaneDefinition {
  return {
    ...lane,
    taxConfig: { ...lane.taxConfig },
    capabilities: { ...lane.capabilities },
    notes: [...lane.notes]
  };
}

function filterByCapability(lane: CourierProviderLaneDefinition, capability?: CourierProviderCapability) {
  return capability ? providerLaneSupportsCapability(lane, capability) : true;
}

export function listCourierProviderLanes(query: CourierProviderRegistryListQuery = {}) {
  const lanes = courierProviderLaneDefinitions
    .filter((lane) => !query.providerCode || lane.providerCode === query.providerCode)
    .filter((lane) => !query.status || lane.status === query.status)
    .filter((lane) => !query.mode || lane.mode === query.mode)
    .filter((lane) => filterByCapability(lane, query.capability))
    .map(cloneLane);

  return { lanes };
}

export function getCourierProviderLane(code: CourierProviderLaneCode) {
  const lane = getCourierProviderLaneDefinition(code);
  if (!lane) throw new HttpError(404, "COURIER_PROVIDER_LANE_NOT_FOUND");
  return { lane: cloneLane(lane) };
}

export function checkCourierProviderCapability(
  code: CourierProviderLaneCode,
  capability: CourierProviderCapability
) {
  const lane = getCourierProviderLane(code).lane;
  const supported = providerLaneSupportsCapability(lane, capability);
  return {
    lane_code: lane.code,
    capability,
    supported,
    public_network_name: "Shipmastr Courier Network" as const,
    public_outcomes: courierProviderPublicOutcomes,
    blockers: supported ? [] : ["COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"],
    admin_context: {
      provider_code: lane.providerCode,
      lane_type: lane.laneType,
      lane_status: lane.status
    }
  };
}

export async function getCourierProviderLaneCredentialReadiness(
  merchantId: string | null,
  lane: CourierProviderLaneDefinition,
  client: Db = prisma,
  dependencies: CourierProviderRegistryDependencies = {}
): Promise<CourierProviderLaneCredentialReadiness> {
  if (dependencies.credentialReadinessProvider) {
    return dependencies.credentialReadinessProvider(merchantId, lane);
  }

  if (!merchantId) {
    return {
      status: "NOT_CONFIGURED",
      credential_ref_configured: false,
      last_test_status: null,
      checked_at: checkedAt(dependencies),
      blockers: ["COURIER_PROVIDER_MERCHANT_SCOPE_REQUIRED"]
    };
  }

  const record = await client.courierProviderCredential.findFirst({
    where: {
      merchantId,
      providerKey: { in: [lane.code, lane.providerCode] },
      mode: "LIVE"
    },
    orderBy: [
      { lastTestedAt: "desc" },
      { updatedAt: "desc" }
    ]
  });

  if (!record) {
    return {
      status: "NOT_CONFIGURED",
      credential_ref_configured: false,
      last_test_status: null,
      checked_at: checkedAt(dependencies),
      blockers: ["COURIER_PROVIDER_CREDENTIALS_NOT_CONFIGURED"]
    };
  }

  const ready = Boolean(
    record.credentialRef &&
    record.status === "ACTIVE" &&
    record.mode === "LIVE" &&
    record.lastTestStatus === "PASS" &&
    record.lastTestedAt
  );

  if (ready) {
    return {
      status: "READY",
      credential_ref_configured: true,
      last_test_status: record.lastTestStatus,
      checked_at: checkedAt(dependencies),
      blockers: []
    };
  }

  return {
    status: record.credentialRef ? "REFERENCE_CONFIGURED" : "NOT_CONFIGURED",
    credential_ref_configured: Boolean(record.credentialRef),
    last_test_status: record.lastTestStatus,
    checked_at: checkedAt(dependencies),
    blockers: [
      ...(record.credentialRef ? [] : ["COURIER_PROVIDER_CREDENTIALS_NOT_CONFIGURED"]),
      ...(record.lastTestStatus === "PASS" ? [] : ["COURIER_PROVIDER_CREDENTIALS_NOT_READY"]),
      ...(record.status === "ACTIVE" ? [] : ["COURIER_PROVIDER_CREDENTIAL_STATUS_NOT_ACTIVE"])
    ]
  };
}

function statusBlockers(lane: CourierProviderLaneDefinition, requestedMode: CourierProviderRuntimeMode) {
  if (lane.status === "DISABLED") return ["COURIER_PROVIDER_LANE_DISABLED"];
  if (lane.status === "SUSPENDED") return ["COURIER_PROVIDER_LANE_SUSPENDED"];
  if (lane.status === "TESTING" && requestedMode === "LIVE") return ["COURIER_PROVIDER_LANE_TESTING_ONLY"];
  return [];
}

function modeBlockers(lane: CourierProviderLaneDefinition, requestedMode: CourierProviderRuntimeMode) {
  if (requestedMode === "LIVE" && lane.mode !== "LIVE") return ["COURIER_PROVIDER_LANE_LIVE_DISABLED"];
  return [];
}

function sellerMessage(status: CourierProviderWorkflowGuardResult["status"]) {
  if (status === "ALLOWED") return "Shipmastr can evaluate this shipping action safely.";
  if (status === "DRY_RUN_ONLY") return "This shipping action is available for safe dry-run checks only.";
  if (status === "UNSUPPORTED") return "This Shipmastr shipping outcome is not available for the selected workflow.";
  return "Shipmastr needs an internal readiness check before this shipping action can continue.";
}

export async function checkCourierProviderLiveWorkflowAllowed(
  input: {
    merchantId?: string | null;
    laneCode: CourierProviderLaneCode;
    capability: CourierProviderCapability;
    mode?: CourierProviderRuntimeMode;
  },
  dependencies: CourierProviderRegistryDependencies = {},
  client: Db = prisma
): Promise<CourierProviderWorkflowGuardResult> {
  const lane = getCourierProviderLane(input.laneCode).lane;
  const requestedMode = input.mode ?? "LIVE";
  const credentialReadiness = await getCourierProviderLaneCredentialReadiness(
    input.merchantId ?? null,
    lane,
    client,
    dependencies
  );
  const supported = providerLaneSupportsCapability(lane, input.capability);
  const blockers = [
    ...(supported ? [] : ["COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"]),
    ...statusBlockers(lane, requestedMode),
    ...modeBlockers(lane, requestedMode),
    ...(requestedMode === "LIVE" && credentialReadiness.status !== "READY"
      ? ["COURIER_PROVIDER_CREDENTIALS_NOT_READY"]
      : []),
    ...credentialReadiness.blockers
  ];
  const uniqueBlockers = [...new Set(blockers)];
  const status: CourierProviderWorkflowGuardResult["status"] = !supported
    ? "UNSUPPORTED"
    : uniqueBlockers.length
      ? "BLOCKED"
      : requestedMode === "SANDBOX"
        ? "DRY_RUN_ONLY"
        : "ALLOWED";

  return {
    lane_code: lane.code,
    capability: input.capability,
    requested_mode: requestedMode,
    status,
    allowed: status === "ALLOWED",
    public_network_name: "Shipmastr Courier Network",
    public_outcomes: courierProviderPublicOutcomes,
    seller_safe_message: sellerMessage(status),
    blockers: uniqueBlockers,
    warnings: [
      "Phase 51 does not perform real courier/provider calls.",
      ...(requestedMode === "LIVE" ? ["Live checks are guard-only and require credential readiness."] : [])
    ],
    credential_readiness: credentialReadiness,
    admin_context: {
      provider_code: lane.providerCode,
      lane_type: lane.laneType,
      transport_mode: lane.transportMode,
      lane_status: lane.status,
      base_url_ref: lane.baseUrlRef
    }
  };
}

export function mapCourierProviderRawStatus(rawStatus: string | null | undefined): CourierProviderInternalShipmentStatus {
  return normalizeProviderShipmentStatus(rawStatus);
}
