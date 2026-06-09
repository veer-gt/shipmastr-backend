export type ProductionReadinessVerdict =
  | "READY_WITH_LIMITED_MOCKS"
  | "NOT_READY_FOR_LIVE"
  | "READY_FOR_CONTROLLED_LIVE_PILOT"
  | "BLOCKED";

export type ProductionReadinessStatus = "PASS" | "WARNING" | "BLOCKED";

export type ProductionReadinessRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ProductionReadinessCheck = {
  key: string;
  label: string;
  status: ProductionReadinessStatus;
  safeValue?: string | boolean | number | null;
  blockerCode?: string | undefined;
  recommendation: string;
};

export type ProductionReadinessCategory = {
  key: string;
  label: string;
  status: ProductionReadinessStatus;
  checks: ProductionReadinessCheck[];
};

export type LiveEnablementStep = {
  step: number;
  title: string;
  status: "NOT_STARTED" | "BLOCKED" | "READY_FOR_APPROVAL";
  requiredApproval: string;
  risk: ProductionReadinessRisk;
  instructions: string[];
};

export type ProductionReadinessApprovalChecklist = {
  approvalRequired: true;
  approvals: string[];
};

export type ProductionReadinessSummary = {
  totalChecks: number;
  passed: number;
  warnings: number;
  blockers: number;
};

export type ProductionReadinessReport = {
  verdict: ProductionReadinessVerdict;
  betaVerdict: "READY_WITH_LIMITED_MOCKS";
  liveVerdict: ProductionReadinessVerdict;
  checkedAt: string;
  summary: ProductionReadinessSummary;
  categories: ProductionReadinessCategory[];
  environment: {
    nodeEnv: string;
    appEnv: string;
    credentialVaultMode: string;
    workerMode: string;
    emailMode: string;
    pilotEmailMode: string;
    platformReadMode: string;
    platformWriteMode: string;
    shippingNetworkMode: string;
    pilotMerchantMode: string;
  };
  pilotReadiness: {
    merchantId: string;
    allowlisted: boolean;
    merchantStatus: string;
    enabledCapabilities: string[];
    approvedCapabilities: string[];
    rollbackReady: boolean;
    blockers: string[];
  };
  approvalChecklist: ProductionReadinessApprovalChecklist;
  liveEnablementPlan: LiveEnablementStep[];
  deferredGaps: string[];
  hardStops: string[];
  safetyBoundaries: {
    productionLiveBehaviorEnabled: false;
    schedulerEnabled: false;
    realEmailDeliveryEnabled: false;
    platformWebhookRegistrationPerformed: false;
    platformWritesEnabled: false;
    trackingSyncEnabled: false;
    liveShippingNetworkCallsEnabled: false;
    liveAwbLabelBehaviorNewlyEnabled: false;
    deploymentPerformed: false;
    productionMutationPerformed: false;
    rawEnvValuesExposed: false;
    secretValuesExposed: false;
  };
};

export type ProductionReadinessSource = Record<string, string | boolean | number | undefined | null>;
