import type {
  LiveEnablementStep,
  ProductionReadinessCategory,
  ProductionReadinessCheck,
  ProductionReadinessReport
} from "./production-readiness.types.js";

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

function serializeCheck(check: ProductionReadinessCheck) {
  return {
    key: check.key,
    label: check.label,
    status: check.status,
    safe_value: safeValue(check.safeValue ?? null),
    blocker_code: check.blockerCode ?? null,
    recommendation: check.recommendation
  };
}

function serializeCategory(category: ProductionReadinessCategory) {
  return {
    key: category.key,
    label: category.label,
    status: category.status,
    checks: category.checks.map(serializeCheck)
  };
}

function serializePlanStep(step: LiveEnablementStep) {
  return {
    step: step.step,
    title: step.title,
    status: step.status,
    required_approval: step.requiredApproval,
    risk: step.risk,
    instructions: step.instructions.map(safeString)
  };
}

export function serializeProductionReadinessReport(report: ProductionReadinessReport) {
  return {
    verdict: report.verdict,
    beta_verdict: report.betaVerdict,
    live_verdict: report.liveVerdict,
    checked_at: report.checkedAt,
    summary: report.summary,
    environment: report.environment,
    categories: report.categories.map(serializeCategory),
    approval_checklist: {
      approval_required: report.approvalChecklist.approvalRequired,
      approvals: report.approvalChecklist.approvals
    },
    live_enablement_plan: report.liveEnablementPlan.map(serializePlanStep),
    deferred_gaps: report.deferredGaps,
    hard_stops: report.hardStops,
    safety_boundaries: report.safetyBoundaries
  };
}

export function serializeProductionReadinessChecks(report: ProductionReadinessReport) {
  return {
    verdict: report.verdict,
    live_verdict: report.liveVerdict,
    checked_at: report.checkedAt,
    summary: report.summary,
    categories: report.categories.map(serializeCategory),
    hard_stops: report.hardStops
  };
}

export function serializeLiveEnablementPlan(report: ProductionReadinessReport) {
  return {
    beta_verdict: report.betaVerdict,
    live_verdict: report.liveVerdict,
    approval_checklist: {
      approval_required: report.approvalChecklist.approvalRequired,
      approvals: report.approvalChecklist.approvals
    },
    live_enablement_plan: report.liveEnablementPlan.map(serializePlanStep),
    deferred_gaps: report.deferredGaps,
    hard_stops: report.hardStops
  };
}
