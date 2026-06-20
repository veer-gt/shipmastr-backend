import type {
  CourierProviderCredentialReadinessStatus,
  CourierProviderLaneDefinition,
  CourierProviderWorkflowGuardResult
} from "./courier-provider-registry.types.js";
import { courierProviderPublicOutcomes } from "./courier-provider-registry.rules.js";

const unsafeKeyPattern = /secret|token|password|credential_ref|credentialRef|authorization|cookie|headers|raw|api[_-]?key|private|hash|payload|response|awb|label|manifest/i;
const unsafeStringPattern = /bearer\s+|basic\s+|token|secret|password|private[_-]?key|access[_-]?key|credential|cookie|authorization/i;

function safeValue(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(safeValue).filter((item) => item !== undefined);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      const next = safeValue(child);
      if (next !== undefined) output[key] = next;
    }
    return output;
  }
  if (typeof value === "string") {
    if (unsafeStringPattern.test(value)) return undefined;
    return value.slice(0, 240);
  }
  return value;
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values
    .filter((value) => value.trim())
    .map((value) => value.trim().slice(0, 180)))];
}

export function serializeAdminCourierProviderLane(lane: CourierProviderLaneDefinition) {
  return {
    code: lane.code,
    provider_code: lane.providerCode,
    provider_label_internal: lane.providerLabelInternal,
    lane_type: lane.laneType,
    transport_mode: lane.transportMode,
    mode: lane.mode,
    status: lane.status,
    credential_readiness: lane.credentialReadiness,
    base_url_ref: lane.baseUrlRef,
    tax_config: {
      gst_enabled: lane.taxConfig.gstEnabled,
      gst_rate_percent: lane.taxConfig.gstRatePercent,
      service_code_type: lane.taxConfig.serviceCodeType,
      service_code: lane.taxConfig.serviceCode
    },
    capabilities: lane.capabilities,
    public_network_name: "Shipmastr Courier Network",
    public_outcomes: courierProviderPublicOutcomes,
    notes: uniqueStrings(lane.notes)
  };
}

export function serializeAdminCourierProviderLaneList(lanes: CourierProviderLaneDefinition[]) {
  return {
    public_network_name: "Shipmastr Courier Network",
    public_outcomes: courierProviderPublicOutcomes,
    lanes: lanes.map(serializeAdminCourierProviderLane),
    count: lanes.length
  };
}

export function serializeSellerSafeProviderAvailability(input: {
  credentialReadiness?: CourierProviderCredentialReadinessStatus;
  blocked?: boolean;
  capabilityUnsupported?: boolean;
}) {
  if (input.capabilityUnsupported) {
    return {
      public_network_name: "Shipmastr Courier Network",
      public_outcomes: courierProviderPublicOutcomes,
      status: "UNAVAILABLE",
      message: "This Shipmastr shipping outcome is not available for the selected workflow.",
      next_actions: ["Choose another Shipmastr shipping outcome."]
    };
  }

  if (input.blocked || input.credentialReadiness === "BLOCKED" || input.credentialReadiness === "NOT_CONFIGURED") {
    return {
      public_network_name: "Shipmastr Courier Network",
      public_outcomes: courierProviderPublicOutcomes,
      status: "NEEDS_ATTENTION",
      message: "Shipmastr needs an internal readiness check before this shipping action can continue.",
      next_actions: ["Keep the shipment in Needs Attention.", "Ask Shipmastr operations to review readiness."]
    };
  }

  return {
    public_network_name: "Shipmastr Courier Network",
    public_outcomes: courierProviderPublicOutcomes,
    status: "AVAILABLE",
    message: "Shipmastr can evaluate this shipping action safely.",
    next_actions: []
  };
}

export function serializeCourierProviderWorkflowGuard(result: CourierProviderWorkflowGuardResult) {
  return {
    lane_code: result.lane_code,
    capability: result.capability,
    requested_mode: result.requested_mode,
    status: result.status,
    allowed: result.allowed,
    public_network_name: result.public_network_name,
    public_outcomes: result.public_outcomes,
    seller_safe_message: result.seller_safe_message,
    blockers: uniqueStrings(result.blockers),
    warnings: uniqueStrings(result.warnings),
    credential_readiness: {
      status: result.credential_readiness.status,
      credential_ref_configured: result.credential_readiness.credential_ref_configured,
      last_test_status: result.credential_readiness.last_test_status,
      checked_at: result.credential_readiness.checked_at,
      blockers: uniqueStrings(result.credential_readiness.blockers)
    },
    admin_context: safeValue(result.admin_context)
  };
}
