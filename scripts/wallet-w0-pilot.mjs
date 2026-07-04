#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { pilotOpsService } from "../dist/modules/importPipeline/pilot-ops.service.js";

dotenv.config({ quiet: true });

const LOCAL_RUNTIME_REFUSAL = "W0 pilot wrapper is local/internal only. Refusing cloud or production-like runtime.";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function commandName() {
  return process.argv[2] || "readiness";
}

function assertLocalRuntime(source = process.env) {
  const nodeEnv = String(source.NODE_ENV || "").trim().toLowerCase();
  const appEnv = String(source.APP_ENV || "").trim().toLowerCase();
  if (nodeEnv === "production" || appEnv === "production" || source.K_SERVICE || source.CLOUD_RUN_JOB) {
    throw new Error(LOCAL_RUNTIME_REFUSAL);
  }
}

function requiredArg(name) {
  const value = argValue(name);
  if (!value || !String(value).trim()) throw new Error(`${name} is required`);
  return String(value).trim();
}

function optionalArg(name) {
  const value = argValue(name);
  return value && String(value).trim() ? String(value).trim() : undefined;
}

function principal(name = "--created-by") {
  return optionalArg(name) || "import_pipeline_w0";
}

function csvContent() {
  const csvPath = optionalArg("--csv");
  if (!csvPath) return undefined;
  return readFileSync(resolve(csvPath), "utf8");
}

function baseImportInput() {
  const content = csvContent();
  return {
    csvContent: content,
    storagePath: optionalArg("--storage-path"),
    expectedFileHash: optionalArg("--expected-file-hash") || optionalArg("--file-hash"),
    source: requiredArg("--source"),
    counterparty: optionalArg("--counterparty"),
    brandOrgId: optionalArg("--brand-org-id"),
    period: optionalArg("--period"),
    formatPackVersionId: optionalArg("--format-pack-version-id"),
    statedTotalMinor: optionalArg("--stated-total-minor"),
    createdBy: principal()
  };
}

function requireExecute() {
  if (!hasArg("--execute")) throw new Error("--execute is required for this mutating command");
}

function json(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  assertLocalRuntime();
  const command = commandName();

  if (command === "readiness") {
    json(await pilotOpsService.checkW0Readiness({
      source: optionalArg("--source"),
      counterparty: optionalArg("--counterparty"),
      brandOrgId: optionalArg("--brand-org-id"),
      includeActivePackCheck: !hasArg("--skip-active-pack-check")
    }));
    return;
  }

  if (command === "validate-pack") {
    json(await pilotOpsService.runFormatPackValidationFlow({
      packVersionId: requiredArg("--pack-version-id"),
      requestedBy: principal("--requested-by"),
      approvedBy: optionalArg("--approved-by"),
      activate: hasArg("--activate"),
      dryRun: !hasArg("--execute")
    }));
    return;
  }

  if (command === "import-dry-run") {
    json(await pilotOpsService.runImportDryRun(baseImportInput()));
    return;
  }

  if (command === "stage-file") {
    json(await pilotOpsService.runImportAndStage({
      ...baseImportInput(),
      execute: hasArg("--execute")
    }));
    return;
  }

  if (command === "post-shadow") {
    const execute = hasArg("--execute");
    json(await pilotOpsService.postStagedRowsToShadowLedger({
      fileId: requiredArg("--file-id"),
      createdBy: principal(),
      dryRun: !execute
    }));
    return;
  }

  if (command === "report") {
    json(await pilotOpsService.generatePilotRecoveryReport({
      brandOrgId: requiredArg("--brand-org-id"),
      period: optionalArg("--period"),
      fileIds: optionalArg("--file-id") ? [optionalArg("--file-id")] : undefined,
      courierCounterparty: optionalArg("--counterparty"),
      includeRows: hasArg("--include-rows")
    }));
    return;
  }

  if (command === "plan-correction") {
    json(await pilotOpsService.planImportCorrection({
      importFileId: requiredArg("--file-id"),
      newFormatPackVersionId: requiredArg("--new-format-pack-version-id"),
      reason: requiredArg("--reason"),
      createdBy: principal(),
      persistPlan: hasArg("--execute")
    }));
    return;
  }

  if (command === "apply-correction") {
    if (hasArg("--execute")) requireExecute();
    json(await pilotOpsService.approveAndApplyCorrection({
      batchId: requiredArg("--batch-id"),
      approvedBy: optionalArg("--approved-by"),
      appliedBy: optionalArg("--applied-by"),
      execute: hasArg("--execute"),
      dryRun: !hasArg("--execute")
    }));
    return;
  }

  if (command === "e2e-dry-run") {
    json(await pilotOpsService.runEndToEndPilotDryRun({
      ...baseImportInput(),
      packVersionId: optionalArg("--pack-version-id"),
      fileId: optionalArg("--file-id")
    }));
    return;
  }

  if (command === "e2e-local") {
    json(await pilotOpsService.runEndToEndPilotLocal({
      ...baseImportInput(),
      execute: hasArg("--execute")
    }));
    return;
  }

  throw new Error(`Unknown W0 pilot command: ${command}`);
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
});
