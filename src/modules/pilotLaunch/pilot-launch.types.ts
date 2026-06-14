export type PilotLaunchStatus = "PASS" | "WARNING" | "BLOCKED" | "NOT_APPLICABLE";

export type PilotLaunchVerdict =
  | "GO_FOR_CONTROLLED_PILOT"
  | "GO_WITH_LIMITED_SCOPE"
  | "NO_GO_BLOCKERS"
  | "READY_WITH_LIMITED_MOCKS";

export type PilotLaunchCheck = {
  key: string;
  label: string;
  status: PilotLaunchStatus;
  category: string;
  safeValue?: string | boolean | number | null | undefined;
  blockerCode?: string | undefined;
  recommendation?: string | undefined;
};

export type PilotLaunchCategory = {
  key: string;
  label: string;
  status: Exclude<PilotLaunchStatus, "NOT_APPLICABLE">;
  checks: PilotLaunchCheck[];
};

export type PilotLaunchReport = {
  merchantId: string;
  checkedAt: string;
  verdict: PilotLaunchVerdict;
  scope: {
    allowedCapabilities: string[];
    blockedCapabilities: string[];
    limitedCapabilities: string[];
  };
  summary: {
    totalChecks: number;
    passed: number;
    warnings: number;
    blockers: number;
    notApplicable: number;
  };
  categories: PilotLaunchCategory[];
  goNoGo: {
    decision: PilotLaunchVerdict;
    reasons: string[];
    requiredBeforeGo: string[];
    allowedPilotActions: string[];
    forbiddenPilotActions: string[];
  };
  rollback: {
    available: boolean;
    controls: string[];
    instructions: string[];
  };
  smokeChecklist: Array<{
    step: number;
    title: string;
    status: PilotLaunchStatus;
    command?: string;
    expectedResult: string;
  }>;
  nextActions: string[];
};
