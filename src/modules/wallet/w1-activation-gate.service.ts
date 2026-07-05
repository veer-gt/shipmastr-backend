import { env } from "../../config/env.js";

export type W1ActivationTargetMode = "sandbox" | "live";
export type W1RequirementStatus = "missing" | "documented" | "blocked" | "not_applicable";
export type W1RequirementScope = "sandbox" | "live" | "w2" | "w3";

export type W1ActivationRequirement = {
  code: string;
  title: string;
  status: W1RequirementStatus;
  requiredFor: W1RequirementScope;
  evidenceRef?: string;
};

export type W1ActivationChecklist = {
  legal: W1ActivationRequirement[];
  accounting: W1ActivationRequirement[];
  operations: W1ActivationRequirement[];
  technical: W1ActivationRequirement[];
  owner: W1ActivationRequirement[];
  futureW2W3: W1ActivationRequirement[];
};

export type W1ActivationGateStatus = {
  ok: boolean;
  targetMode: W1ActivationTargetMode;
  status: "blocked" | "sandbox_only" | "review_ready";
  blockingIssues: string[];
  warnings: string[];
  checklist: W1ActivationChecklist;
};

export type W1ActivationRuntimeInput = {
  walletW1Enabled?: boolean;
  sandboxOnly?: boolean;
  allowLivePayments?: boolean;
  allowCashout?: boolean;
  nodeEnv?: string;
  appEnv?: string;
};

export type W1ActivationApprovalInput = {
  counselClosedLoopWallet?: string;
  counselRefundToSourceSop?: string;
  accountantGstTreatment?: string;
  accountantTdsTreatment?: string;
  accountantPrincipalAgentTreatment?: string;
  ownerApproval?: string;
};

export type W1ActivationGateInput = {
  targetMode?: W1ActivationTargetMode;
  approvals?: W1ActivationApprovalInput;
  evidenceRefs?: Record<string, string | undefined>;
  runtime?: W1ActivationRuntimeInput;
};

type RequirementTemplate = {
  code: string;
  title: string;
  requiredFor: W1RequirementScope;
  evidenceFrom?: keyof W1ActivationApprovalInput;
};

type Runtime = Required<W1ActivationRuntimeInput>;

const legalRequirements: RequirementTemplate[] = [
  { code: "CLOSED_LOOP_SCOPE_SIGNOFF", title: "Closed-loop wallet scope signed off", requiredFor: "live", evidenceFrom: "counselClosedLoopWallet" },
  { code: "NO_CASHOUT_POSITION_SIGNOFF", title: "No-cashout position signed off", requiredFor: "live", evidenceFrom: "counselClosedLoopWallet" },
  { code: "REFUND_TO_SOURCE_SOP_SIGNOFF", title: "Refund-to-source SOP signed off", requiredFor: "live", evidenceFrom: "counselRefundToSourceSop" },
  { code: "TERMS_AND_USER_DISCLOSURE_SIGNOFF", title: "Terms and user disclosure signed off", requiredFor: "live", evidenceFrom: "counselClosedLoopWallet" },
  { code: "GRIEVANCE_AND_CLOSURE_SOP_SIGNOFF", title: "Grievance and closure SOP signed off", requiredFor: "live", evidenceFrom: "counselClosedLoopWallet" }
];

const accountingRequirements: RequirementTemplate[] = [
  { code: "GST_FREIGHT_TREATMENT_SIGNOFF", title: "GST freight treatment signed off", requiredFor: "live", evidenceFrom: "accountantGstTreatment" },
  { code: "GST_PLATFORM_FEE_TREATMENT_SIGNOFF", title: "GST platform fee treatment signed off", requiredFor: "live", evidenceFrom: "accountantGstTreatment" },
  { code: "TDS_COURIER_PAYMENT_TREATMENT_SIGNOFF", title: "TDS courier payment treatment signed off", requiredFor: "live", evidenceFrom: "accountantTdsTreatment" },
  { code: "PRINCIPAL_VS_AGENT_SIGNOFF", title: "Principal versus agent treatment signed off", requiredFor: "live", evidenceFrom: "accountantPrincipalAgentTreatment" },
  { code: "WALLET_LIABILITY_LEDGER_TREATMENT_SIGNOFF", title: "Wallet liability ledger treatment signed off", requiredFor: "live", evidenceFrom: "accountantPrincipalAgentTreatment" },
  { code: "REFUND_AND_CREDIT_NOTE_TREATMENT_SIGNOFF", title: "Refund and credit note treatment signed off", requiredFor: "live", evidenceFrom: "accountantPrincipalAgentTreatment" }
];

const operationsRequirements: RequirementTemplate[] = [
  { code: "RECONCILIATION_SOP", title: "Reconciliation SOP documented", requiredFor: "live" },
  { code: "FAILED_TOPUP_SOP", title: "Failed top-up SOP documented", requiredFor: "live" },
  { code: "DUPLICATE_TOPUP_SOP", title: "Duplicate top-up SOP documented", requiredFor: "live" },
  { code: "WALLET_FREEZE_LOCK_CLOSE_SOP", title: "Wallet freeze, lock, and close SOP documented", requiredFor: "live" },
  { code: "AUDIT_EXPORT_SOP", title: "Audit export SOP documented", requiredFor: "live" },
  { code: "SUPPORT_ESCALATION_SOP", title: "Support escalation SOP documented", requiredFor: "live" }
];

const technicalRequirements: RequirementTemplate[] = [
  { code: "W1_FLAGS_SAFE_DEFAULTS", title: "W1 flags default to sandbox-safe values", requiredFor: "sandbox" },
  { code: "PRODUCTION_GUARD_PRESENT", title: "Production mutation guard is present", requiredFor: "sandbox" },
  { code: "NO_PUBLIC_MUTATING_ROUTES", title: "No public mutating W1 routes are present", requiredFor: "sandbox" },
  { code: "NO_LIVE_PAYMENT_PROVIDER", title: "No live provider call is wired", requiredFor: "sandbox" },
  { code: "NO_BANK_CASHOUT", title: "No bank cashout is wired", requiredFor: "sandbox" },
  { code: "NO_SHADOW_SPENDABLE_BALANCE", title: "Shadow balances are not spendable", requiredFor: "sandbox" },
  { code: "LEDGER_SERVICE_ONLY", title: "Ledger postings use LedgerService only", requiredFor: "sandbox" },
  { code: "I17_NO_PII_IN_LEDGER_FIELDS", title: "Ledger fields reject public or private refs", requiredFor: "sandbox" }
];

const ownerRequirements: RequirementTemplate[] = [
  { code: "OWNER_LIVE_ACTIVATION_APPROVAL", title: "Owner live activation approval documented", requiredFor: "live", evidenceFrom: "ownerApproval" },
  { code: "ROLLBACK_PLAN_APPROVAL", title: "Rollback plan approval documented", requiredFor: "live", evidenceFrom: "ownerApproval" },
  { code: "PILOT_LIMIT_APPROVAL", title: "Pilot limit approval documented", requiredFor: "live", evidenceFrom: "ownerApproval" }
];

const futureRequirements: RequirementTemplate[] = [
  { code: "COD_CUSTODY_NOT_APPROVED", title: "COD custody is not approved", requiredFor: "w2" },
  { code: "CHECKOUT_SPLIT_SETTLEMENT_NOT_APPROVED", title: "Checkout split settlement is not approved", requiredFor: "w2" },
  { code: "EARLY_COD_LENDING_PARTNER_NOT_APPROVED", title: "Early COD lending partner is not approved", requiredFor: "w3" },
  { code: "DIGITAL_LENDING_FLOW_REVIEW_REQUIRED", title: "Digital lending flow requires separate review", requiredFor: "w3" },
  { code: "PAYMENT_AGGREGATOR_REVIEW_REQUIRED", title: "Payment aggregator flow requires separate review", requiredFor: "w2" }
];

function cleanEvidence(value: string | undefined) {
  const next = value?.trim();
  return next ? next : undefined;
}

function runtimeFromEnv(input?: W1ActivationRuntimeInput): Runtime {
  return {
    walletW1Enabled: input?.walletW1Enabled ?? env.WALLET_W1_ENABLED,
    sandboxOnly: input?.sandboxOnly ?? env.WALLET_W1_SANDBOX_ONLY,
    allowLivePayments: input?.allowLivePayments ?? env.WALLET_W1_ALLOW_LIVE_PAYMENTS,
    allowCashout: input?.allowCashout ?? env.WALLET_W1_ALLOW_CASHOUT,
    nodeEnv: cleanEvidence(input?.nodeEnv) ?? env.NODE_ENV,
    appEnv: cleanEvidence(input?.appEnv) ?? env.APP_ENV
  };
}

function evidenceFor(template: RequirementTemplate, input: W1ActivationGateInput) {
  const direct = cleanEvidence(input.evidenceRefs?.[template.code]);
  if (direct) return direct;
  return template.evidenceFrom ? cleanEvidence(input.approvals?.[template.evidenceFrom]) : undefined;
}

function requirementStatus(template: RequirementTemplate, targetMode: W1ActivationTargetMode, input: W1ActivationGateInput): W1ActivationRequirement {
  const { evidenceFrom: _evidenceFrom, ...base } = template;
  if (template.requiredFor === "w2" || template.requiredFor === "w3") {
    return { ...base, status: "blocked" };
  }
  if (template.requiredFor === "sandbox") {
    return { ...base, status: "documented" };
  }
  if (targetMode === "sandbox") {
    return { ...base, status: "not_applicable" };
  }
  const evidenceRef = evidenceFor(template, input);
  return {
    ...base,
    status: evidenceRef ? "documented" : "missing",
    ...(evidenceRef ? { evidenceRef } : {})
  };
}

function buildRequirements(templates: RequirementTemplate[], targetMode: W1ActivationTargetMode, input: W1ActivationGateInput) {
  return templates.map((template) => requirementStatus(template, targetMode, input));
}

function missingRequirementIssues(checklist: W1ActivationChecklist) {
  return [
    ...checklist.legal,
    ...checklist.accounting,
    ...checklist.operations,
    ...checklist.owner
  ]
    .filter((requirement) => requirement.status === "missing")
    .map((requirement) => `MISSING_${requirement.code}`);
}

function runtimeWarnings(runtime: Runtime) {
  const warnings: string[] = [];
  if (runtime.walletW1Enabled) warnings.push("WALLET_W1_ENABLED_TRUE");
  if (runtime.allowLivePayments) warnings.push("WALLET_W1_ALLOW_LIVE_PAYMENTS_TRUE");
  if (runtime.allowCashout) warnings.push("WALLET_W1_ALLOW_CASHOUT_TRUE");
  if (runtime.nodeEnv === "production" || runtime.appEnv === "production") warnings.push("PRODUCTION_RUNTIME_REQUIRES_FINAL_APPROVAL");
  return warnings;
}

export class W1ActivationGateService {
  getW1ActivationGateStatus(input: W1ActivationGateInput = {}): W1ActivationGateStatus {
    const targetMode = input.targetMode ?? "sandbox";
    const runtime = runtimeFromEnv(input.runtime);
    const checklist: W1ActivationChecklist = {
      legal: buildRequirements(legalRequirements, targetMode, input),
      accounting: buildRequirements(accountingRequirements, targetMode, input),
      operations: buildRequirements(operationsRequirements, targetMode, input),
      technical: buildRequirements(technicalRequirements, targetMode, input),
      owner: buildRequirements(ownerRequirements, targetMode, input),
      futureW2W3: buildRequirements(futureRequirements, targetMode, input)
    };

    const blockingIssues: string[] = [];
    if (targetMode === "live") {
      blockingIssues.push(...missingRequirementIssues(checklist));
      const hasMissingEvidence = blockingIssues.length > 0;
      if (runtime.allowLivePayments && hasMissingEvidence) blockingIssues.push("LIVE_PAYMENT_FLAG_REQUIRES_FULL_APPROVAL");
      if (runtime.allowCashout && hasMissingEvidence) blockingIssues.push("CASHOUT_FLAG_REQUIRES_FULL_APPROVAL");
      if ((runtime.nodeEnv === "production" || runtime.appEnv === "production") && hasMissingEvidence) {
        blockingIssues.push("PRODUCTION_RUNTIME_REQUIRES_FULL_APPROVAL");
      }
    }

    const warnings = runtimeWarnings(runtime);
    if (!runtime.sandboxOnly) warnings.push("WALLET_W1_SANDBOX_ONLY_FALSE");
    const status = targetMode === "sandbox"
      ? "sandbox_only"
      : blockingIssues.length === 0 ? "review_ready" : "blocked";

    return {
      ok: status !== "blocked",
      targetMode,
      status,
      blockingIssues,
      warnings,
      checklist
    };
  }
}

export const w1ActivationGateService = new W1ActivationGateService();
export const getW1ActivationGateStatus = (input?: W1ActivationGateInput) => w1ActivationGateService.getW1ActivationGateStatus(input);
