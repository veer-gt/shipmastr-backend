#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { w2CodActivationGateService } from "../dist/modules/wallet/w2-cod-activation-gate.service.js";

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
  if (hasArg(argv, "--execute")) throw new Error("W2D_READ_ONLY_NO_EXECUTE");
  const targetMode = optionalArg(argv, "--target") ?? "instruction_only";
  if (!["instruction_only", "custody"].includes(targetMode)) throw new Error("W2D_TARGET_INVALID");
  return {
    targetMode,
    evidenceRefs: {
      ...evidenceFile(argv),
      ...evidencePairs(argv)
    },
    approvals: {
      counselCodInstructionOnlyPosition: optionalArg(argv, "--counsel-cod-instruction-only-position"),
      counselCodCustodyPosition: optionalArg(argv, "--counsel-cod-custody-position"),
      counselCourierRemittanceSop: optionalArg(argv, "--counsel-courier-remittance-sop"),
      counselSellerDisclosureTerms: optionalArg(argv, "--counsel-seller-disclosure-terms"),
      accountantCodTreatment: optionalArg(argv, "--accountant-cod-treatment"),
      accountantTdsTreatment: optionalArg(argv, "--accountant-tds-treatment"),
      accountantGstTreatment: optionalArg(argv, "--accountant-gst-treatment"),
      accountantPrincipalAgentTreatment: optionalArg(argv, "--accountant-principal-agent-treatment"),
      bankingPartnerApproval: optionalArg(argv, "--banking-partner-approval"),
      operationsReconciliationSop: optionalArg(argv, "--operations-reconciliation-sop"),
      operationsExceptionSop: optionalArg(argv, "--operations-exception-sop"),
      ownerApproval: optionalArg(argv, "--owner-approval")
    }
  };
}

function printHuman(report) {
  console.log(`W2D COD activation gate: ${report.status}`);
  console.log(`targetMode: ${report.targetMode}`);
  console.log(`ok: ${report.ok ? "yes" : "no"}`);
  if (report.blockingIssues.length > 0) console.log(`blockingIssues: ${report.blockingIssues.join(", ")}`);
  if (report.warnings.length > 0) console.log(`warnings: ${report.warnings.join(", ")}`);
}

export async function runWalletW2DCodActivationGateCli(argv = process.argv.slice(2), service = w2CodActivationGateService) {
  const report = service.getW2CodActivationGateStatus(inputFromArgs(argv));
  if (hasArg(argv, "--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  printHuman(report);
  return report;
}

async function main() {
  try {
    await runWalletW2DCodActivationGateCli();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
