#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { checkoutActivationGateService } from "../dist/modules/checkout/checkout-activation-gate.service.js";

dotenv.config({ quiet: true });

function hasArg(argv, name) {
  return argv.includes(name);
}

function optionalArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function evidencePairs(argv) {
  const refs = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--evidence") continue;
    const raw = argv[index + 1];
    if (!raw || raw.startsWith("--")) continue;
    const separator = raw.indexOf("=");
    if (separator <= 0) continue;
    refs[raw.slice(0, separator)] = raw.slice(separator + 1);
  }
  return refs;
}

function evidenceFile(argv) {
  const file = optionalArg(argv, "--evidence-file");
  if (!file) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function inputFromArgs(argv) {
  if (hasArg(argv, "--execute")) throw new Error("CHECKOUT_C6_READ_ONLY_NO_EXECUTE");
  return {
    evidenceRefs: {
      ...evidenceFile(argv),
      ...evidencePairs(argv)
    },
    approvals: {
      legalPaymentAggregatorPosition: optionalArg(argv, "--legal-payment-aggregator-position"),
      legalCheckoutTerms: optionalArg(argv, "--legal-checkout-terms"),
      accountingPaymentTreatment: optionalArg(argv, "--accounting-payment-treatment"),
      accountingRefundTreatment: optionalArg(argv, "--accounting-refund-treatment"),
      razorpayLiveApproval: optionalArg(argv, "--razorpay-live-approval"),
      cashfreeLiveApproval: optionalArg(argv, "--cashfree-live-approval"),
      providerKeyHandling: optionalArg(argv, "--provider-key-handling"),
      webhookSignatureVerification: optionalArg(argv, "--webhook-signature-verification"),
      webhookReplayProtection: optionalArg(argv, "--webhook-replay-protection"),
      webhookCrossValidation: optionalArg(argv, "--webhook-cross-validation"),
      refundSop: optionalArg(argv, "--refund-sop"),
      operationsReconciliationSop: optionalArg(argv, "--operations-reconciliation-sop"),
      operationsSupportEscalationSop: optionalArg(argv, "--operations-support-escalation-sop"),
      ownerApproval: optionalArg(argv, "--owner-approval"),
      rollbackPlan: optionalArg(argv, "--rollback-plan")
    },
    runtime: {
      checkoutLivePaymentsEnabled: hasArg(argv, "--checkout-live-payments-enabled"),
      razorpayLiveEnabled: hasArg(argv, "--razorpay-live-enabled"),
      cashfreeLiveEnabled: hasArg(argv, "--cashfree-live-enabled"),
      liveWebhookEnabled: hasArg(argv, "--live-webhook-enabled"),
      settlementExecutionEnabled: hasArg(argv, "--settlement-execution-enabled"),
      payoutExecutionEnabled: hasArg(argv, "--payout-execution-enabled"),
      codCustodyEnabled: hasArg(argv, "--cod-custody-enabled"),
      nodeEnv: optionalArg(argv, "--node-env"),
      appEnv: optionalArg(argv, "--app-env")
    }
  };
}

function printHuman(report) {
  console.log(`Checkout C6 activation gate: ${report.status}`);
  console.log(`ok: ${report.ok ? "yes" : "no"}`);
  console.log(`activationAllowed: ${report.activationAllowed ? "yes" : "no"}`);
  if (report.blockingIssues.length > 0) console.log(`blockingIssues: ${report.blockingIssues.join(", ")}`);
  if (report.warnings.length > 0) console.log(`warnings: ${report.warnings.join(", ")}`);
}

export async function runCheckoutActivationGateCli(argv = process.argv.slice(2), service = checkoutActivationGateService) {
  const report = service.getCheckoutActivationGateStatus(inputFromArgs(argv));
  if (hasArg(argv, "--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  printHuman(report);
  return report;
}

async function main() {
  try {
    await runCheckoutActivationGateCli();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
