import type { PilotLaunchCheck, PilotLaunchReport } from "./pilot-launch.types.js";

const unsafeKeyPattern = /secret|token|password|credential|authorization|cookie|headers|raw|api[_-]?key|consumer|hash|provider|courier/i;
const unsafeStringPattern = /shpat_|ck_|cs_|magentotoken_|bearer\s+|basic\s+|sk_live|sk_test|whsec_|token|secret|bigship/i;

function safeString(value: string) {
  if (unsafeStringPattern.test(value)) return "[redacted]";
  return value;
}

function safeValue(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(safeValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      output[key] = safeValue(child);
    }
    return output;
  }
  if (typeof value === "string") return safeString(value);
  return value;
}

function serializeCheck(check: PilotLaunchCheck) {
  return {
    key: check.key,
    label: check.label,
    category: check.category,
    status: check.status,
    safe_value: safeValue(check.safeValue ?? null),
    blocker_code: check.blockerCode ?? null,
    recommendation: check.recommendation ?? null
  };
}

export function serializePilotLaunchReport(report: PilotLaunchReport) {
  return {
    merchant_id: report.merchantId,
    checked_at: report.checkedAt,
    verdict: report.verdict,
    scope: {
      allowed_capabilities: report.scope.allowedCapabilities.map(safeString),
      blocked_capabilities: report.scope.blockedCapabilities.map(safeString),
      limited_capabilities: report.scope.limitedCapabilities.map(safeString)
    },
    summary: report.summary,
    categories: report.categories.map((category) => ({
      key: category.key,
      label: category.label,
      status: category.status,
      checks: category.checks.map(serializeCheck)
    })),
    go_no_go: {
      decision: report.goNoGo.decision,
      reasons: report.goNoGo.reasons.map(safeString),
      required_before_go: report.goNoGo.requiredBeforeGo.map(safeString),
      allowed_pilot_actions: report.goNoGo.allowedPilotActions.map(safeString),
      forbidden_pilot_actions: report.goNoGo.forbiddenPilotActions.map(safeString)
    },
    rollback: {
      available: report.rollback.available,
      controls: report.rollback.controls.map(safeString),
      instructions: report.rollback.instructions.map(safeString)
    },
    smoke_checklist: report.smokeChecklist.map((step) => ({
      step: step.step,
      title: safeString(step.title),
      status: step.status,
      command: step.command ?? null,
      expected_result: safeString(step.expectedResult)
    })),
    next_actions: report.nextActions.map(safeString)
  };
}
