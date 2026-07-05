import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { CheckoutActivationGateService } from "./checkout-activation-gate.service.js";

const evidenceCodes = [
  "LEGAL_PAYMENT_AGGREGATOR_POSITION_SIGNOFF",
  "LEGAL_CHECKOUT_TERMS_SIGNOFF",
  "ACCOUNTING_PAYMENT_TREATMENT_SIGNOFF",
  "ACCOUNTING_REFUND_TREATMENT_SIGNOFF",
  "RAZORPAY_LIVE_ACCOUNT_APPROVAL",
  "CASHFREE_LIVE_ACCOUNT_APPROVAL",
  "PROVIDER_LIVE_KEY_HANDLING_SIGNOFF",
  "WEBHOOK_SIGNATURE_VERIFICATION_SIGNOFF",
  "WEBHOOK_REPLAY_PROTECTION_SIGNOFF",
  "WEBHOOK_AMOUNT_CURRENCY_ORDER_VALIDATION_SIGNOFF",
  "REFUND_REVERSAL_SOP_SIGNOFF",
  "PAYMENT_RECONCILIATION_SOP_SIGNOFF",
  "PAYMENT_SUPPORT_ESCALATION_SOP_SIGNOFF",
  "OWNER_LIVE_PAYMENT_APPROVAL",
  "LIVE_PAYMENT_ROLLBACK_PLAN_SIGNOFF"
];

function evidence() {
  return Object.fromEntries(evidenceCodes.map((code) => [code, `evidence:${code.toLowerCase()}`]));
}

function sourceText() {
  return [
    readFileSync("src/modules/checkout/checkout-activation-gate.service.ts", "utf8"),
    readFileSync("scripts/checkout-activation-gate.mjs", "utf8")
  ].join("\n");
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["scripts/checkout-activation-gate.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

function parseJson(stdout: string) {
  return JSON.parse(stdout) as {
    ok: boolean;
    status: string;
    activationAllowed: boolean;
    blockingIssues: string[];
    warnings: string[];
    runtime: Record<string, unknown>;
  };
}

describe("Checkout C6 activation gate", () => {
  it("defaults runtime live and execution booleans to false", () => {
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      runtime: { nodeEnv: "test", appEnv: "development" }
    });

    assert.equal(report.status, "blocked");
    assert.equal(report.activationAllowed, false);
    assert.equal(report.runtime.checkoutLivePaymentsEnabled, false);
    assert.equal(report.runtime.razorpayLiveEnabled, false);
    assert.equal(report.runtime.cashfreeLiveEnabled, false);
    assert.equal(report.runtime.liveWebhookEnabled, false);
    assert.equal(report.runtime.settlementExecutionEnabled, false);
    assert.equal(report.runtime.payoutExecutionEnabled, false);
    assert.equal(report.runtime.codCustodyEnabled, false);
    assert.ok(report.blockingIssues.includes("MISSING_LEGAL_PAYMENT_AGGREGATOR_POSITION_SIGNOFF"));
  });

  it("razorpay live runtime flag blocks without full evidence", () => {
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      runtime: { nodeEnv: "test", appEnv: "development", razorpayLiveEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("RAZORPAY_LIVE_FLAG_REQUIRES_FULL_EVIDENCE"));
  });

  it("cashfree live runtime flag blocks without full evidence", () => {
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      runtime: { nodeEnv: "test", appEnv: "development", cashfreeLiveEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("CASHFREE_LIVE_FLAG_REQUIRES_FULL_EVIDENCE"));
  });

  it("checkout live payments runtime flag blocks without full evidence", () => {
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      runtime: { nodeEnv: "test", appEnv: "development", checkoutLivePaymentsEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("CHECKOUT_LIVE_PAYMENTS_FLAG_REQUIRES_FULL_EVIDENCE"));
  });

  it("live webhook runtime flag blocks without full evidence", () => {
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      runtime: { nodeEnv: "test", appEnv: "development", liveWebhookEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("LIVE_WEBHOOK_FLAG_REQUIRES_FULL_EVIDENCE"));
  });

  it("settlement execution is blocked in C6", () => {
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      evidenceRefs: evidence(),
      runtime: { nodeEnv: "test", appEnv: "development", settlementExecutionEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("SETTLEMENT_EXECUTION_NOT_IN_C6_SCOPE"));
  });

  it("payout execution is blocked in C6", () => {
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      evidenceRefs: evidence(),
      runtime: { nodeEnv: "test", appEnv: "development", payoutExecutionEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("PAYOUT_EXECUTION_NOT_IN_C6_SCOPE"));
  });

  it("COD custody is blocked in C6", () => {
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      evidenceRefs: evidence(),
      runtime: { nodeEnv: "test", appEnv: "development", codCustodyEnabled: true }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("COD_CUSTODY_NOT_IN_C6_SCOPE"));
  });

  it("appEnv staging blocks live activation without full evidence", () => {
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      runtime: { nodeEnv: "test", appEnv: "staging" }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("LIVE_RUNTIME_REQUIRES_FULL_C6_EVIDENCE"));
  });

  it("appEnv production blocks live activation without full evidence", () => {
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      runtime: { nodeEnv: "test", appEnv: "production" }
    });

    assert.equal(report.status, "blocked");
    assert.ok(report.blockingIssues.includes("LIVE_RUNTIME_REQUIRES_FULL_C6_EVIDENCE"));
  });

  it("appEnv live is not treated as a valid APP_ENV value", () => {
    const invalidAppEnv = ["li", "ve"].join("");
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      evidenceRefs: evidence(),
      runtime: { nodeEnv: "test", appEnv: invalidAppEnv }
    });

    assert.equal(report.status, "review_ready");
    assert.equal(report.activationAllowed, false);
    assert.ok(report.warnings.includes("APP_ENV_UNRECOGNIZED"));
    assert.equal(report.blockingIssues.includes("LIVE_RUNTIME_REQUIRES_FULL_C6_EVIDENCE"), false);
  });

  it("complete evidence returns review-ready but never activation", () => {
    const before = process.env.CHECKOUT_LIVE_PAYMENTS_ENABLED;
    const report = new CheckoutActivationGateService().getCheckoutActivationGateStatus({
      evidenceRefs: evidence(),
      runtime: {
        nodeEnv: "production",
        appEnv: "production",
        checkoutLivePaymentsEnabled: true,
        razorpayLiveEnabled: true,
        liveWebhookEnabled: true
      }
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "review_ready");
    assert.equal(report.activationAllowed, false);
    assert.equal(process.env.CHECKOUT_LIVE_PAYMENTS_ENABLED, before);
  });

  it("CLI populates runtime booleans from explicit flags", () => {
    const result = runCli(["--json", "--razorpay-live-enabled", "--node-env", "test", "--app-env", "development"]);

    assert.equal(result.status, 0);
    const report = parseJson(result.stdout);
    assert.equal(report.runtime.razorpayLiveEnabled, true);
    assert.equal(report.runtime.cashfreeLiveEnabled, false);
    assert.ok(report.blockingIssues.includes("RAZORPAY_LIVE_FLAG_REQUIRES_FULL_EVIDENCE"));
  });

  it("CLI cashfree and checkout live flags block without full evidence", () => {
    const result = runCli(["--json", "--checkout-live-payments-enabled", "--cashfree-live-enabled", "--node-env", "test", "--app-env", "development"]);

    assert.equal(result.status, 0);
    const report = parseJson(result.stdout);
    assert.equal(report.runtime.checkoutLivePaymentsEnabled, true);
    assert.equal(report.runtime.cashfreeLiveEnabled, true);
    assert.ok(report.blockingIssues.includes("CHECKOUT_LIVE_PAYMENTS_FLAG_REQUIRES_FULL_EVIDENCE"));
    assert.ok(report.blockingIssues.includes("CASHFREE_LIVE_FLAG_REQUIRES_FULL_EVIDENCE"));
  });

  it("CLI live webhook and execution flags are explicit and blocked", () => {
    const result = runCli([
      "--json",
      "--live-webhook-enabled",
      "--settlement-execution-enabled",
      "--payout-execution-enabled",
      "--cod-custody-enabled",
      "--node-env",
      "test",
      "--app-env",
      "development"
    ]);

    assert.equal(result.status, 0);
    const report = parseJson(result.stdout);
    assert.equal(report.runtime.liveWebhookEnabled, true);
    assert.equal(report.runtime.settlementExecutionEnabled, true);
    assert.equal(report.runtime.payoutExecutionEnabled, true);
    assert.equal(report.runtime.codCustodyEnabled, true);
    assert.ok(report.blockingIssues.includes("LIVE_WEBHOOK_FLAG_REQUIRES_FULL_EVIDENCE"));
    assert.ok(report.blockingIssues.includes("SETTLEMENT_EXECUTION_NOT_IN_C6_SCOPE"));
    assert.ok(report.blockingIssues.includes("PAYOUT_EXECUTION_NOT_IN_C6_SCOPE"));
    assert.ok(report.blockingIssues.includes("COD_CUSTODY_NOT_IN_C6_SCOPE"));
  });

  it("CLI rejects execute with CHECKOUT_C6_READ_ONLY_NO_EXECUTE", () => {
    const result = runCli(["--execute"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CHECKOUT_C6_READ_ONLY_NO_EXECUTE/u);
  });

  it("does not add runtime flags to env config or auto-read guessed env var names", () => {
    const envSource = readFileSync("src/config/env.ts", "utf8");
    const serviceSource = readFileSync("src/modules/checkout/checkout-activation-gate.service.ts", "utf8");
    const forbiddenConfig = /checkoutLivePaymentsEnabled|razorpayLiveEnabled|cashfreeLiveEnabled|liveWebhookEnabled|settlementExecutionEnabled|payoutExecutionEnabled|codCustodyEnabled/u;
    const guessedEnvNames = /CHECKOUT_LIVE_PAYMENTS_ENABLED|RAZORPAY_LIVE_ENABLED|CASHFREE_LIVE_ENABLED|LIVE_WEBHOOK_ENABLED|SETTLEMENT_EXECUTION_ENABLED|PAYOUT_EXECUTION_ENABLED|COD_CUSTODY_ENABLED/u;

    assert.equal(forbiddenConfig.test(envSource), false);
    assert.equal(guessedEnvNames.test(serviceSource), false);
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

  it("does not use float money conversion in C6 gate path", () => {
    const source = sourceText();
    const floatPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "round"].join("\\."),
      ["Num", "ber\\("].join("")
    ].join("|"), "u");

    assert.equal(floatPattern.test(source), false);
  });

  it("does not call providers, banks, orchestration, Cloud Run, or hosted runtime hooks", () => {
    const source = sourceText();
    const liveIntegrationPattern = new RegExp([
      ["razor", "pay\\."].join(""),
      ["cash", "free\\."].join(""),
      ["bank", "payout"].join(" "),
      ["settlement", "api"].join(" "),
      ["n", "8", "n"].join(""),
      ["cloud", "run"].join(" "),
      ["g", "cp"].join(""),
      ["secret", "manager"].join(" "),
      ["u", "pi"].join(""),
      ["im", "ps"].join(""),
      ["ne", "ft"].join("")
    ].join("|"), "u");

    assert.equal(liveIntegrationPattern.test(source), false);
  });

  it("adds no public checkout activation route or controller", () => {
    assert.equal(existsSync("src/modules/checkout/checkout-activation-gate.routes.ts"), false);
    assert.equal(existsSync("src/modules/checkout/checkout-activation-gate.controller.ts"), false);
  });

  it("does not document appEnv live as a valid APP_ENV assumption", () => {
    const source = sourceText();
    const literalInvalidAppEnv = ["appEnv", "=", "\"", "li", "ve", "\""].join("");

    assert.doesNotMatch(source, new RegExp(["appEnv:\\s*[\"']", "li", "ve", "[\"']"].join(""), "u"));
    assert.equal(source.includes(literalInvalidAppEnv), false);
  });
});
