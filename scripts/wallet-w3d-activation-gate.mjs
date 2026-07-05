#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { w3ActivationGateService } from "../dist/modules/wallet/w3-activation-gate.service.js";

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

function inputFromArgs(argv) {
  if (hasArg(argv, "--execute")) throw new Error("W3D_READ_ONLY_NO_EXECUTE");
  const targetMode = optionalArg(argv, "--target") ?? "preview_only";
  if (!["preview_only", "checkout_settlement", "early_cod_partner", "full_w3"].includes(targetMode)) {
    throw new Error("W3D_TARGET_INVALID");
  }
  return {
    targetMode,
    evidenceRefs: {
      ...evidenceFile(argv),
      ...evidencePairs(argv)
    },
    approvals: {
      counselCheckoutSettlementPosition: optionalArg(argv, "--counsel-checkout-settlement-position"),
      counselPaymentAggregatorPosition: optionalArg(argv, "--counsel-payment-aggregator-position"),
      counselEarlyCodPartnerPosition: optionalArg(argv, "--counsel-early-cod-partner-position"),
      counselDigitalLendingPosition: optionalArg(argv, "--counsel-digital-lending-position"),
      counselSellerDisclosureTerms: optionalArg(argv, "--counsel-seller-disclosure-terms"),
      accountantCheckoutSettlementTreatment: optionalArg(argv, "--accountant-checkout-settlement-treatment"),
      accountantEarlyCodTreatment: optionalArg(argv, "--accountant-early-cod-treatment"),
      accountantGstTreatment: optionalArg(argv, "--accountant-gst-treatment"),
      accountantTdsTreatment: optionalArg(argv, "--accountant-tds-treatment"),
      accountantPrincipalAgentTreatment: optionalArg(argv, "--accountant-principal-agent-treatment"),
      paymentPartnerApproval: optionalArg(argv, "--payment-partner-approval"),
      lendingPartnerApproval: optionalArg(argv, "--lending-partner-approval"),
      bankingPartnerApproval: optionalArg(argv, "--banking-partner-approval"),
      operationsSettlementSop: optionalArg(argv, "--operations-settlement-sop"),
      operationsExceptionSop: optionalArg(argv, "--operations-exception-sop"),
      operationsDisputeSop: optionalArg(argv, "--operations-dispute-sop"),
      ownerApproval: optionalArg(argv, "--owner-approval")
    }
  };
}

function printHuman(report) {
  console.log(`W3D activation gate: ${report.status}`);
  console.log(`targetMode: ${report.targetMode}`);
  console.log(`ok: ${report.ok ? "yes" : "no"}`);
  if (report.blockingIssues.length > 0) console.log(`blockingIssues: ${report.blockingIssues.join(", ")}`);
  if (report.warnings.length > 0) console.log(`warnings: ${report.warnings.join(", ")}`);
}

export async function runWalletW3DActivationGateCli(argv = process.argv.slice(2), service = w3ActivationGateService) {
  const report = service.getW3ActivationGateStatus(inputFromArgs(argv));
  if (hasArg(argv, "--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  printHuman(report);
  return report;
}

async function main() {
  try {
    await runWalletW3DActivationGateCli();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
