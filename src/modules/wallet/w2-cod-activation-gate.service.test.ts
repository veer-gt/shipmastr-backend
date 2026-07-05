import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { W2CodActivationGateService } from "./w2-cod-activation-gate.service.js";

const custodyEvidenceCodes = [
  "COD_INSTRUCTION_ONLY_POSITION_SIGNOFF",
  "COD_CUSTODY_POSITION_SIGNOFF",
  "COURIER_REMITTANCE_SOP_SIGNOFF",
  "SELLER_DISCLOSURE_TERMS_SIGNOFF",
  "DISPUTE_AND_GRIEVANCE_SOP_SIGNOFF",
  "COD_RECEIVABLE_TREATMENT_SIGNOFF",
  "FREIGHT_DEDUCTION_TREATMENT_SIGNOFF",
  "RTO_DEDUCTION_TREATMENT_SIGNOFF",
  "TDS_COURIER_PAYMENT_TREATMENT_SIGNOFF",
  "GST_COD_FEE_TREATMENT_SIGNOFF",
  "PRINCIPAL_VS_AGENT_SIGNOFF",
  "BANKING_PARTNER_COD_COLLECTION_APPROVAL",
  "NODAL_OR_ESCROW_STRUCTURE_REVIEW",
  "SETTLEMENT_ACCOUNT_REVIEW",
  "PAYOUT_FILE_CONTROL_REVIEW",
  "COD_RECONCILIATION_SOP",
  "COURIER_REMITTANCE_EXCEPTION_SOP",
  "SELLER_NEGATIVE_NET_SOP",
  "DUPLICATE_REMITTANCE_SOP",
  "AUDIT_EXPORT_SOP",
  "SUPPORT_ESCALATION_SOP",
  "OWNER_W2_MODE_APPROVAL",
  "PILOT_LIMIT_APPROVAL",
  "ROLLBACK_PLAN_APPROVAL"
];

function fullEvidence() {
  return Object.fromEntries(custodyEvidenceCodes.map((code) => [code, `evidence:${code.toLowerCase()}`]));
}

function reportForCustodyWithout(code: string) {
  const evidenceRefs = fullEvidence();
  delete evidenceRefs[code];
  return new W2CodActivationGateService().getW2CodActivationGateStatus({
    targetMode: "custody",
    evidenceRefs,
    runtime: { appEnv: "development", nodeEnv: "test" }
  });
}

function sourceText() {
  return [
    readFileSync("src/modules/wallet/w2-cod-activation-gate.service.ts", "utf8"),
    readFileSync("scripts/wallet-w2d-cod-activation-gate.mjs", "utf8")
  ].join("\n");
}

describe("W2D COD activation gate", () => {
  it("defaults to instruction-only and is not custody-ready", () => {
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus();

    assert.equal(report.ok, true);
    assert.equal(report.targetMode, "instruction_only");
    assert.equal(report.status, "instruction_only");
    assert.ok(report.warnings.includes("W2_MODE_LOCKED_TO_INSTRUCTION_ONLY_UNTIL_REVIEW"));
    assert.equal(report.checklist.technical.every((item) => item.status === "documented"), true);
  });

  it("warns but does not block instruction-only reports in live-like runtime", () => {
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus({
      runtime: { appEnv: "production", nodeEnv: "production" }
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "instruction_only");
    assert.ok(report.warnings.includes("LIVE_RUNTIME_REQUIRES_FINAL_REVIEW"));
    assert.equal(report.blockingIssues.includes("LIVE_RUNTIME_REQUIRES_FULL_W2_APPROVAL"), false);
  });

  it("blocks custody review in live-like runtime without full evidence", () => {
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus({
      targetMode: "custody",
      runtime: { appEnv: "staging", nodeEnv: "test" }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("LIVE_RUNTIME_REQUIRES_FULL_W2_APPROVAL"));
  });

  it("blocks custody when legal signoff is missing", () => {
    const report = reportForCustodyWithout("COD_CUSTODY_POSITION_SIGNOFF");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_COD_CUSTODY_POSITION_SIGNOFF"));
  });

  it("blocks custody when accounting signoff is missing", () => {
    const report = reportForCustodyWithout("COD_RECEIVABLE_TREATMENT_SIGNOFF");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_COD_RECEIVABLE_TREATMENT_SIGNOFF"));
  });

  it("blocks custody when banking approval is missing", () => {
    const report = reportForCustodyWithout("BANKING_PARTNER_COD_COLLECTION_APPROVAL");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_BANKING_PARTNER_COD_COLLECTION_APPROVAL"));
  });

  it("blocks custody when operations SOP is missing", () => {
    const report = reportForCustodyWithout("COD_RECONCILIATION_SOP");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_COD_RECONCILIATION_SOP"));
  });

  it("blocks custody when owner approval is missing", () => {
    const report = reportForCustodyWithout("OWNER_W2_MODE_APPROVAL");

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_OWNER_W2_MODE_APPROVAL"));
  });

  it("blocks unsafe custody flag without full evidence", () => {
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus({
      runtime: { appEnv: "development", nodeEnv: "test", codCustodyEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("COD_CUSTODY_FLAG_REQUIRES_FULL_APPROVAL"));
  });

  it("blocks unsafe payout execution flag without full evidence", () => {
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus({
      runtime: { appEnv: "development", nodeEnv: "test", payoutExecutionEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("PAYOUT_EXECUTION_FLAG_REQUIRES_FULL_APPROVAL"));
  });

  it("blocks unsafe bank transfer flag without full evidence", () => {
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus({
      runtime: { appEnv: "development", nodeEnv: "test", allowBankTransfer: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("BANK_TRANSFER_FLAG_REQUIRES_FULL_APPROVAL"));
  });

  it("returns review-ready with full evidence without mutating env", () => {
    const before = process.env.WALLET_W2_ENABLED;
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus({
      targetMode: "custody",
      evidenceRefs: fullEvidence(),
      runtime: {
        appEnv: "production",
        nodeEnv: "production",
        codCustodyEnabled: true,
        payoutExecutionEnabled: true,
        allowBankTransfer: true
      }
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "review_ready");
    assert.equal(process.env.WALLET_W2_ENABLED, before);
    assert.ok(report.warnings.includes("LIVE_RUNTIME_REQUIRES_FINAL_REVIEW"));
  });

  it("keeps W3 checklist items blocked", () => {
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus({
      targetMode: "custody",
      evidenceRefs: fullEvidence(),
      runtime: { appEnv: "development", nodeEnv: "test" }
    });

    assert.equal(report.checklist.futureW3.every((item) => item.status === "blocked"), true);
  });

  it("confirms W2A, W2B, and W2C instruction-only safeguards", () => {
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus();
    const documentedCodes = new Set(report.checklist.technical.filter((item) => item.status === "documented").map((item) => item.code));

    assert.equal(documentedCodes.has("W2A_INSTRUCTION_ONLY_CONFIRMED"), true);
    assert.equal(documentedCodes.has("W2B_EXPORT_PREVIEW_ONLY_CONFIRMED"), true);
    assert.equal(documentedCodes.has("W2C_SMOKE_CONFIRMED"), true);
    assert.equal(documentedCodes.has("NO_PUBLIC_MUTATING_SELLER_W2_API"), true);
  });

  it("marks custody-only requirements not applicable in instruction-only mode", () => {
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus({
      runtime: { appEnv: "development", nodeEnv: "test" }
    });

    assert.equal(report.checklist.accounting.every((item) => item.status === "not_applicable"), true);
    assert.equal(report.checklist.banking.every((item) => item.status === "not_applicable"), true);
    assert.equal(report.checklist.operations.every((item) => item.status === "not_applicable"), true);
    assert.equal(report.checklist.owner.every((item) => item.status === "not_applicable"), true);
  });

  it("accepts approval aliases as documented custody evidence", () => {
    const evidenceRefs = fullEvidence();
    delete evidenceRefs.COD_CUSTODY_POSITION_SIGNOFF;
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus({
      targetMode: "custody",
      evidenceRefs,
      approvals: { counselCodCustodyPosition: "legal-review:cod-custody" },
      runtime: { appEnv: "development", nodeEnv: "test" }
    });
    const custodySignoff = report.checklist.legal.find((item) => item.code === "COD_CUSTODY_POSITION_SIGNOFF");

    assert.equal(custodySignoff?.status, "documented");
    assert.equal(custodySignoff?.evidenceRef, "legal-review:cod-custody");
  });

  it("confirms no public mutating seller W2 API is mounted", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const readRoutes = readFileSync("src/modules/wallet/w2-cod-netting-read.routes.ts", "utf8");
    const mutationPattern = new RegExp(["\\.", "(post|put|patch|delete)", "\\("].join(""), "u");

    assert.equal(mutationPattern.test(readRoutes), false);
    assert.doesNotMatch(routes, /\/seller\/wallet\/w2\/cod\/.+\/approve/u);
    assert.doesNotMatch(routes, /\/seller\/wallet\/w2\/cod\/.+\/pay/u);
  });

  it("confirms no payout, bank, or seller shipping-balance COD credit path in W2D", () => {
    const report = new W2CodActivationGateService().getW2CodActivationGateStatus();
    const documentedCodes = new Set(report.checklist.technical.filter((item) => item.status === "documented").map((item) => item.code));
    const source = sourceText();

    assert.equal(documentedCodes.has("NO_PAYOUT_EXECUTION_ROUTE"), true);
    assert.equal(documentedCodes.has("NO_BANK_TRANSFER_INTEGRATION"), true);
    assert.equal(documentedCodes.has("NO_SELLER_SHIPPING_BALANCE_COD_CREDIT"), true);
    assert.equal(source.includes(["shipping", "balance"].join("_")), false);
  });

  it("keeps the W2D command read-only", () => {
    const script = readFileSync("scripts/wallet-w2d-cod-activation-gate.mjs", "utf8");
    const writePattern = /prisma|walletOwner|walletAccount|journalEntry|journalPosting|accountBalance|walletHold|codNettingBatch|postEntry/u;

    assert.equal(writePattern.test(script), false);
    assert.match(script, /W2D_READ_ONLY_NO_EXECUTE/u);
  });

  it("keeps W2D source free of direct writes, float conversion, and live integrations", () => {
    const source = sourceText();
    const directWritePattern = new RegExp([
      ["journalEntry", "create"].join("\\."),
      ["journalPosting", "create"].join("\\."),
      ["accountBalance", "update"].join("\\."),
      ["walletEventOutbox", "create"].join("\\.")
    ].join("|"), "u");
    const floatPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "round"].join("\\."),
      ["Num", "ber\\("].join("")
    ].join("|"), "u");
    const liveIntegrationPattern = new RegExp([
      ["razor", "pay"].join(""),
      ["cash", "free"].join(""),
      ["bank", "payout"].join(" "),
      ["settlement", "api"].join(" "),
      ["n", "8", "n"].join(""),
      ["cloud", "run"].join(" "),
      ["u", "pi"].join(""),
      ["im", "ps"].join(""),
      ["ne", "ft"].join("")
    ].join("|"), "iu");

    assert.equal(directWritePattern.test(source), false);
    assert.equal(floatPattern.test(source), false);
    assert.equal(liveIntegrationPattern.test(source), false);
  });
});
