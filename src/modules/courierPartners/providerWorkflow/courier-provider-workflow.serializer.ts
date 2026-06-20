import { courierProviderPublicOutcomes } from "../providerRegistry/courier-provider-registry.rules.js";
import type { CourierProviderWorkflowDispatchResult } from "./courier-provider-workflow.dispatcher.js";

const unsafeKeyPattern = /secret|token|password|credential|authorization|cookie|headers|raw|api[_-]?key|private|hash|payload|response|awb|label|manifest|provider_code|lane_code/i;
const unsafeStringPattern = /bearer\s+|basic\s+|token|secret|password|private[_-]?key|access[_-]?key|credential|authorization|cookie|DELHIVERY|XPRESSBEES|SHADOWFAX|EKART|BIGSHIP|SHIPROCKET/i;

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim().slice(0, 180)))];
}

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

function sellerStatus(result: CourierProviderWorkflowDispatchResult) {
  if (result.status === "UNSUPPORTED") return "UNAVAILABLE";
  if (result.blocked) return "NEEDS_ATTENTION";
  return "AVAILABLE";
}

function sellerMessage(result: CourierProviderWorkflowDispatchResult) {
  if (result.status === "UNSUPPORTED") {
    return "This Shipmastr shipping outcome is not available for the selected workflow.";
  }
  if (result.blocked) {
    return "Shipmastr needs an internal readiness check before this shipping action can continue.";
  }
  return "Shipmastr can evaluate this shipping action safely.";
}

function sellerNextActions(result: CourierProviderWorkflowDispatchResult) {
  if (result.status === "UNSUPPORTED") return ["Choose another Shipmastr shipping outcome."];
  if (result.blocked) {
    return ["Keep the shipment in Needs Attention.", "Ask Shipmastr operations to review readiness."];
  }
  return [];
}

export function serializeSellerSafeCourierProviderWorkflowDispatch(
  result: CourierProviderWorkflowDispatchResult
) {
  return {
    public_network_name: "Shipmastr Courier Network" as const,
    public_outcomes: courierProviderPublicOutcomes,
    operation: result.operation,
    status: sellerStatus(result),
    message: sellerMessage(result),
    next_actions: sellerNextActions(result),
    provider_raw_response_stored: false as const,
    provider_headers_stored: false as const,
    credential_values_exposed: false as const
  };
}

export function serializeAdminCourierProviderWorkflowDispatch(
  result: CourierProviderWorkflowDispatchResult
) {
  return {
    operation: result.operation,
    lane_code: result.lane_code,
    capability: result.capability,
    requested_mode: result.requested_mode,
    status: result.status,
    safe_status: result.safe_status,
    blocked: result.blocked,
    blockers: uniqueStrings(result.blockers),
    warnings: uniqueStrings(result.warnings),
    public_network_name: result.public_network_name,
    public_outcomes: result.public_outcomes,
    provider_raw_response_stored: false as const,
    provider_headers_stored: false as const,
    credential_values_exposed: false as const,
    adapter_result: result.adapter_result ? {
      capability: result.adapter_result.capability,
      mode: result.adapter_result.mode,
      lane_code: result.adapter_result.lane_code,
      safe_status: result.adapter_result.safe_status,
      safe_data: safeValue(result.adapter_result.safe_data),
      warnings: uniqueStrings(result.adapter_result.warnings),
      provider_raw_response_stored: false as const,
      provider_headers_stored: false as const,
      credential_values_exposed: false as const
    } : null,
    admin_diagnostics: {
      lane_code: result.admin_diagnostics.lane_code,
      provider_code: result.admin_diagnostics.provider_code,
      capability: result.admin_diagnostics.capability,
      requested_mode: result.admin_diagnostics.requested_mode,
      lane_status: result.admin_diagnostics.lane_status,
      credential_status: result.admin_diagnostics.credential_status,
      credential_reference_configured: result.admin_diagnostics.credential_reference_configured,
      adapter_wired: result.admin_diagnostics.adapter_wired,
      adapter_result_status: result.admin_diagnostics.adapter_result_status,
      blockers: uniqueStrings(result.admin_diagnostics.blockers),
      next_actions: uniqueStrings(result.admin_diagnostics.next_actions)
    }
  };
}
