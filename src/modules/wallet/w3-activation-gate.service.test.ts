import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { W3ActivationGateService, type W3ActivationTargetMode } from "./w3-activation-gate.service.js";

const checkoutEvidenceCodes = [
  "CHECKOUT_SETTLEMENT_POSITION_SIGNOFF",
  "PAYMENT_AGGREGATOR_POSITION_SIGNOFF",
  "SELLER_DISCLOSURE_TERMS_SIGNOFF",
  "GRIEVANCE_AND_DISPUTE_SOP_SIGNOFF",
  "CHECKOUT_SETTLEMENT_ACCOUNTING_SIGNOFF",
  "GST_PLATFORM_FEE_TREATMENT_SIGNOFF",
  "TDS_PAYMENT_AND_COURIER_TREATMENT_SIGNOFF",
  "PRINCIPAL_VS_AGENT_SIGNOFF",
  "REFUND_AND_REVERSAL_TREATMENT_SIGNOFF",
  "PAYMENT_PARTNER_APPROVAL",
  "PAYMENT_CAPTURE_FLOW_APPROVAL",
  "SPLIT_SETTLEMENT_OR_ROUTING_APPROVAL",
  "REFUND_FLOW_APPROVAL",
  "WEBHOOK_RECONCILIATION_APPROVAL",
  "BANKING_PARTNER_APPROVAL",
  "SETTLEMENT_ACCOUNT_REVIEW",
  "PAYOUT_FILE_CONTROL_REVIEW",
  "RECONCILIATION_ACCOUNT_REVIEW",
  "CHECKOUT_RECONCILIATION_SOP",
  "PAYMENT_FAILURE_SOP",
  "REFUND_REVERSAL_SOP",
  "SUPPORT_ESCALATION_SOP",
  "AUDIT_EXPORT_SOP",
  "OWNER_W3_MODE_APPROVAL",
  "PILOT_LIMIT_APPROVAL",
  "ROLLBACK_PLAN_APPROVAL",
  "INCIDENT_RESPONSE_APPROVAL",
  "DAILY_RECONCILIATION_REQUIRED",
  "LEDGER_EXCEPTION_REVIEW_REQUIRED",
  "WEBHOOK_REPLAY_CONTROL_REQUIRED",
  "PARTNER_STATEMENT_MATCH_REQUIRED",
  "MANUAL_HOLD_AND_FREEZE_CONTROL_REQUIRED"
];

const earlyCodEvidenceCodes = [
  "EARLY_COD_PARTNER_POSITION_SIGNOFF",
  "DIGITAL_LENDING_POSITION_SIGNOFF",
  "SELLER_DISCLOSURE_TERMS_SIGNOFF",
  "GRIEVANCE_AND_DISPUTE_SOP_SIGNOFF",
  "EARLY_COD_ACCOUNTING_SIGNOFF",
  "GST_PLATFORM_FEE_TREATMENT_SIGNOFF",
  "TDS_PAYMENT_AND_COURIER_TREATMENT_SIGNOFF",
  "PRINCIPAL_VS_AGENT_SIGNOFF",
  "LENDING_PARTNER_APPROVAL",
  "LENDER_OF_RECORD_CONFIRMATION",
  "FUND_FLOW_NO_SHIPMASTR_CUSTODY_CONFIRMATION",
  "KFS_AND_DISCLOSURE_OWNER_CONFIRMATION",
  "REPAYMENT_FLOW_REVIEW",
  "COLLECTIONS_AND_GRIEVANCE_REVIEW",
  "BANKING_PARTNER_APPROVAL",
  "SETTLEMENT_ACCOUNT_REVIEW",
  "PAYOUT_FILE_CONTROL_REVIEW",
  "RECONCILIATION_ACCOUNT_REVIEW",
  "EARLY_COD_EXCEPTION_SOP",
  "PARTNER_RECONCILIATION_SOP",
  "SUPPORT_ESCALATION_SOP",
  "AUDIT_EXPORT_SOP",
  "OWNER_W3_MODE_APPROVAL",
  "PILOT_LIMIT_APPROVAL",
  "ROLLBACK_PLAN_APPROVAL",
  "INCIDENT_RESPONSE_APPROVAL",
  "DAILY_RECONCILIATION_REQUIRED",
  "LEDGER_EXCEPTION_REVIEW_REQUIRED",
  "WEBHOOK_REPLAY_CONTROL_REQUIRED",
  "PARTNER_STATEMENT_MATCH_REQUIRED",
  "MANUAL_HOLD_AND_FREEZE_CONTROL_REQUIRED"
];

function evidence(codes: string[]) {
  return Object.fromEntries([...new Set(codes)].map((code) => [code, `evidence:${code.toLowerCase()}`]));
}

function checkoutEvidence() {
  return evidence(checkoutEvidenceCodes);
}

function earlyCodEvidence() {
  return evidence(earlyCodEvidenceCodes);
}

function fullEvidence() {
  return evidence([...checkoutEvidenceCodes, ...earlyCodEvidenceCodes]);
}

function reportForTargetWithout(targetMode: W3ActivationTargetMode, code: string) {
  const evidenceRefs = targetMode === "early_cod_partner" ? earlyCodEvidence() : checkoutEvidence();
  delete evidenceRefs[code];
  return new W3ActivationGateService().getW3ActivationGateStatus({
    targetMode,
    evidenceRefs,
    runtime: { appEnv: "development", nodeEnv: "test" }
  });
}

function sourceText() {
  return [
    readFileSync("src/modules/wallet/w3-activation-gate.service.ts", "utf8"),
    readFileSync("scripts/wallet-w3d-activation-gate.mjs", "utf8")
  ].join("\n");
}

describe("W3D final activation gate", () => {
  it("defaults to preview-only and is not live-ready", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus();

    assert.equal(report.ok, true);
    assert.equal(report.targetMode, "preview_only");
    assert.equal(report.status, "preview_only");
    assert.equal(report.checklist.technical.every((item) => item.status === "documented"), true);
    assert.ok(report.warnings.includes("W3_MODE_REMAINS_PREVIEW_ONLY_UNTIL_OWNER_APPROVAL"));
  });

  it("blocks checkout settlement when legal signoff is missing", () => {
    const report = reportForTargetWithout("checkout_settlement", "CHECKOUT_SETTLEMENT_POSITION_SIGNOFF");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_CHECKOUT_SETTLEMENT_POSITION_SIGNOFF"));
  });

  it("blocks checkout settlement when payment partner approval is missing", () => {
    const report = reportForTargetWithout("checkout_settlement", "PAYMENT_PARTNER_APPROVAL");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_PAYMENT_PARTNER_APPROVAL"));
  });

  it("blocks checkout settlement when accounting signoff is missing", () => {
    const report = reportForTargetWithout("checkout_settlement", "CHECKOUT_SETTLEMENT_ACCOUNTING_SIGNOFF");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_CHECKOUT_SETTLEMENT_ACCOUNTING_SIGNOFF"));
  });

  it("blocks checkout settlement when operations SOP is missing", () => {
    const report = reportForTargetWithout("checkout_settlement", "CHECKOUT_RECONCILIATION_SOP");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_CHECKOUT_RECONCILIATION_SOP"));
  });

  it("blocks checkout settlement when owner approval is missing", () => {
    const report = reportForTargetWithout("checkout_settlement", "OWNER_W3_MODE_APPROVAL");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_OWNER_W3_MODE_APPROVAL"));
  });

  it("blocks early COD partner target when partner approval is missing", () => {
    const report = reportForTargetWithout("early_cod_partner", "LENDING_PARTNER_APPROVAL");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_LENDING_PARTNER_APPROVAL"));
  });

  it("blocks early COD partner target when digital credit review evidence is missing", () => {
    const report = reportForTargetWithout("early_cod_partner", "DIGITAL_LENDING_POSITION_SIGNOFF");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_DIGITAL_LENDING_POSITION_SIGNOFF"));
  });

  it("blocks full W3 unless both evidence sets are complete", () => {
    const checkoutOnly = new W3ActivationGateService().getW3ActivationGateStatus({
      targetMode: "full_w3",
      evidenceRefs: checkoutEvidence(),
      runtime: { appEnv: "development", nodeEnv: "test" }
    });
    const earlyOnly = new W3ActivationGateService().getW3ActivationGateStatus({
      targetMode: "full_w3",
      evidenceRefs: earlyCodEvidence(),
      runtime: { appEnv: "development", nodeEnv: "test" }
    });

    assert.equal(checkoutOnly.status, "blocked");
    assert.ok(checkoutOnly.blockingIssues.includes("MISSING_EARLY_COD_PARTNER_POSITION_SIGNOFF"));
    assert.equal(earlyOnly.status, "blocked");
    assert.ok(earlyOnly.blockingIssues.includes("MISSING_CHECKOUT_SETTLEMENT_POSITION_SIGNOFF"));
  });

  it("runtime paymentCaptureEnabled blocks without full evidence", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus({
      runtime: { appEnv: "development", nodeEnv: "test", paymentCaptureEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("PAYMENT_CAPTURE_FLAG_REQUIRES_FULL_APPROVAL"));
  });

  it("runtime checkoutSettlementEnabled blocks without full evidence", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus({
      runtime: { appEnv: "development", nodeEnv: "test", checkoutSettlementEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("CHECKOUT_SETTLEMENT_FLAG_REQUIRES_FULL_APPROVAL"));
  });

  it("runtime payoutExecutionEnabled blocks without full evidence", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus({
      runtime: { appEnv: "development", nodeEnv: "test", payoutExecutionEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("PAYOUT_EXECUTION_FLAG_REQUIRES_FULL_APPROVAL"));
  });

  it("runtime earlyCodFundingEnabled blocks without full evidence", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus({
      runtime: { appEnv: "development", nodeEnv: "test", earlyCodFundingEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("EARLY_COD_FUNDING_FLAG_REQUIRES_FULL_APPROVAL"));
  });

  it("runtime lendingPartnerEnabled blocks without full evidence", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus({
      runtime: { appEnv: "development", nodeEnv: "test", lendingPartnerEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("LENDING_PARTNER_FLAG_REQUIRES_FULL_APPROVAL"));
  });

  it("runtime allowBankTransfer blocks without full evidence", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus({
      runtime: { appEnv: "development", nodeEnv: "test", allowBankTransfer: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("BANK_TRANSFER_FLAG_REQUIRES_FULL_APPROVAL"));
  });

  it("with full checkout evidence, checkout target returns review_ready but does not mutate config", () => {
    const before = process.env.WALLET_W3_ENABLED;
    const report = new W3ActivationGateService().getW3ActivationGateStatus({
      targetMode: "checkout_settlement",
      evidenceRefs: checkoutEvidence(),
      runtime: {
        appEnv: "production",
        nodeEnv: "production",
        checkoutSettlementEnabled: true,
        paymentCaptureEnabled: true,
        payoutExecutionEnabled: true,
        allowBankTransfer: true
      }
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "review_ready");
    assert.equal(process.env.WALLET_W3_ENABLED, before);
    assert.ok(report.warnings.includes("LIVE_RUNTIME_REQUIRES_FINAL_REVIEW"));
  });

  it("with full early COD evidence, early COD target returns review_ready but does not mutate config", () => {
    const before = process.env.WALLET_W3_ENABLED;
    const report = new W3ActivationGateService().getW3ActivationGateStatus({
      targetMode: "early_cod_partner",
      evidenceRefs: earlyCodEvidence(),
      runtime: {
        appEnv: "production",
        nodeEnv: "production",
        earlyCodFundingEnabled: true,
        lendingPartnerEnabled: true,
        allowBankTransfer: true
      }
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "review_ready");
    assert.equal(process.env.WALLET_W3_ENABLED, before);
    assert.ok(report.warnings.includes("LIVE_RUNTIME_REQUIRES_FINAL_REVIEW"));
  });

  it("with full W3 evidence, full_w3 returns review_ready but does not mutate config", () => {
    const before = process.env.WALLET_W3_ENABLED;
    const report = new W3ActivationGateService().getW3ActivationGateStatus({
      targetMode: "full_w3",
      evidenceRefs: fullEvidence(),
      runtime: {
        appEnv: "production",
        nodeEnv: "production",
        walletW3Enabled: true,
        checkoutSettlementEnabled: true,
        paymentCaptureEnabled: true,
        payoutExecutionEnabled: true,
        earlyCodFundingEnabled: true,
        lendingPartnerEnabled: true,
        allowBankTransfer: true
      }
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "review_ready");
    assert.equal(process.env.WALLET_W3_ENABLED, before);
  });

  it("technical checklist confirms W3A, W3B, and W3C preview-only state", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus();
    const documentedCodes = new Set(report.checklist.technical.filter((item) => item.status === "documented").map((item) => item.code));

    assert.equal(documentedCodes.has("W3A_PREVIEW_ONLY_CONFIRMED"), true);
    assert.equal(documentedCodes.has("W3B_READ_EXPORT_ONLY_CONFIRMED"), true);
    assert.equal(documentedCodes.has("W3C_PREQUALIFICATION_ONLY_CONFIRMED"), true);
  });

  it("technical checklist confirms no public mutating W3 seller routes", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus();
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const documentedCodes = new Set(report.checklist.technical.filter((item) => item.status === "documented").map((item) => item.code));

    assert.equal(documentedCodes.has("NO_PUBLIC_MUTATING_SELLER_W3_API"), true);
    assert.doesNotMatch(routes, /\/seller\/wallet\/w3\/.+\/approve/u);
    assert.doesNotMatch(routes, /\/seller\/wallet\/w3\/.+\/accept/u);
  });

  it("technical checklist confirms no capture, settlement, payout, or early COD execution routes", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus();
    const documentedCodes = new Set(report.checklist.technical.filter((item) => item.status === "documented").map((item) => item.code));

    assert.equal(documentedCodes.has("NO_PAYMENT_CAPTURE_ROUTE"), true);
    assert.equal(documentedCodes.has("NO_SETTLEMENT_EXECUTION_ROUTE"), true);
    assert.equal(documentedCodes.has("NO_PAYOUT_EXECUTION_ROUTE"), true);
    assert.equal(documentedCodes.has("NO_LENDING_EXECUTION_ROUTE"), true);
  });

  it("technical checklist confirms no partner API calls", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus();
    const documentedCodes = new Set(report.checklist.technical.filter((item) => item.status === "documented").map((item) => item.code));

    assert.equal(documentedCodes.has("NO_PARTNER_API_CALLS"), true);
  });

  it("technical checklist confirms no seller shipping balance credit", () => {
    const report = new W3ActivationGateService().getW3ActivationGateStatus();
    const documentedCodes = new Set(report.checklist.technical.filter((item) => item.status === "documented").map((item) => item.code));
    const source = sourceText();

    assert.equal(documentedCodes.has("NO_SELLER_SHIPPING_BALANCE_CREDIT"), true);
    assert.equal(source.includes(["shipping", "balance"].join("_")), false);
  });

  it("CLI is read-only and does not write DB", () => {
    const script = readFileSync("scripts/wallet-w3d-activation-gate.mjs", "utf8");
    const writePattern = /prisma|walletOwner|walletAccount|journalEntry|journalPosting|accountBalance|walletHold|postEntry/u;

    assert.equal(writePattern.test(script), false);
    assert.match(script, /W3D_READ_ONLY_NO_EXECUTE/u);
  });

  it("does not directly write journal tables", () => {
    const source = sourceText();
    const directWritePattern = new RegExp([
      ["journalEntry", "create"].join("\\."),
      ["journalPosting", "create"].join("\\."),
      ["accountBalance", "update"].join("\\."),
      ["walletEventOutbox", "create"].join("\\.")
    ].join("|"), "u");

    assert.equal(directWritePattern.test(source), false);
  });

  it("does not use floats in W3D path", () => {
    const source = sourceText();
    const floatPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "round"].join("\\."),
      ["Num", "ber\\("].join("")
    ].join("|"), "u");

    assert.equal(floatPattern.test(source), false);
  });

  it("does not call live providers, banks, partner networks, orchestration, GCP, or hosted runtime hooks", () => {
    const source = sourceText();
    const liveIntegrationPattern = new RegExp([
      ["razor", "pay"].join(""),
      ["cash", "free"].join(""),
      ["bank", "payout"].join(" "),
      ["settlement", "api"].join(" "),
      ["n", "8", "n"].join(""),
      ["cloud", "run"].join(" "),
      ["g", "cp"].join(""),
      ["secret", "manager"].join(" "),
      ["u", "pi"].join(""),
      ["im", "ps"].join(""),
      ["ne", "ft"].join(""),
      ["n", "bfc"].join(""),
      ["len", "der"].join(""),
      ["lo", "an"].join(""),
      ["disbur", "se"].join(""),
      ["re", "pay"].join("")
    ].join("|"), "u");

    assert.equal(liveIntegrationPattern.test(source), false);
  });

  it("adds no route/controller file for W3D", () => {
    assert.equal(existsSync("src/modules/wallet/w3-activation-gate.routes.ts"), false);
  });
});
