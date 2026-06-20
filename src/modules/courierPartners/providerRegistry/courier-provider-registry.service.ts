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
import {
  courierProviderCapabilities,
  type CourierProviderCapabilityReadiness,
  type CourierProviderCapability,
  type CourierProviderInternalShipmentStatus,
  type CourierProviderLaneCode,
  type CourierProviderLaneCredentialReadiness,
  type CourierProviderLaneDefinition,
  type CourierProviderLaneReadinessDiagnostic,
  type CourierProviderRegistryDependencies,
  type CourierProviderRegistryListQuery,
  type CourierProviderRuntimeMode,
  type CourierProviderWorkflowGuardResult
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

function credentialReferenceSummary(credentialRef: string | null | undefined) {
  const configured = Boolean(credentialRef?.trim());
  if (!configured) {
    return {
      configured: false,
      ref_type: "NONE" as const,
      display_label: "Not configured",
      credential_ref_configured: false,
      env_ref_configured: false,
      secret_manager_ref_configured: false
    };
  }

  const normalized = credentialRef!.trim().toLowerCase();
  const envRef = normalized.startsWith("env:") || normalized.startsWith("env_");
  const secretManagerRef = normalized.startsWith("secret-manager:")
    || normalized.startsWith("secret_manager:")
    || normalized.startsWith("gcp-secret:")
    || normalized.startsWith("sm://");
  const refType = envRef
    ? "ENV_REF" as const
    : secretManagerRef
      ? "SECRET_MANAGER_REF" as const
      : "CREDENTIAL_REF" as const;

  return {
    configured: true,
    ref_type: refType,
    display_label: refType === "ENV_REF"
      ? "Environment reference configured"
      : refType === "SECRET_MANAGER_REF"
        ? "Secret manager reference configured"
        : "Credential vault reference configured",
    credential_ref_configured: refType === "CREDENTIAL_REF",
    env_ref_configured: envRef,
    secret_manager_ref_configured: secretManagerRef
  };
}

function missingReferenceReadiness(
  mode: CourierProviderRuntimeMode,
  dependencies: CourierProviderRegistryDependencies,
  blockers: string[]
): CourierProviderLaneCredentialReadiness {
  const reference = credentialReferenceSummary(null);
  return {
    status: "NOT_CONFIGURED",
    credential_ref_configured: false,
    env_ref_configured: false,
    secret_manager_ref_configured: false,
    reference,
    mode,
    last_test_status: null,
    checked_at: checkedAt(dependencies),
    blockers
  };
}

function normalizeCredentialReadiness(
  readiness: CourierProviderLaneCredentialReadiness,
  mode: CourierProviderRuntimeMode
): CourierProviderLaneCredentialReadiness {
  const reference = readiness.reference ?? {
    configured: readiness.credential_ref_configured,
    ref_type: readiness.credential_ref_configured ? "CREDENTIAL_REF" as const : "NONE" as const,
    display_label: readiness.credential_ref_configured ? "Credential reference configured" : "Not configured",
    credential_ref_configured: readiness.credential_ref_configured,
    env_ref_configured: readiness.env_ref_configured ?? false,
    secret_manager_ref_configured: readiness.secret_manager_ref_configured ?? false
  };

  return {
    ...readiness,
    env_ref_configured: readiness.env_ref_configured ?? reference.env_ref_configured,
    secret_manager_ref_configured: readiness.secret_manager_ref_configured ?? reference.secret_manager_ref_configured,
    reference,
    mode: readiness.mode ?? mode
  };
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
  dependencies: CourierProviderRegistryDependencies = {},
  mode: CourierProviderRuntimeMode = "LIVE"
): Promise<CourierProviderLaneCredentialReadiness> {
  if (dependencies.credentialReadinessProvider) {
    return normalizeCredentialReadiness(
      await dependencies.credentialReadinessProvider(merchantId, lane, mode),
      mode
    );
  }

  if (!merchantId) {
    return missingReferenceReadiness(mode, dependencies, ["COURIER_PROVIDER_MERCHANT_SCOPE_REQUIRED"]);
  }

  const record = await client.courierProviderCredential.findFirst({
    where: {
      merchantId,
      providerKey: { in: [lane.code, lane.providerCode] },
      mode
    },
    orderBy: [
      { lastTestedAt: "desc" },
      { updatedAt: "desc" }
    ]
  });

  if (!record) {
    return missingReferenceReadiness(mode, dependencies, [
      "COURIER_PROVIDER_CREDENTIALS_NOT_CONFIGURED",
      "COURIER_PROVIDER_CREDENTIAL_REFS_MISSING"
    ]);
  }

  const reference = credentialReferenceSummary(record.credentialRef);
  const credentialStatusBlocked = ["BLOCKED", "REVOKED", "SUSPENDED"].includes(record.status);
  const sandboxReady = mode === "SANDBOX" && reference.configured && !credentialStatusBlocked;
  const ready = Boolean(
    reference.configured &&
    record.status === "ACTIVE" &&
    record.mode === mode &&
    record.lastTestStatus === "PASS" &&
    record.lastTestedAt
  );

  if (ready || sandboxReady) {
    return {
      status: ready ? "READY" : "REFERENCE_CONFIGURED",
      credential_ref_configured: reference.credential_ref_configured,
      env_ref_configured: reference.env_ref_configured,
      secret_manager_ref_configured: reference.secret_manager_ref_configured,
      reference,
      mode,
      last_test_status: record.lastTestStatus,
      checked_at: checkedAt(dependencies),
      blockers: []
    };
  }

  return {
    status: reference.configured ? "REFERENCE_CONFIGURED" : "NOT_CONFIGURED",
    credential_ref_configured: reference.credential_ref_configured,
    env_ref_configured: reference.env_ref_configured,
    secret_manager_ref_configured: reference.secret_manager_ref_configured,
    reference,
    mode,
    last_test_status: record.lastTestStatus,
    checked_at: checkedAt(dependencies),
    blockers: [
      ...(reference.configured ? [] : [
        "COURIER_PROVIDER_CREDENTIALS_NOT_CONFIGURED",
        "COURIER_PROVIDER_CREDENTIAL_REFS_MISSING"
      ]),
      ...(mode === "LIVE" && record.lastTestStatus !== "PASS" ? ["COURIER_PROVIDER_CREDENTIALS_NOT_READY"] : []),
      ...(mode === "LIVE" && record.status !== "ACTIVE" ? ["COURIER_PROVIDER_CREDENTIAL_STATUS_NOT_ACTIVE"] : []),
      ...(credentialStatusBlocked ? ["COURIER_PROVIDER_CREDENTIAL_STATUS_BLOCKED"] : [])
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
    dependencies,
    requestedMode
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

function nextActionsForBlockers(blockers: readonly string[]) {
  const actions = new Set<string>();
  for (const blocker of blockers) {
    if (blocker.includes("CREDENTIAL")) actions.add("Configure safe credential references for this provider lane.");
    if (blocker.includes("TESTING_ONLY")) actions.add("Keep this lane in sandbox until live readiness is approved.");
    if (blocker.includes("DISABLED") || blocker.includes("SUSPENDED")) actions.add("Review lane status before enabling workflows.");
    if (blocker.includes("CAPABILITY_UNSUPPORTED")) actions.add("Choose a supported Shipmastr shipping capability.");
    if (blocker.includes("LIVE_DISABLED")) actions.add("Enable the lane for live mode only after approvals and readiness pass.");
    if (blocker.includes("MERCHANT_SCOPE")) actions.add("Provide a merchant scope for credential readiness checks.");
  }
  return [...actions];
}

function capabilityReadiness(
  lane: CourierProviderLaneDefinition,
  capability: CourierProviderCapability,
  requestedMode: CourierProviderRuntimeMode,
  credentialReadiness: CourierProviderLaneCredentialReadiness
): CourierProviderCapabilityReadiness {
  const supported = providerLaneSupportsCapability(lane, capability);
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
  return {
    capability,
    supported,
    status: supported ? uniqueBlockers.length ? "BLOCKED" : "READY" : "UNSUPPORTED",
    blockers: uniqueBlockers,
    next_actions: nextActionsForBlockers(uniqueBlockers)
  };
}

export async function getCourierProviderLaneReadinessDiagnostic(
  input: {
    merchantId?: string | null;
    laneCode: CourierProviderLaneCode;
    mode?: CourierProviderRuntimeMode;
    capability?: CourierProviderCapability;
  },
  dependencies: CourierProviderRegistryDependencies = {},
  client: Db = prisma
): Promise<CourierProviderLaneReadinessDiagnostic> {
  const lane = getCourierProviderLane(input.laneCode).lane;
  const requestedMode = input.mode ?? "LIVE";
  const credentialReadiness = await getCourierProviderLaneCredentialReadiness(
    input.merchantId ?? null,
    lane,
    client,
    dependencies,
    requestedMode
  );
  const capabilityMatrix = (input.capability ? [input.capability] : courierProviderCapabilities)
    .map((capability) => capabilityReadiness(lane, capability, requestedMode, credentialReadiness));
  const blockers = [...new Set([
    ...statusBlockers(lane, requestedMode),
    ...modeBlockers(lane, requestedMode),
    ...(requestedMode === "LIVE" && credentialReadiness.status !== "READY"
      ? ["COURIER_PROVIDER_CREDENTIALS_NOT_READY"]
      : []),
    ...credentialReadiness.blockers
  ])];

  return {
    lane_code: lane.code,
    provider_code: lane.providerCode,
    requested_mode: requestedMode,
    lane_status: lane.status,
    status: blockers.length ? "BLOCKED" : credentialReadiness.status,
    blocked: blockers.length > 0,
    blockers,
    next_actions: nextActionsForBlockers(blockers),
    credential_readiness: credentialReadiness,
    capability_matrix: capabilityMatrix,
    public_network_name: "Shipmastr Courier Network",
    public_outcomes: courierProviderPublicOutcomes,
    admin_context: {
      provider_label_internal: lane.providerLabelInternal,
      lane_type: lane.laneType,
      transport_mode: lane.transportMode,
      base_url_ref: lane.baseUrlRef,
      credential_reference_state: credentialReadiness.reference
    }
  };
}

export async function listCourierProviderLaneReadinessDiagnostics(
  query: CourierProviderRegistryListQuery & {
    merchantId?: string | null;
  } = {},
  dependencies: CourierProviderRegistryDependencies = {},
  client: Db = prisma
) {
  const lanes = listCourierProviderLanes(query).lanes;
  const diagnostics = await Promise.all(lanes.map((lane) => getCourierProviderLaneReadinessDiagnostic({
    merchantId: query.merchantId ?? null,
    laneCode: lane.code,
    ...(query.mode ? { mode: query.mode } : {}),
    ...(query.capability ? { capability: query.capability } : {})
  }, dependencies, client)));

  return { diagnostics, count: diagnostics.length };
}

export function mapCourierProviderRawStatus(rawStatus: string | null | undefined): CourierProviderInternalShipmentStatus {
  return normalizeProviderShipmentStatus(rawStatus);
}
