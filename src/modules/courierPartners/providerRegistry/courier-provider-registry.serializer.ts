import type {
  CourierProviderCredentialReadinessStatus,
  CourierProviderLaneDefinition,
  CourierProviderLaneReadinessDiagnostic,
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
      env_ref_configured: result.credential_readiness.env_ref_configured,
      secret_manager_ref_configured: result.credential_readiness.secret_manager_ref_configured,
      reference: {
        configured: result.credential_readiness.reference.configured,
        ref_type: result.credential_readiness.reference.ref_type,
        display_label: result.credential_readiness.reference.display_label,
        credential_ref_configured: result.credential_readiness.reference.credential_ref_configured,
        env_ref_configured: result.credential_readiness.reference.env_ref_configured,
        secret_manager_ref_configured: result.credential_readiness.reference.secret_manager_ref_configured
      },
      mode: result.credential_readiness.mode,
      last_test_status: result.credential_readiness.last_test_status,
      checked_at: result.credential_readiness.checked_at,
      blockers: uniqueStrings(result.credential_readiness.blockers)
    },
    admin_context: safeValue(result.admin_context)
  };
}

function serializeCredentialReadiness(readiness: CourierProviderLaneReadinessDiagnostic["credential_readiness"]) {
  return {
    status: readiness.status,
    credential_ref_configured: readiness.credential_ref_configured,
    env_ref_configured: readiness.env_ref_configured,
    secret_manager_ref_configured: readiness.secret_manager_ref_configured,
    reference: {
      configured: readiness.reference.configured,
      ref_type: readiness.reference.ref_type,
      display_label: readiness.reference.display_label,
      credential_ref_configured: readiness.reference.credential_ref_configured,
      env_ref_configured: readiness.reference.env_ref_configured,
      secret_manager_ref_configured: readiness.reference.secret_manager_ref_configured
    },
    mode: readiness.mode,
    last_test_status: readiness.last_test_status,
    checked_at: readiness.checked_at,
    blockers: uniqueStrings(readiness.blockers)
  };
}

export function serializeAdminCourierProviderLaneReadinessDiagnostic(
  diagnostic: CourierProviderLaneReadinessDiagnostic
) {
  return {
    lane_code: diagnostic.lane_code,
    provider_code: diagnostic.provider_code,
    requested_mode: diagnostic.requested_mode,
    lane_status: diagnostic.lane_status,
    status: diagnostic.status,
    blocked: diagnostic.blocked,
    blockers: uniqueStrings(diagnostic.blockers),
    next_actions: uniqueStrings(diagnostic.next_actions),
    credential_readiness: serializeCredentialReadiness(diagnostic.credential_readiness),
    capability_matrix: diagnostic.capability_matrix.map((capability) => ({
      capability: capability.capability,
      supported: capability.supported,
      status: capability.status,
      blockers: uniqueStrings(capability.blockers),
      next_actions: uniqueStrings(capability.next_actions)
    })),
    public_network_name: diagnostic.public_network_name,
    public_outcomes: diagnostic.public_outcomes,
    admin_context: {
      provider_label_internal: diagnostic.admin_context.provider_label_internal,
      lane_type: diagnostic.admin_context.lane_type,
      transport_mode: diagnostic.admin_context.transport_mode,
      base_url_ref: diagnostic.admin_context.base_url_ref,
      credential_reference_state: {
        configured: diagnostic.admin_context.credential_reference_state.configured,
        ref_type: diagnostic.admin_context.credential_reference_state.ref_type,
        display_label: diagnostic.admin_context.credential_reference_state.display_label,
        credential_ref_configured: diagnostic.admin_context.credential_reference_state.credential_ref_configured,
        env_ref_configured: diagnostic.admin_context.credential_reference_state.env_ref_configured,
        secret_manager_ref_configured: diagnostic.admin_context.credential_reference_state.secret_manager_ref_configured
      }
    }
  };
}

export function serializeAdminCourierProviderLaneReadinessDiagnosticList(input: {
  diagnostics: CourierProviderLaneReadinessDiagnostic[];
  count: number;
}) {
  return {
    public_network_name: "Shipmastr Courier Network",
    public_outcomes: courierProviderPublicOutcomes,
    diagnostics: input.diagnostics.map(serializeAdminCourierProviderLaneReadinessDiagnostic),
    count: input.count
  };
}
