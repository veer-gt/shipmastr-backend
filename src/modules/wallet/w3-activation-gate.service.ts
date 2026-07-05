import { env } from "../../config/env.js";

export type W3ActivationTargetMode = "preview_only" | "checkout_settlement" | "early_cod_partner" | "full_w3";
export type W3RequirementStatus = "missing" | "documented" | "blocked" | "not_applicable";
export type W3RequirementScope = W3ActivationTargetMode;

export type W3ActivationRequirement = {
  code: string;
  title: string;
  status: W3RequirementStatus;
  requiredFor: W3RequirementScope;
  evidenceRef?: string;
};

export type W3ActivationChecklist = {
  legal: W3ActivationRequirement[];
  accounting: W3ActivationRequirement[];
  paymentPartner: W3ActivationRequirement[];
  lendingPartner: W3ActivationRequirement[];
  banking: W3ActivationRequirement[];
  operations: W3ActivationRequirement[];
  technical: W3ActivationRequirement[];
  owner: W3ActivationRequirement[];
  postActivationControls: W3ActivationRequirement[];
};

export type W3ActivationGateStatus = {
  ok: boolean;
  targetMode: W3ActivationTargetMode;
  status: "preview_only" | "blocked" | "review_ready";
  blockingIssues: string[];
  warnings: string[];
  checklist: W3ActivationChecklist;
};

export type W3ActivationRuntimeInput = {
  walletW3Enabled?: boolean;
  checkoutSettlementEnabled?: boolean;
  paymentCaptureEnabled?: boolean;
  payoutExecutionEnabled?: boolean;
  earlyCodFundingEnabled?: boolean;
  lendingPartnerEnabled?: boolean;
  allowBankTransfer?: boolean;
  nodeEnv?: string;
  appEnv?: string;
};

export type W3ActivationApprovalInput = {
  counselCheckoutSettlementPosition?: string;
  counselPaymentAggregatorPosition?: string;
  counselEarlyCodPartnerPosition?: string;
  counselDigitalLendingPosition?: string;
  counselSellerDisclosureTerms?: string;
  accountantCheckoutSettlementTreatment?: string;
  accountantEarlyCodTreatment?: string;
  accountantGstTreatment?: string;
  accountantTdsTreatment?: string;
  accountantPrincipalAgentTreatment?: string;
  paymentPartnerApproval?: string;
  lendingPartnerApproval?: string;
  bankingPartnerApproval?: string;
  operationsSettlementSop?: string;
  operationsExceptionSop?: string;
  operationsDisputeSop?: string;
  ownerApproval?: string;
};

export type W3ActivationGateInput = {
  targetMode?: W3ActivationTargetMode;
  approvals?: W3ActivationApprovalInput;
  evidenceRefs?: Record<string, string | undefined>;
  runtime?: W3ActivationRuntimeInput;
};

type RequirementTemplate = {
  code: string;
  title: string;
  requiredFor: W3RequirementScope;
  modes: W3ActivationTargetMode[];
  evidenceFrom?: keyof W3ActivationApprovalInput;
  documentedByDefault?: boolean;
};

type Runtime = Required<W3ActivationRuntimeInput>;

const checkoutModes: W3ActivationTargetMode[] = ["checkout_settlement", "full_w3"];
const earlyCodModes: W3ActivationTargetMode[] = ["early_cod_partner", "full_w3"];
const activeModes: W3ActivationTargetMode[] = ["checkout_settlement", "early_cod_partner", "full_w3"];

const legalRequirements: RequirementTemplate[] = [
  { code: "CHECKOUT_SETTLEMENT_POSITION_SIGNOFF", title: "Checkout settlement position signed off", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "counselCheckoutSettlementPosition" },
  { code: "PAYMENT_AGGREGATOR_POSITION_SIGNOFF", title: "Payment aggregator position signed off", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "counselPaymentAggregatorPosition" },
  { code: "EARLY_COD_PARTNER_POSITION_SIGNOFF", title: "Early COD partner position signed off", requiredFor: "early_cod_partner", modes: earlyCodModes, evidenceFrom: "counselEarlyCodPartnerPosition" },
  { code: "DIGITAL_LENDING_POSITION_SIGNOFF", title: "Digital credit position signed off", requiredFor: "early_cod_partner", modes: earlyCodModes, evidenceFrom: "counselDigitalLendingPosition" },
  { code: "SELLER_DISCLOSURE_TERMS_SIGNOFF", title: "Seller disclosure terms signed off", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "counselSellerDisclosureTerms" },
  { code: "GRIEVANCE_AND_DISPUTE_SOP_SIGNOFF", title: "Grievance and dispute SOP signed off", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "counselSellerDisclosureTerms" }
];

const accountingRequirements: RequirementTemplate[] = [
  { code: "CHECKOUT_SETTLEMENT_ACCOUNTING_SIGNOFF", title: "Checkout settlement accounting signed off", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "accountantCheckoutSettlementTreatment" },
  { code: "EARLY_COD_ACCOUNTING_SIGNOFF", title: "Early COD accounting signed off", requiredFor: "early_cod_partner", modes: earlyCodModes, evidenceFrom: "accountantEarlyCodTreatment" },
  { code: "GST_PLATFORM_FEE_TREATMENT_SIGNOFF", title: "GST platform fee treatment signed off", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "accountantGstTreatment" },
  { code: "TDS_PAYMENT_AND_COURIER_TREATMENT_SIGNOFF", title: "TDS payment and courier treatment signed off", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "accountantTdsTreatment" },
  { code: "PRINCIPAL_VS_AGENT_SIGNOFF", title: "Principal versus agent treatment signed off", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "accountantPrincipalAgentTreatment" },
  { code: "REFUND_AND_REVERSAL_TREATMENT_SIGNOFF", title: "Refund and reversal treatment signed off", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "accountantCheckoutSettlementTreatment" }
];

const paymentPartnerRequirements: RequirementTemplate[] = [
  { code: "PAYMENT_PARTNER_APPROVAL", title: "Payment partner approval documented", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "paymentPartnerApproval" },
  { code: "PAYMENT_CAPTURE_FLOW_APPROVAL", title: "Payment capture flow approval documented", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "paymentPartnerApproval" },
  { code: "SPLIT_SETTLEMENT_OR_ROUTING_APPROVAL", title: "Split settlement or routing approval documented", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "paymentPartnerApproval" },
  { code: "REFUND_FLOW_APPROVAL", title: "Refund flow approval documented", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "paymentPartnerApproval" },
  { code: "WEBHOOK_RECONCILIATION_APPROVAL", title: "Webhook reconciliation approval documented", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "paymentPartnerApproval" }
];

const lendingPartnerRequirements: RequirementTemplate[] = [
  { code: "LENDING_PARTNER_APPROVAL", title: "Early COD partner approval documented", requiredFor: "early_cod_partner", modes: earlyCodModes, evidenceFrom: "lendingPartnerApproval" },
  { code: "LENDER_OF_RECORD_CONFIRMATION", title: "Partner of record confirmation documented", requiredFor: "early_cod_partner", modes: earlyCodModes, evidenceFrom: "lendingPartnerApproval" },
  { code: "FUND_FLOW_NO_SHIPMASTR_CUSTODY_CONFIRMATION", title: "Partner fund flow without Shipmastr custody confirmed", requiredFor: "early_cod_partner", modes: earlyCodModes, evidenceFrom: "lendingPartnerApproval" },
  { code: "KFS_AND_DISCLOSURE_OWNER_CONFIRMATION", title: "Disclosure owner confirmation documented", requiredFor: "early_cod_partner", modes: earlyCodModes, evidenceFrom: "lendingPartnerApproval" },
  { code: "REPAYMENT_FLOW_REVIEW", title: "Return-flow review documented", requiredFor: "early_cod_partner", modes: earlyCodModes, evidenceFrom: "lendingPartnerApproval" },
  { code: "COLLECTIONS_AND_GRIEVANCE_REVIEW", title: "Collections and grievance review documented", requiredFor: "early_cod_partner", modes: earlyCodModes, evidenceFrom: "lendingPartnerApproval" }
];

const bankingRequirements: RequirementTemplate[] = [
  { code: "BANKING_PARTNER_APPROVAL", title: "Banking partner approval documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "bankingPartnerApproval" },
  { code: "SETTLEMENT_ACCOUNT_REVIEW", title: "Settlement account review documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "bankingPartnerApproval" },
  { code: "PAYOUT_FILE_CONTROL_REVIEW", title: "Payout file control review documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "bankingPartnerApproval" },
  { code: "RECONCILIATION_ACCOUNT_REVIEW", title: "Reconciliation account review documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "bankingPartnerApproval" }
];

const operationsRequirements: RequirementTemplate[] = [
  { code: "CHECKOUT_RECONCILIATION_SOP", title: "Checkout reconciliation SOP documented", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "operationsSettlementSop" },
  { code: "PAYMENT_FAILURE_SOP", title: "Payment failure SOP documented", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "operationsSettlementSop" },
  { code: "REFUND_REVERSAL_SOP", title: "Refund reversal SOP documented", requiredFor: "checkout_settlement", modes: checkoutModes, evidenceFrom: "operationsSettlementSop" },
  { code: "EARLY_COD_EXCEPTION_SOP", title: "Early COD exception SOP documented", requiredFor: "early_cod_partner", modes: earlyCodModes, evidenceFrom: "operationsExceptionSop" },
  { code: "PARTNER_RECONCILIATION_SOP", title: "Partner reconciliation SOP documented", requiredFor: "early_cod_partner", modes: earlyCodModes, evidenceFrom: "operationsExceptionSop" },
  { code: "SUPPORT_ESCALATION_SOP", title: "Support escalation SOP documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "operationsDisputeSop" },
  { code: "AUDIT_EXPORT_SOP", title: "Audit export SOP documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "operationsDisputeSop" }
];

const technicalRequirements: RequirementTemplate[] = [
  { code: "W3A_PREVIEW_ONLY_CONFIRMED", title: "W3A remains preview-only", requiredFor: "preview_only", modes: ["preview_only"], documentedByDefault: true },
  { code: "W3B_READ_EXPORT_ONLY_CONFIRMED", title: "W3B remains read and export-preview only", requiredFor: "preview_only", modes: ["preview_only"], documentedByDefault: true },
  { code: "W3C_PREQUALIFICATION_ONLY_CONFIRMED", title: "W3C remains prequalification-only", requiredFor: "preview_only", modes: ["preview_only"], documentedByDefault: true },
  { code: "NO_PAYMENT_CAPTURE_ROUTE", title: "No payment capture route is present", requiredFor: "preview_only", modes: ["preview_only"], documentedByDefault: true },
  { code: "NO_SETTLEMENT_EXECUTION_ROUTE", title: "No settlement execution route is present", requiredFor: "preview_only", modes: ["preview_only"], documentedByDefault: true },
  { code: "NO_PAYOUT_EXECUTION_ROUTE", title: "No payout execution route is present", requiredFor: "preview_only", modes: ["preview_only"], documentedByDefault: true },
  { code: "NO_LENDING_EXECUTION_ROUTE", title: "No early COD credit execution route is present", requiredFor: "preview_only", modes: ["preview_only"], documentedByDefault: true },
  { code: "NO_PARTNER_API_CALLS", title: "No partner API calls are wired", requiredFor: "preview_only", modes: ["preview_only"], documentedByDefault: true },
  { code: "NO_SELLER_SHIPPING_BALANCE_CREDIT", title: "No seller shipping balance credit path is present", requiredFor: "preview_only", modes: ["preview_only"], documentedByDefault: true },
  { code: "NO_PUBLIC_MUTATING_SELLER_W3_API", title: "No public mutating seller W3 API is present", requiredFor: "preview_only", modes: ["preview_only"], documentedByDefault: true },
  { code: "I17_NO_PII_IN_W3_OUTPUT", title: "W3 output avoids sensitive readable refs", requiredFor: "preview_only", modes: ["preview_only"], documentedByDefault: true }
];

const ownerRequirements: RequirementTemplate[] = [
  { code: "OWNER_W3_MODE_APPROVAL", title: "Owner W3 mode approval documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "ownerApproval" },
  { code: "PILOT_LIMIT_APPROVAL", title: "Pilot limit approval documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "ownerApproval" },
  { code: "ROLLBACK_PLAN_APPROVAL", title: "Rollback plan approval documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "ownerApproval" },
  { code: "INCIDENT_RESPONSE_APPROVAL", title: "Incident response approval documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "ownerApproval" }
];

const postActivationControlRequirements: RequirementTemplate[] = [
  { code: "DAILY_RECONCILIATION_REQUIRED", title: "Daily reconciliation control documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "operationsDisputeSop" },
  { code: "LEDGER_EXCEPTION_REVIEW_REQUIRED", title: "Ledger exception review control documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "operationsDisputeSop" },
  { code: "WEBHOOK_REPLAY_CONTROL_REQUIRED", title: "Webhook replay control documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "operationsSettlementSop" },
  { code: "PARTNER_STATEMENT_MATCH_REQUIRED", title: "Partner statement match control documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "operationsExceptionSop" },
  { code: "MANUAL_HOLD_AND_FREEZE_CONTROL_REQUIRED", title: "Manual hold and freeze control documented", requiredFor: "full_w3", modes: activeModes, evidenceFrom: "operationsDisputeSop" }
];

function cleanEvidence(value: string | undefined) {
  const next = value?.trim();
  return next ? next : undefined;
}

function runtimeFromEnv(input?: W3ActivationRuntimeInput): Runtime {
  return {
    walletW3Enabled: input?.walletW3Enabled ?? false,
    checkoutSettlementEnabled: input?.checkoutSettlementEnabled ?? false,
    paymentCaptureEnabled: input?.paymentCaptureEnabled ?? false,
    payoutExecutionEnabled: input?.payoutExecutionEnabled ?? false,
    earlyCodFundingEnabled: input?.earlyCodFundingEnabled ?? false,
    lendingPartnerEnabled: input?.lendingPartnerEnabled ?? false,
    allowBankTransfer: input?.allowBankTransfer ?? false,
    nodeEnv: cleanEvidence(input?.nodeEnv) ?? env.NODE_ENV,
    appEnv: cleanEvidence(input?.appEnv) ?? env.APP_ENV
  };
}

function evidenceFor(template: RequirementTemplate, input: W3ActivationGateInput) {
  const direct = cleanEvidence(input.evidenceRefs?.[template.code]);
  if (direct) return direct;
  return template.evidenceFrom ? cleanEvidence(input.approvals?.[template.evidenceFrom]) : undefined;
}

function isRelevant(template: RequirementTemplate, targetMode: W3ActivationTargetMode) {
  if (template.documentedByDefault) return true;
  if (targetMode === "preview_only") return false;
  return template.modes.includes(targetMode);
}

function requirementStatus(template: RequirementTemplate, targetMode: W3ActivationTargetMode, input: W3ActivationGateInput): W3ActivationRequirement {
  const { evidenceFrom: _evidenceFrom, modes: _modes, documentedByDefault: _documentedByDefault, ...base } = template;
  if (template.documentedByDefault) return { ...base, status: "documented" };
  if (!isRelevant(template, targetMode)) return { ...base, status: "not_applicable" };
  const evidenceRef = evidenceFor(template, input);
  return {
    ...base,
    status: evidenceRef ? "documented" : "missing",
    ...(evidenceRef ? { evidenceRef } : {})
  };
}

function buildRequirements(templates: RequirementTemplate[], targetMode: W3ActivationTargetMode, input: W3ActivationGateInput) {
  return templates.map((template) => requirementStatus(template, targetMode, input));
}

function missingRequirementIssues(checklist: W3ActivationChecklist) {
  return [
    ...checklist.legal,
    ...checklist.accounting,
    ...checklist.paymentPartner,
    ...checklist.lendingPartner,
    ...checklist.banking,
    ...checklist.operations,
    ...checklist.owner,
    ...checklist.postActivationControls
  ]
    .filter((requirement) => requirement.status === "missing")
    .map((requirement) => `MISSING_${requirement.code}`);
}

function technicalIssues(checklist: W3ActivationChecklist) {
  return checklist.technical
    .filter((requirement) => requirement.status !== "documented")
    .map((requirement) => `MISSING_${requirement.code}`);
}

function hasFullEvidence(input: W3ActivationGateInput, targetMode: W3ActivationTargetMode) {
  const checklist: W3ActivationChecklist = {
    legal: buildRequirements(legalRequirements, targetMode, input),
    accounting: buildRequirements(accountingRequirements, targetMode, input),
    paymentPartner: buildRequirements(paymentPartnerRequirements, targetMode, input),
    lendingPartner: buildRequirements(lendingPartnerRequirements, targetMode, input),
    banking: buildRequirements(bankingRequirements, targetMode, input),
    operations: buildRequirements(operationsRequirements, targetMode, input),
    technical: buildRequirements(technicalRequirements, targetMode, input),
    owner: buildRequirements(ownerRequirements, targetMode, input),
    postActivationControls: buildRequirements(postActivationControlRequirements, targetMode, input)
  };
  return missingRequirementIssues(checklist).length === 0 && technicalIssues(checklist).length === 0;
}

function runtimeWarnings(runtime: Runtime) {
  const warnings: string[] = [];
  if (runtime.walletW3Enabled) warnings.push("WALLET_W3_ENABLED_TRUE");
  if (runtime.nodeEnv === "production" || ["production", "staging", "live"].includes(runtime.appEnv)) {
    warnings.push("LIVE_RUNTIME_REQUIRES_FINAL_REVIEW");
  }
  warnings.push("W3_MODE_REMAINS_PREVIEW_ONLY_UNTIL_OWNER_APPROVAL");
  return warnings;
}

function unsafeRuntimeIssues(runtime: Runtime, targetMode: W3ActivationTargetMode, input: W3ActivationGateInput) {
  const fullTargetEvidence = targetMode === "preview_only"
    ? hasFullEvidence(input, "full_w3")
    : targetMode === "full_w3"
      ? hasFullEvidence(input, "full_w3")
      : hasFullEvidence(input, "full_w3") || hasFullEvidence(input, targetMode);
  if (fullTargetEvidence) return [];

  const issues: string[] = [];
  if (runtime.walletW3Enabled) issues.push("WALLET_W3_FLAG_REQUIRES_FULL_APPROVAL");
  if (runtime.checkoutSettlementEnabled) issues.push("CHECKOUT_SETTLEMENT_FLAG_REQUIRES_FULL_APPROVAL");
  if (runtime.paymentCaptureEnabled) issues.push("PAYMENT_CAPTURE_FLAG_REQUIRES_FULL_APPROVAL");
  if (runtime.payoutExecutionEnabled) issues.push("PAYOUT_EXECUTION_FLAG_REQUIRES_FULL_APPROVAL");
  if (runtime.earlyCodFundingEnabled) issues.push("EARLY_COD_FUNDING_FLAG_REQUIRES_FULL_APPROVAL");
  if (runtime.lendingPartnerEnabled) issues.push("LENDING_PARTNER_FLAG_REQUIRES_FULL_APPROVAL");
  if (runtime.allowBankTransfer) issues.push("BANK_TRANSFER_FLAG_REQUIRES_FULL_APPROVAL");
  if (targetMode !== "preview_only" && (runtime.nodeEnv === "production" || ["production", "staging", "live"].includes(runtime.appEnv))) {
    issues.push("LIVE_RUNTIME_REQUIRES_FULL_W3_APPROVAL");
  }
  return issues;
}

export class W3ActivationGateService {
  getW3ActivationGateStatus(input: W3ActivationGateInput = {}): W3ActivationGateStatus {
    const targetMode = input.targetMode ?? "preview_only";
    const runtime = runtimeFromEnv(input.runtime);
    const checklist: W3ActivationChecklist = {
      legal: buildRequirements(legalRequirements, targetMode, input),
      accounting: buildRequirements(accountingRequirements, targetMode, input),
      paymentPartner: buildRequirements(paymentPartnerRequirements, targetMode, input),
      lendingPartner: buildRequirements(lendingPartnerRequirements, targetMode, input),
      banking: buildRequirements(bankingRequirements, targetMode, input),
      operations: buildRequirements(operationsRequirements, targetMode, input),
      technical: buildRequirements(technicalRequirements, targetMode, input),
      owner: buildRequirements(ownerRequirements, targetMode, input),
      postActivationControls: buildRequirements(postActivationControlRequirements, targetMode, input)
    };

    const blockingIssues = targetMode === "preview_only"
      ? [...technicalIssues(checklist), ...unsafeRuntimeIssues(runtime, targetMode, input)]
      : [
        ...technicalIssues(checklist),
        ...missingRequirementIssues(checklist),
        ...unsafeRuntimeIssues(runtime, targetMode, input)
      ];
    const status = targetMode === "preview_only"
      ? blockingIssues.length === 0 ? "preview_only" : "blocked"
      : blockingIssues.length === 0 ? "review_ready" : "blocked";

    return {
      ok: status !== "blocked",
      targetMode,
      status,
      blockingIssues,
      warnings: runtimeWarnings(runtime),
      checklist
    };
  }
}

export const w3ActivationGateService = new W3ActivationGateService();
export const getW3ActivationGateStatus = (input?: W3ActivationGateInput) => w3ActivationGateService.getW3ActivationGateStatus(input);
