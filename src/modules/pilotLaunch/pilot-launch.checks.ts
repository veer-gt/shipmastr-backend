import type { PilotLaunchCheck, PilotLaunchStatus } from "./pilot-launch.types.js";

export function pilotCheck(input: PilotLaunchCheck): PilotLaunchCheck {
  return input;
}

export function statusForBooleans(
  pass: boolean,
  blockedCode: string,
  options: {
    warningWhenFalse?: boolean;
    notApplicable?: boolean;
  } = {}
): { status: PilotLaunchStatus; blockerCode?: string } {
  if (options.notApplicable) return { status: "NOT_APPLICABLE" };
  if (pass) return { status: "PASS" };
  if (options.warningWhenFalse) return { status: "WARNING", blockerCode: blockedCode };
  return { status: "BLOCKED", blockerCode: blockedCode };
}

export const pilotLaunchForbiddenActions = [
  "Broad production rollout",
  "Global scheduler enablement",
  "Unapproved webhook registration",
  "Unapproved platform writes",
  "Unapproved live AWB or label creation",
  "Unapproved live shipping network calls",
  "Production deployment without runbook approval"
];

export const pilotLaunchAllowedActions = [
  "Run read-only import",
  "Review import reconciliation",
  "Convert eligible orders",
  "Run email sandbox test when approved",
  "Dry-run webhook registration",
  "Fetch pilot-gated rates if approved",
  "Use explicit pilot Ship Now only if AWB/label capability is approved",
  "Dry-run tracking sync"
];

export const pilotLaunchRollbackControls = [
  "Disable pilot merchant",
  "Disable individual pilot capability",
  "Return live flags to disabled or dry-run",
  "Stop worker run-once execution",
  "Disable platform webhook registration",
  "Keep audit logs and smoke output for incident review"
];

export const pilotLaunchSmokeChecklist = [
  {
    step: 1,
    title: "Run production readiness smoke",
    status: "PASS" as const,
    command: "npm run smoke:production-readiness",
    expectedResult: "READY_WITH_LIMITED_MOCKS or no HARD_STOP for approved pilot configuration"
  },
  {
    step: 2,
    title: "Run pilot live flow smoke",
    status: "PASS" as const,
    command: "npm run smoke:pilot-live-flow",
    expectedResult: "Live rates, AWB/label, and tracking sync remain blocked without approval"
  },
  {
    step: 3,
    title: "Review readiness dashboard",
    status: "PASS" as const,
    expectedResult: "No production deployment, no global live behavior, and no unsafe serializer leaks"
  },
  {
    step: 4,
    title: "Confirm rollback controls",
    status: "PASS" as const,
    expectedResult: "Merchant and capability disable actions are available before live testing"
  }
];
