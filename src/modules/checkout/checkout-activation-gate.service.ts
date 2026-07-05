export type CheckoutActivationRequirementStatus = "missing" | "documented" | "not_applicable";
export type CheckoutActivationRequirementScope = "live_payments" | "technical";

export type CheckoutActivationRequirement = {
  code: string;
  title: string;
  status: CheckoutActivationRequirementStatus;
  requiredFor: CheckoutActivationRequirementScope;
  evidenceRef?: string;
};

export type CheckoutActivationChecklist = {
  legal: CheckoutActivationRequirement[];
  accounting: CheckoutActivationRequirement[];
  provider: CheckoutActivationRequirement[];
  webhook: CheckoutActivationRequirement[];
  refund: CheckoutActivationRequirement[];
  operations: CheckoutActivationRequirement[];
  owner: CheckoutActivationRequirement[];
  rollback: CheckoutActivationRequirement[];
  technical: CheckoutActivationRequirement[];
};

export type CheckoutActivationGateStatus = {
  ok: boolean;
  status: "blocked" | "review_ready";
  activationAllowed: false;
  blockingIssues: string[];
  warnings: string[];
  runtime: CheckoutActivationRuntime;
  checklist: CheckoutActivationChecklist;
};

export type CheckoutActivationRuntimeInput = {
  checkoutLivePaymentsEnabled?: boolean;
  razorpayLiveEnabled?: boolean;
  cashfreeLiveEnabled?: boolean;
  liveWebhookEnabled?: boolean;
  settlementExecutionEnabled?: boolean;
  payoutExecutionEnabled?: boolean;
  codCustodyEnabled?: boolean;
  nodeEnv?: string;
  appEnv?: string;
};

export type CheckoutActivationRuntime = Required<CheckoutActivationRuntimeInput>;

export type CheckoutActivationApprovalInput = {
  legalPaymentAggregatorPosition?: string;
  legalCheckoutTerms?: string;
  accountingPaymentTreatment?: string;
  accountingRefundTreatment?: string;
  razorpayLiveApproval?: string;
  cashfreeLiveApproval?: string;
  providerKeyHandling?: string;
  webhookSignatureVerification?: string;
  webhookReplayProtection?: string;
  webhookCrossValidation?: string;
  refundSop?: string;
  operationsReconciliationSop?: string;
  operationsSupportEscalationSop?: string;
  ownerApproval?: string;
  rollbackPlan?: string;
};

export type CheckoutActivationGateInput = {
  approvals?: CheckoutActivationApprovalInput;
  evidenceRefs?: Record<string, string | undefined>;
  runtime?: CheckoutActivationRuntimeInput;
};

type RequirementTemplate = {
  code: string;
  title: string;
  requiredFor: CheckoutActivationRequirementScope;
  evidenceFrom?: keyof CheckoutActivationApprovalInput;
  documentedByDefault?: boolean;
};

const validAppEnvValues = new Set(["development", "test", "staging", "production"]);

const legalRequirements: RequirementTemplate[] = [
  { code: "LEGAL_PAYMENT_AGGREGATOR_POSITION_SIGNOFF", title: "Payment aggregator legal position signed off", requiredFor: "live_payments", evidenceFrom: "legalPaymentAggregatorPosition" },
  { code: "LEGAL_CHECKOUT_TERMS_SIGNOFF", title: "Checkout buyer and seller terms signed off", requiredFor: "live_payments", evidenceFrom: "legalCheckoutTerms" }
];

const accountingRequirements: RequirementTemplate[] = [
  { code: "ACCOUNTING_PAYMENT_TREATMENT_SIGNOFF", title: "Payment collection accounting treatment signed off", requiredFor: "live_payments", evidenceFrom: "accountingPaymentTreatment" },
  { code: "ACCOUNTING_REFUND_TREATMENT_SIGNOFF", title: "Refund and reversal accounting treatment signed off", requiredFor: "live_payments", evidenceFrom: "accountingRefundTreatment" }
];

const providerRequirements: RequirementTemplate[] = [
  { code: "RAZORPAY_LIVE_ACCOUNT_APPROVAL", title: "Razorpay live account approval documented", requiredFor: "live_payments", evidenceFrom: "razorpayLiveApproval" },
  { code: "CASHFREE_LIVE_ACCOUNT_APPROVAL", title: "Cashfree live account approval documented", requiredFor: "live_payments", evidenceFrom: "cashfreeLiveApproval" },
  { code: "PROVIDER_LIVE_KEY_HANDLING_SIGNOFF", title: "Live key handling and rollback signoff documented", requiredFor: "live_payments", evidenceFrom: "providerKeyHandling" }
];

const webhookRequirements: RequirementTemplate[] = [
  { code: "WEBHOOK_SIGNATURE_VERIFICATION_SIGNOFF", title: "Webhook signature verification signed off", requiredFor: "live_payments", evidenceFrom: "webhookSignatureVerification" },
  { code: "WEBHOOK_REPLAY_PROTECTION_SIGNOFF", title: "Webhook replay protection signed off", requiredFor: "live_payments", evidenceFrom: "webhookReplayProtection" },
  { code: "WEBHOOK_AMOUNT_CURRENCY_ORDER_VALIDATION_SIGNOFF", title: "Webhook amount, currency, and order reference cross-validation signed off", requiredFor: "live_payments", evidenceFrom: "webhookCrossValidation" }
];

const refundRequirements: RequirementTemplate[] = [
  { code: "REFUND_REVERSAL_SOP_SIGNOFF", title: "Refund and reversal SOP signed off", requiredFor: "live_payments", evidenceFrom: "refundSop" }
];

const operationsRequirements: RequirementTemplate[] = [
  { code: "PAYMENT_RECONCILIATION_SOP_SIGNOFF", title: "Payment reconciliation SOP signed off", requiredFor: "live_payments", evidenceFrom: "operationsReconciliationSop" },
  { code: "PAYMENT_SUPPORT_ESCALATION_SOP_SIGNOFF", title: "Payment support escalation SOP signed off", requiredFor: "live_payments", evidenceFrom: "operationsSupportEscalationSop" }
];

const ownerRequirements: RequirementTemplate[] = [
  { code: "OWNER_LIVE_PAYMENT_APPROVAL", title: "Owner live payment approval documented", requiredFor: "live_payments", evidenceFrom: "ownerApproval" }
];

const rollbackRequirements: RequirementTemplate[] = [
  { code: "LIVE_PAYMENT_ROLLBACK_PLAN_SIGNOFF", title: "Live payment rollback plan signed off", requiredFor: "live_payments", evidenceFrom: "rollbackPlan" }
];

const technicalRequirements: RequirementTemplate[] = [
  { code: "NO_SETTLEMENT_EXECUTION_IN_C6", title: "No checkout settlement execution is activated by C6", requiredFor: "technical", documentedByDefault: true },
  { code: "NO_PAYOUT_EXECUTION_IN_C6", title: "No payout execution is activated by C6", requiredFor: "technical", documentedByDefault: true },
  { code: "NO_COD_CUSTODY_IN_C6", title: "No COD custody is activated by C6", requiredFor: "technical", documentedByDefault: true },
  { code: "NO_PUBLIC_ACTIVATION_API", title: "No public activation API is present", requiredFor: "technical", documentedByDefault: true },
  { code: "NO_LIVE_PROVIDER_CALLS_IN_GATE", title: "Activation gate performs no live provider calls", requiredFor: "technical", documentedByDefault: true },
  { code: "BUYER_RISK_NOTES_REMAIN_HIDDEN", title: "Buyer serializers do not expose risk notes", requiredFor: "technical", documentedByDefault: true },
  { code: "C6_READ_ONLY_GATE_NOT_ACTIVATION", title: "C6 returns readiness only and does not activate live payments", requiredFor: "technical", documentedByDefault: true }
];

function cleanEvidence(value: string | undefined) {
  const next = value?.trim();
  return next ? next : undefined;
}

function normalizeAppEnv(value: string | undefined) {
  return cleanEvidence(value)?.toLowerCase();
}

function runtimeFromInput(input?: CheckoutActivationRuntimeInput): CheckoutActivationRuntime {
  return {
    checkoutLivePaymentsEnabled: input?.checkoutLivePaymentsEnabled ?? false,
    razorpayLiveEnabled: input?.razorpayLiveEnabled ?? false,
    cashfreeLiveEnabled: input?.cashfreeLiveEnabled ?? false,
    liveWebhookEnabled: input?.liveWebhookEnabled ?? false,
    settlementExecutionEnabled: input?.settlementExecutionEnabled ?? false,
    payoutExecutionEnabled: input?.payoutExecutionEnabled ?? false,
    codCustodyEnabled: input?.codCustodyEnabled ?? false,
    nodeEnv: cleanEvidence(input?.nodeEnv) ?? process.env.NODE_ENV ?? "",
    appEnv: normalizeAppEnv(input?.appEnv) ?? normalizeAppEnv(process.env.APP_ENV) ?? ""
  };
}

function evidenceFor(template: RequirementTemplate, input: CheckoutActivationGateInput) {
  const direct = cleanEvidence(input.evidenceRefs?.[template.code]);
  if (direct) return direct;
  return template.evidenceFrom ? cleanEvidence(input.approvals?.[template.evidenceFrom]) : undefined;
}

function requirementStatus(template: RequirementTemplate, input: CheckoutActivationGateInput): CheckoutActivationRequirement {
  const { evidenceFrom: _evidenceFrom, documentedByDefault: _documentedByDefault, ...base } = template;
  if (template.documentedByDefault) return { ...base, status: "documented" };
  const evidenceRef = evidenceFor(template, input);
  return {
    ...base,
    status: evidenceRef ? "documented" : "missing",
    ...(evidenceRef ? { evidenceRef } : {})
  };
}

function buildRequirements(templates: RequirementTemplate[], input: CheckoutActivationGateInput) {
  return templates.map((template) => requirementStatus(template, input));
}

function missingRequirementIssues(checklist: CheckoutActivationChecklist) {
  return [
    ...checklist.legal,
    ...checklist.accounting,
    ...checklist.provider,
    ...checklist.webhook,
    ...checklist.refund,
    ...checklist.operations,
    ...checklist.owner,
    ...checklist.rollback
  ]
    .filter((requirement) => requirement.status === "missing")
    .map((requirement) => `MISSING_${requirement.code}`);
}

function technicalIssues(checklist: CheckoutActivationChecklist) {
  return checklist.technical
    .filter((requirement) => requirement.status !== "documented")
    .map((requirement) => `MISSING_${requirement.code}`);
}

function hasFullEvidence(checklist: CheckoutActivationChecklist) {
  return missingRequirementIssues(checklist).length === 0 && technicalIssues(checklist).length === 0;
}

function runtimeWarnings(runtime: CheckoutActivationRuntime) {
  const warnings: string[] = ["CHECKOUT_C6_READ_ONLY_GATE_NOT_ACTIVATION"];
  if (runtime.appEnv && !validAppEnvValues.has(runtime.appEnv)) {
    warnings.push("APP_ENV_UNRECOGNIZED");
  }
  if (
    runtime.checkoutLivePaymentsEnabled ||
    runtime.razorpayLiveEnabled ||
    runtime.cashfreeLiveEnabled ||
    runtime.liveWebhookEnabled ||
    runtime.nodeEnv === "production" ||
    runtime.appEnv === "staging" ||
    runtime.appEnv === "production"
  ) {
    warnings.push("LIVE_RUNTIME_REQUIRES_FINAL_OWNER_REVIEW");
  }
  if (runtime.razorpayLiveEnabled && runtime.cashfreeLiveEnabled) {
    warnings.push("MULTIPLE_LIVE_PROVIDERS_REQUIRE_PROVIDER_ORDER_REVIEW");
  }
  return warnings;
}

function unsafeRuntimeIssues(runtime: CheckoutActivationRuntime, fullEvidence: boolean) {
  const issues: string[] = [];

  if (!fullEvidence) {
    if (runtime.checkoutLivePaymentsEnabled) issues.push("CHECKOUT_LIVE_PAYMENTS_FLAG_REQUIRES_FULL_EVIDENCE");
    if (runtime.razorpayLiveEnabled) issues.push("RAZORPAY_LIVE_FLAG_REQUIRES_FULL_EVIDENCE");
    if (runtime.cashfreeLiveEnabled) issues.push("CASHFREE_LIVE_FLAG_REQUIRES_FULL_EVIDENCE");
    if (runtime.liveWebhookEnabled) issues.push("LIVE_WEBHOOK_FLAG_REQUIRES_FULL_EVIDENCE");
    if (runtime.nodeEnv === "production" || runtime.appEnv === "staging" || runtime.appEnv === "production") {
      issues.push("LIVE_RUNTIME_REQUIRES_FULL_C6_EVIDENCE");
    }
  }

  if (runtime.settlementExecutionEnabled) issues.push("SETTLEMENT_EXECUTION_NOT_IN_C6_SCOPE");
  if (runtime.payoutExecutionEnabled) issues.push("PAYOUT_EXECUTION_NOT_IN_C6_SCOPE");
  if (runtime.codCustodyEnabled) issues.push("COD_CUSTODY_NOT_IN_C6_SCOPE");

  return issues;
}

export class CheckoutActivationGateService {
  getCheckoutActivationGateStatus(input: CheckoutActivationGateInput = {}): CheckoutActivationGateStatus {
    const runtime = runtimeFromInput(input.runtime);
    const checklist: CheckoutActivationChecklist = {
      legal: buildRequirements(legalRequirements, input),
      accounting: buildRequirements(accountingRequirements, input),
      provider: buildRequirements(providerRequirements, input),
      webhook: buildRequirements(webhookRequirements, input),
      refund: buildRequirements(refundRequirements, input),
      operations: buildRequirements(operationsRequirements, input),
      owner: buildRequirements(ownerRequirements, input),
      rollback: buildRequirements(rollbackRequirements, input),
      technical: buildRequirements(technicalRequirements, input)
    };

    const fullEvidence = hasFullEvidence(checklist);
    const blockingIssues = [
      ...missingRequirementIssues(checklist),
      ...technicalIssues(checklist),
      ...unsafeRuntimeIssues(runtime, fullEvidence)
    ];
    const status = blockingIssues.length === 0 ? "review_ready" : "blocked";

    return {
      ok: status !== "blocked",
      status,
      activationAllowed: false,
      blockingIssues,
      warnings: runtimeWarnings(runtime),
      runtime,
      checklist
    };
  }
}

export const checkoutActivationGateService = new CheckoutActivationGateService();
export const getCheckoutActivationGateStatus = (input?: CheckoutActivationGateInput) => checkoutActivationGateService.getCheckoutActivationGateStatus(input);
