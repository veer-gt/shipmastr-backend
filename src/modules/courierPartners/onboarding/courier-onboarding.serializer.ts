import type {
  CourierOnboardingChecklist,
  CourierOnboardingStep,
  CourierOnboardingSummary
} from "./courier-onboarding.types.js";

const unsafeKeyPattern = /secret|token|password|credential_ref|credentialRef|authorization|cookie|headers|raw|api[_-]?key|private|hash|provider_payload|providerPayload|provider_response|providerResponse|provider_ref|providerRef|providerPickupId|providerCourierId|courier_id|courierId/i;
const unsafeStringPattern = /bearer\s+|basic\s+|token|secret|password|private[_-]?key|access[_-]?key|vault:/i;

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

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, 160)))];
}

export function serializeCourierOnboardingStep(step: CourierOnboardingStep): CourierOnboardingStep {
  return {
    key: step.key,
    label_internal: step.label_internal,
    status: step.status,
    blockers: uniqueStrings(step.blockers),
    warnings: uniqueStrings(step.warnings),
    next_action: step.next_action.slice(0, 240),
    safe_summary: (safeValue(step.safe_summary) ?? {}) as Record<string, unknown>
  };
}

export function serializeCourierOnboardingChecklist(checklist: CourierOnboardingChecklist): CourierOnboardingChecklist {
  return {
    provider_key: checklist.provider_key,
    provider_label_internal: checklist.provider_label_internal,
    public_network_name: "Shipmastr Courier Network",
    certification_status: checklist.certification_status,
    steps: checklist.steps.map(serializeCourierOnboardingStep),
    blockers: uniqueStrings(checklist.blockers),
    warnings: uniqueStrings(checklist.warnings),
    next_actions: uniqueStrings(checklist.next_actions),
    checked_at: checklist.checked_at
  };
}

export function serializeCourierOnboardingSummary(summary: CourierOnboardingSummary): CourierOnboardingSummary {
  return {
    merchant_id: summary.merchant_id,
    public_network_name: "Shipmastr Courier Network",
    checked_at: summary.checked_at,
    providers: summary.providers.map(serializeCourierOnboardingChecklist),
    counts: summary.counts,
    blockers: uniqueStrings(summary.blockers),
    warnings: uniqueStrings(summary.warnings),
    next_actions: uniqueStrings(summary.next_actions)
  };
}
