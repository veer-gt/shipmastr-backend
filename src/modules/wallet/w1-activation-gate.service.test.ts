import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { env } from "../../config/env.js";
import { W1ActivationGateService } from "./w1-activation-gate.service.js";

const liveEvidenceCodes = [
  "CLOSED_LOOP_SCOPE_SIGNOFF",
  "NO_CASHOUT_POSITION_SIGNOFF",
  "REFUND_TO_SOURCE_SOP_SIGNOFF",
  "TERMS_AND_USER_DISCLOSURE_SIGNOFF",
  "GRIEVANCE_AND_CLOSURE_SOP_SIGNOFF",
  "GST_FREIGHT_TREATMENT_SIGNOFF",
  "GST_PLATFORM_FEE_TREATMENT_SIGNOFF",
  "TDS_COURIER_PAYMENT_TREATMENT_SIGNOFF",
  "PRINCIPAL_VS_AGENT_SIGNOFF",
  "WALLET_LIABILITY_LEDGER_TREATMENT_SIGNOFF",
  "REFUND_AND_CREDIT_NOTE_TREATMENT_SIGNOFF",
  "RECONCILIATION_SOP",
  "FAILED_TOPUP_SOP",
  "DUPLICATE_TOPUP_SOP",
  "WALLET_FREEZE_LOCK_CLOSE_SOP",
  "AUDIT_EXPORT_SOP",
  "SUPPORT_ESCALATION_SOP",
  "OWNER_LIVE_ACTIVATION_APPROVAL",
  "ROLLBACK_PLAN_APPROVAL",
  "PILOT_LIMIT_APPROVAL"
];

function fullEvidence() {
  return Object.fromEntries(liveEvidenceCodes.map((code) => [code, `evidence:${code.toLowerCase()}`]));
}

describe("W1D wallet activation gate", () => {
  it("is not live-ready by default", () => {
    const report = new W1ActivationGateService().getW1ActivationGateStatus({ targetMode: "live", runtime: { appEnv: "development", nodeEnv: "test" } });

    assert.equal(report.ok, false);
    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_CLOSED_LOOP_SCOPE_SIGNOFF"));
  });

  it("returns sandbox-only state without live approvals", () => {
    const report = new W1ActivationGateService().getW1ActivationGateStatus({ targetMode: "sandbox" });

    assert.equal(report.ok, true);
    assert.equal(report.status, "sandbox_only");
    assert.equal(report.checklist.legal.every((item) => item.status === "not_applicable"), true);
    assert.equal(report.checklist.technical.every((item) => item.status === "documented"), true);
  });

  it("blocks live target when counsel signoff is missing", () => {
    const evidenceRefs = fullEvidence();
    delete evidenceRefs.CLOSED_LOOP_SCOPE_SIGNOFF;
    const report = new W1ActivationGateService().getW1ActivationGateStatus({ targetMode: "live", evidenceRefs, runtime: { appEnv: "development", nodeEnv: "test" } });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_CLOSED_LOOP_SCOPE_SIGNOFF"));
  });

  it("blocks live target when accountant signoff is missing", () => {
    const evidenceRefs = fullEvidence();
    delete evidenceRefs.GST_FREIGHT_TREATMENT_SIGNOFF;
    const report = new W1ActivationGateService().getW1ActivationGateStatus({ targetMode: "live", evidenceRefs, runtime: { appEnv: "development", nodeEnv: "test" } });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_GST_FREIGHT_TREATMENT_SIGNOFF"));
  });

  it("blocks live target when owner approval is missing", () => {
    const evidenceRefs = fullEvidence();
    delete evidenceRefs.OWNER_LIVE_ACTIVATION_APPROVAL;
    const report = new W1ActivationGateService().getW1ActivationGateStatus({ targetMode: "live", evidenceRefs, runtime: { appEnv: "development", nodeEnv: "test" } });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_OWNER_LIVE_ACTIVATION_APPROVAL"));
  });

  it("blocks live target when operations SOP evidence is missing", () => {
    const evidenceRefs = fullEvidence();
    delete evidenceRefs.RECONCILIATION_SOP;
    const report = new W1ActivationGateService().getW1ActivationGateStatus({ targetMode: "live", evidenceRefs, runtime: { appEnv: "development", nodeEnv: "test" } });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("MISSING_RECONCILIATION_SOP"));
  });

  it("blocks unsafe cashout flag without full live approval", () => {
    const report = new W1ActivationGateService().getW1ActivationGateStatus({
      targetMode: "live",
      runtime: { appEnv: "development", nodeEnv: "test", allowCashout: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("CASHOUT_FLAG_REQUIRES_FULL_APPROVAL"));
  });

  it("blocks unsafe live-payment flag without full live approval", () => {
    const report = new W1ActivationGateService().getW1ActivationGateStatus({
      targetMode: "live",
      runtime: { appEnv: "development", nodeEnv: "test", allowLivePayments: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("LIVE_PAYMENT_FLAG_REQUIRES_FULL_APPROVAL"));
  });

  it("returns review-ready with full evidence without mutating env", () => {
    const before = process.env.WALLET_W1_ENABLED;
    const report = new W1ActivationGateService().getW1ActivationGateStatus({
      targetMode: "live",
      evidenceRefs: fullEvidence(),
      runtime: { appEnv: "production", nodeEnv: "production", allowLivePayments: true, allowCashout: true }
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "review_ready");
    assert.equal(process.env.WALLET_W1_ENABLED, before);
    assert.ok(report.warnings.includes("PRODUCTION_RUNTIME_REQUIRES_FINAL_APPROVAL"));
  });

  it("keeps future W2 and W3 items blocked", () => {
    const report = new W1ActivationGateService().getW1ActivationGateStatus({
      targetMode: "live",
      evidenceRefs: fullEvidence(),
      runtime: { appEnv: "development", nodeEnv: "test" }
    });

    assert.equal(report.checklist.futureW2W3.every((item) => item.status === "blocked"), true);
  });

  it("confirms W1 flags safe defaults in config", () => {
    assert.equal(env.WALLET_W1_ENABLED, false);
    assert.equal(env.WALLET_W1_SANDBOX_ONLY, true);
    assert.equal(env.WALLET_W1_ALLOW_LIVE_PAYMENTS, false);
    assert.equal(env.WALLET_W1_ALLOW_CASHOUT, false);
    const report = new W1ActivationGateService().getW1ActivationGateStatus({ targetMode: "sandbox" });
    assert.equal(report.checklist.technical.some((item) => item.code === "W1_FLAGS_SAFE_DEFAULTS" && item.status === "documented"), true);
  });

  it("confirms W1 read and smoke files contain no public mutation methods", () => {
    const source = [
      readFileSync("src/modules/wallet/w1-wallet-read.routes.ts", "utf8"),
      readFileSync("src/modules/wallet/w1c-sandbox-smoke.service.ts", "utf8"),
      readFileSync("scripts/wallet-w1c-sandbox-smoke.mjs", "utf8")
    ].join("\n");

    assert.equal(/\.(post|put|patch|delete)\(/.test(source), false);
  });

  it("keeps W1D source free of direct writes, float conversion, and live integrations", () => {
    const source = [
      readFileSync("src/modules/wallet/w1-activation-gate.service.ts", "utf8"),
      readFileSync("scripts/wallet-w1d-activation-gate.mjs", "utf8")
    ].join("\n");
    const directWritePattern = new RegExp([
      ["journalEntry", "create"].join("\\."),
      ["journalPosting", "create"].join("\\."),
      ["accountBalance", "update"].join("\\."),
      ["walletEventOutbox", "create"].join("\\.")
    ].join("|"));
    const floatPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "round"].join("\\."),
      ["Num", "ber\\("].join("")
    ].join("|"));
    const liveIntegrationPattern = new RegExp([
      ["razor", "pay"].join(""),
      ["cash", "free"].join(""),
      ["bank", "payout"].join(" "),
      ["settlement", "api"].join(" "),
      ["n", "8", "n"].join(""),
      ["cloud", "run"].join(" ")
    ].join("|"), "i");

    assert.equal(directWritePattern.test(source), false);
    assert.equal(floatPattern.test(source), false);
    assert.equal(liveIntegrationPattern.test(source), false);
  });

  it("keeps the W1D command read-only", () => {
    const source = readFileSync("scripts/wallet-w1d-activation-gate.mjs", "utf8");
    const writePattern = /prisma|walletOwner|walletAccount|journalEntry|journalPosting|accountBalance|walletHold|walletTopupIntent|postEntry/;

    assert.equal(writePattern.test(source), false);
  });
});
