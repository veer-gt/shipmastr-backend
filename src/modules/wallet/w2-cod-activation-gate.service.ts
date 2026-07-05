import { env } from "../../config/env.js";

export type W2CodActivationTargetMode = "instruction_only" | "custody";
export type W2CodRequirementStatus = "missing" | "documented" | "blocked" | "not_applicable";
export type W2CodRequirementScope = "instruction_only" | "custody" | "w3";

export type W2CodActivationRequirement = {
  code: string;
  title: string;
  status: W2CodRequirementStatus;
  requiredFor: W2CodRequirementScope;
  evidenceRef?: string;
};

export type W2CodActivationChecklist = {
  legal: W2CodActivationRequirement[];
  accounting: W2CodActivationRequirement[];
  banking: W2CodActivationRequirement[];
  operations: W2CodActivationRequirement[];
  technical: W2CodActivationRequirement[];
  owner: W2CodActivationRequirement[];
  futureW3: W2CodActivationRequirement[];
};

export type W2CodActivationGateStatus = {
  ok: boolean;
  targetMode: W2CodActivationTargetMode;
  status: "instruction_only" | "blocked" | "review_ready";
  blockingIssues: string[];
  warnings: string[];
  checklist: W2CodActivationChecklist;
};

export type W2CodActivationRuntimeInput = {
  walletW2Enabled?: boolean;
  codCustodyEnabled?: boolean;
  payoutExecutionEnabled?: boolean;
  allowBankTransfer?: boolean;
  nodeEnv?: string;
  appEnv?: string;
};

export type W2CodActivationApprovalInput = {
  counselCodInstructionOnlyPosition?: string;
  counselCodCustodyPosition?: string;
  counselCourierRemittanceSop?: string;
  counselSellerDisclosureTerms?: string;
  accountantCodTreatment?: string;
  accountantTdsTreatment?: string;
  accountantGstTreatment?: string;
  accountantPrincipalAgentTreatment?: string;
  bankingPartnerApproval?: string;
  operationsReconciliationSop?: string;
  operationsExceptionSop?: string;
  ownerApproval?: string;
};

export type W2CodActivationGateInput = {
  targetMode?: W2CodActivationTargetMode;
  approvals?: W2CodActivationApprovalInput;
  evidenceRefs?: Record<string, string | undefined>;
  runtime?: W2CodActivationRuntimeInput;
};

type RequirementTemplate = {
  code: string;
  title: string;
  requiredFor: W2CodRequirementScope;
  evidenceFrom?: keyof W2CodActivationApprovalInput;
};

type Runtime = Required<W2CodActivationRuntimeInput>;

const legalRequirements: RequirementTemplate[] = [
  { code: "COD_INSTRUCTION_ONLY_POSITION_SIGNOFF", title: "COD instruction-only position signed off", requiredFor: "instruction_only", evidenceFrom: "counselCodInstructionOnlyPosition" },
  { code: "COD_CUSTODY_POSITION_SIGNOFF", title: "COD custody position signed off", requiredFor: "custody", evidenceFrom: "counselCodCustodyPosition" },
  { code: "COURIER_REMITTANCE_SOP_SIGNOFF", title: "Courier remittance SOP signed off", requiredFor: "custody", evidenceFrom: "counselCourierRemittanceSop" },
  { code: "SELLER_DISCLOSURE_TERMS_SIGNOFF", title: "Seller disclosure terms signed off", requiredFor: "custody", evidenceFrom: "counselSellerDisclosureTerms" },
  { code: "DISPUTE_AND_GRIEVANCE_SOP_SIGNOFF", title: "Dispute and grievance SOP signed off", requiredFor: "custody" }
];

const accountingRequirements: RequirementTemplate[] = [
  { code: "COD_RECEIVABLE_TREATMENT_SIGNOFF", title: "COD receivable treatment signed off", requiredFor: "custody", evidenceFrom: "accountantCodTreatment" },
  { code: "FREIGHT_DEDUCTION_TREATMENT_SIGNOFF", title: "Freight deduction treatment signed off", requiredFor: "custody", evidenceFrom: "accountantCodTreatment" },
  { code: "RTO_DEDUCTION_TREATMENT_SIGNOFF", title: "RTO deduction treatment signed off", requiredFor: "custody", evidenceFrom: "accountantCodTreatment" },
  { code: "TDS_COURIER_PAYMENT_TREATMENT_SIGNOFF", title: "TDS courier payment treatment signed off", requiredFor: "custody", evidenceFrom: "accountantTdsTreatment" },
  { code: "GST_COD_FEE_TREATMENT_SIGNOFF", title: "GST COD fee treatment signed off", requiredFor: "custody", evidenceFrom: "accountantGstTreatment" },
  { code: "PRINCIPAL_VS_AGENT_SIGNOFF", title: "Principal versus agent treatment signed off", requiredFor: "custody", evidenceFrom: "accountantPrincipalAgentTreatment" }
];

const bankingRequirements: RequirementTemplate[] = [
  { code: "BANKING_PARTNER_COD_COLLECTION_APPROVAL", title: "Banking partner COD collection approval documented", requiredFor: "custody", evidenceFrom: "bankingPartnerApproval" },
  { code: "NODAL_OR_ESCROW_STRUCTURE_REVIEW", title: "Nodal or escrow structure reviewed", requiredFor: "custody", evidenceFrom: "bankingPartnerApproval" },
  { code: "SETTLEMENT_ACCOUNT_REVIEW", title: "Settlement account reviewed", requiredFor: "custody", evidenceFrom: "bankingPartnerApproval" },
  { code: "PAYOUT_FILE_CONTROL_REVIEW", title: "Payout file controls reviewed", requiredFor: "custody", evidenceFrom: "bankingPartnerApproval" }
];

const operationsRequirements: RequirementTemplate[] = [
  { code: "COD_RECONCILIATION_SOP", title: "COD reconciliation SOP documented", requiredFor: "custody", evidenceFrom: "operationsReconciliationSop" },
  { code: "COURIER_REMITTANCE_EXCEPTION_SOP", title: "Courier remittance exception SOP documented", requiredFor: "custody", evidenceFrom: "operationsExceptionSop" },
  { code: "SELLER_NEGATIVE_NET_SOP", title: "Seller negative-net SOP documented", requiredFor: "custody", evidenceFrom: "operationsExceptionSop" },
  { code: "DUPLICATE_REMITTANCE_SOP", title: "Duplicate remittance SOP documented", requiredFor: "custody", evidenceFrom: "operationsExceptionSop" },
  { code: "AUDIT_EXPORT_SOP", title: "Audit export SOP documented", requiredFor: "custody", evidenceFrom: "operationsReconciliationSop" },
  { code: "SUPPORT_ESCALATION_SOP", title: "Support escalation SOP documented", requiredFor: "custody", evidenceFrom: "operationsExceptionSop" }
];

const technicalRequirements: RequirementTemplate[] = [
  { code: "W2A_INSTRUCTION_ONLY_CONFIRMED", title: "W2A remains instruction-only", requiredFor: "instruction_only" },
  { code: "W2B_EXPORT_PREVIEW_ONLY_CONFIRMED", title: "W2B export-preview remains read-only", requiredFor: "instruction_only" },
  { code: "W2C_SMOKE_CONFIRMED", title: "W2C smoke confirms instruction-only flow", requiredFor: "instruction_only" },
  { code: "NO_COD_CUSTODY_TABLES_AS_SPENDABLE_BALANCE", title: "COD custody tables are not spendable balances", requiredFor: "instruction_only" },
  { code: "NO_PAYOUT_EXECUTION_ROUTE", title: "No payout execution route is present", requiredFor: "instruction_only" },
  { code: "NO_BANK_TRANSFER_INTEGRATION", title: "No bank transfer integration is present", requiredFor: "instruction_only" },
  { code: "NO_SELLER_SHIPPING_BALANCE_COD_CREDIT", title: "No seller shipping balance COD credit path is present", requiredFor: "instruction_only" },
  { code: "NO_PUBLIC_MUTATING_SELLER_W2_API", title: "No public mutating seller W2 API is present", requiredFor: "instruction_only" },
  { code: "I17_NO_PII_IN_COD_OUTPUT", title: "COD output avoids public or private references", requiredFor: "instruction_only" }
];

const ownerRequirements: RequirementTemplate[] = [
  { code: "OWNER_W2_MODE_APPROVAL", title: "Owner W2 mode approval documented", requiredFor: "custody", evidenceFrom: "ownerApproval" },
  { code: "PILOT_LIMIT_APPROVAL", title: "Pilot limit approval documented", requiredFor: "custody", evidenceFrom: "ownerApproval" },
  { code: "ROLLBACK_PLAN_APPROVAL", title: "Rollback plan approval documented", requiredFor: "custody", evidenceFrom: "ownerApproval" }
];

const futureW3Requirements: RequirementTemplate[] = [
  { code: "CHECKOUT_SPLIT_SETTLEMENT_NOT_APPROVED", title: "Checkout split settlement is not approved", requiredFor: "w3" },
  { code: "EARLY_COD_LENDING_NOT_APPROVED", title: "Early COD lending is not approved", requiredFor: "w3" },
  { code: "PAYMENT_AGGREGATOR_REVIEW_REQUIRED", title: "Payment aggregator review is required", requiredFor: "w3" },
  { code: "DIGITAL_LENDING_REVIEW_REQUIRED", title: "Digital lending review is required", requiredFor: "w3" }
];

function cleanEvidence(value: string | undefined) {
  const next = value?.trim();
  return next ? next : undefined;
}

function runtimeFromEnv(input?: W2CodActivationRuntimeInput): Runtime {
  return {
    walletW2Enabled: input?.walletW2Enabled ?? false,
    codCustodyEnabled: input?.codCustodyEnabled ?? false,
    payoutExecutionEnabled: input?.payoutExecutionEnabled ?? false,
    allowBankTransfer: input?.allowBankTransfer ?? false,
    nodeEnv: cleanEvidence(input?.nodeEnv) ?? env.NODE_ENV,
    appEnv: cleanEvidence(input?.appEnv) ?? env.APP_ENV
  };
}

function evidenceFor(template: RequirementTemplate, input: W2CodActivationGateInput) {
  const direct = cleanEvidence(input.evidenceRefs?.[template.code]);
  if (direct) return direct;
  return template.evidenceFrom ? cleanEvidence(input.approvals?.[template.evidenceFrom]) : undefined;
}

function isRequiredForTarget(template: RequirementTemplate, targetMode: W2CodActivationTargetMode) {
  if (template.requiredFor === "w3") return false;
  if (template.requiredFor === "instruction_only") return true;
  return targetMode === "custody";
}

function requirementStatus(template: RequirementTemplate, targetMode: W2CodActivationTargetMode, input: W2CodActivationGateInput): W2CodActivationRequirement {
  const { evidenceFrom: _evidenceFrom, ...base } = template;
  if (template.requiredFor === "w3") return { ...base, status: "blocked" };
  if (technicalRequirements.some((item) => item.code === template.code)) return { ...base, status: "documented" };
  if (!isRequiredForTarget(template, targetMode)) return { ...base, status: "not_applicable" };
  const evidenceRef = evidenceFor(template, input);
  return {
    ...base,
    status: evidenceRef ? "documented" : "missing",
    ...(evidenceRef ? { evidenceRef } : {})
  };
}

function buildRequirements(templates: RequirementTemplate[], targetMode: W2CodActivationTargetMode, input: W2CodActivationGateInput) {
  return templates.map((template) => requirementStatus(template, targetMode, input));
}

function custodyEvidenceIssues(checklist: W2CodActivationChecklist) {
  return [
    ...checklist.legal,
    ...checklist.accounting,
    ...checklist.banking,
    ...checklist.operations,
    ...checklist.owner
  ]
    .filter((requirement) => requirement.status === "missing")
    .map((requirement) => `MISSING_${requirement.code}`);
}

function instructionOnlyWarnings(checklist: W2CodActivationChecklist) {
  return checklist.legal
    .filter((requirement) => requirement.requiredFor === "instruction_only" && requirement.status === "missing")
    .map((requirement) => `MISSING_${requirement.code}`);
}

function runtimeWarningFlags(runtime: Runtime) {
  const warnings: string[] = [];
  if (runtime.walletW2Enabled) warnings.push("WALLET_W2_ENABLED_TRUE");
  if (runtime.nodeEnv === "production" || ["production", "staging", "live"].includes(runtime.appEnv)) {
    warnings.push("LIVE_RUNTIME_REQUIRES_FINAL_REVIEW");
  }
  return warnings;
}

function unsafeRuntimeIssues(runtime: Runtime, targetMode: W2CodActivationTargetMode, hasFullCustodyEvidence: boolean) {
  if (hasFullCustodyEvidence) return [];
  const issues: string[] = [];
  if (runtime.codCustodyEnabled) issues.push("COD_CUSTODY_FLAG_REQUIRES_FULL_APPROVAL");
  if (runtime.payoutExecutionEnabled) issues.push("PAYOUT_EXECUTION_FLAG_REQUIRES_FULL_APPROVAL");
  if (runtime.allowBankTransfer) issues.push("BANK_TRANSFER_FLAG_REQUIRES_FULL_APPROVAL");
  if (targetMode === "custody" && (runtime.nodeEnv === "production" || ["production", "staging", "live"].includes(runtime.appEnv))) {
    issues.push("LIVE_RUNTIME_REQUIRES_FULL_W2_APPROVAL");
  }
  return issues;
}

function technicalIssues(checklist: W2CodActivationChecklist) {
  return checklist.technical
    .filter((requirement) => requirement.status !== "documented")
    .map((requirement) => `MISSING_${requirement.code}`);
}

export class W2CodActivationGateService {
  getW2CodActivationGateStatus(input: W2CodActivationGateInput = {}): W2CodActivationGateStatus {
    const targetMode = input.targetMode ?? "instruction_only";
    const runtime = runtimeFromEnv(input.runtime);
    const checklist: W2CodActivationChecklist = {
      legal: buildRequirements(legalRequirements, targetMode, input),
      accounting: buildRequirements(accountingRequirements, targetMode, input),
      banking: buildRequirements(bankingRequirements, targetMode, input),
      operations: buildRequirements(operationsRequirements, targetMode, input),
      technical: buildRequirements(technicalRequirements, targetMode, input),
      owner: buildRequirements(ownerRequirements, targetMode, input),
      futureW3: buildRequirements(futureW3Requirements, targetMode, input)
    };

    const custodyIssues = targetMode === "custody" ? custodyEvidenceIssues(checklist) : [];
    const hasFullCustodyEvidence = custodyEvidenceIssues({
      ...checklist,
      legal: buildRequirements(legalRequirements, "custody", input),
      accounting: buildRequirements(accountingRequirements, "custody", input),
      banking: buildRequirements(bankingRequirements, "custody", input),
      operations: buildRequirements(operationsRequirements, "custody", input),
      owner: buildRequirements(ownerRequirements, "custody", input)
    }).length === 0;
    const blockingIssues = [
      ...technicalIssues(checklist),
      ...custodyIssues,
      ...unsafeRuntimeIssues(runtime, targetMode, hasFullCustodyEvidence)
    ];
    const warnings = [
      ...runtimeWarningFlags(runtime),
      ...instructionOnlyWarnings(checklist),
      "W2_MODE_LOCKED_TO_INSTRUCTION_ONLY_UNTIL_REVIEW"
    ];
    const status = blockingIssues.length > 0
      ? "blocked"
      : targetMode === "custody" ? "review_ready" : "instruction_only";

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

export const w2CodActivationGateService = new W2CodActivationGateService();
export const getW2CodActivationGateStatus = (input?: W2CodActivationGateInput) => w2CodActivationGateService.getW2CodActivationGateStatus(input);
