#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import {
  assertLocalRuntime,
  baseImportInput,
  closePilotOpsCliRuntime,
  commandName,
  createPilotOpsServiceForCli,
  hasArg,
  optionalArg,
  principal,
  requiredLocalFileContent,
  requiredArg,
  requireExecute
} from "../dist/modules/importPipeline/pilot-ops-cli-runtime.js";

dotenv.config({ quiet: true });

function json(value) {
  console.log(JSON.stringify(value, null, 2));
}

function errorJson(error) {
  const details = error && typeof error === "object" && "details" in error ? error.details : undefined;
  return {
    ok: false,
    ...(error && typeof error === "object" && "code" in error ? { code: error.code } : {}),
    error: error instanceof Error ? error.message : String(error),
    ...(details ? { details } : {})
  };
}

export async function runWalletW0PilotCli(argv = process.argv.slice(2), service) {
  assertLocalRuntime();
  const pilotService = service ?? createPilotOpsServiceForCli();
  const command = commandName(argv);

  if (command === "readiness") {
    json(await pilotService.checkW0Readiness({
      source: optionalArg(argv, "--source"),
      counterparty: optionalArg(argv, "--counterparty"),
      brandOrgId: optionalArg(argv, "--brand-org-id"),
      includeActivePackCheck: !hasArg(argv, "--skip-active-pack-check")
    }));
    return;
  }

  if (command === "validate-pack") {
    json(await pilotService.runFormatPackValidationFlow({
      packVersionId: requiredArg(argv, "--pack-version-id"),
      requestedBy: principal(argv, "--requested-by"),
      approvedBy: optionalArg(argv, "--approved-by"),
      activate: hasArg(argv, "--activate"),
      dryRun: !hasArg(argv, "--execute")
    }));
    return;
  }

  if (command === "import-dry-run") {
    json(await pilotService.runImportDryRun(baseImportInput(argv)));
    return;
  }

  if (command === "seed-synthetic-pack") {
    const misFile = requiredArg(argv, "--mis-file");
    json(await pilotService.seedSyntheticFormatPack({
      misContent: requiredLocalFileContent(argv, "--mis-file"),
      ordersContent: optionalArg(argv, "--orders-file") ? requiredLocalFileContent(argv, "--orders-file") : undefined,
      manifestContent: requiredLocalFileContent(argv, "--manifest"),
      misStoragePath: misFile,
      requestedBy: principal(argv, "--requested-by"),
      approvedBy: optionalArg(argv, "--approved-by"),
      execute: hasArg(argv, "--execute")
    }));
    return;
  }

  if (command === "stage-file") {
    json(await pilotService.runImportAndStage({
      ...baseImportInput(argv),
      execute: hasArg(argv, "--execute")
    }));
    return;
  }

  if (command === "post-shadow") {
    const execute = hasArg(argv, "--execute");
    json(await pilotService.postStagedRowsToShadowLedger({
      fileId: requiredArg(argv, "--file-id"),
      createdBy: principal(argv),
      dryRun: !execute
    }));
    return;
  }

  if (command === "report") {
    json(await pilotService.generatePilotRecoveryReport({
      brandOrgId: requiredArg(argv, "--brand-org-id"),
      period: optionalArg(argv, "--period"),
      fileIds: optionalArg(argv, "--file-id") ? [optionalArg(argv, "--file-id")] : undefined,
      courierCounterparty: optionalArg(argv, "--counterparty"),
      includeRows: hasArg(argv, "--include-rows")
    }));
    return;
  }

  if (command === "plan-correction") {
    json(await pilotService.planImportCorrection({
      importFileId: requiredArg(argv, "--file-id"),
      newFormatPackVersionId: requiredArg(argv, "--new-format-pack-version-id"),
      reason: requiredArg(argv, "--reason"),
      createdBy: principal(argv),
      persistPlan: hasArg(argv, "--execute")
    }));
    return;
  }

  if (command === "apply-correction") {
    if (hasArg(argv, "--execute")) requireExecute(argv);
    json(await pilotService.approveAndApplyCorrection({
      batchId: requiredArg(argv, "--batch-id"),
      approvedBy: optionalArg(argv, "--approved-by"),
      appliedBy: optionalArg(argv, "--applied-by"),
      execute: hasArg(argv, "--execute"),
      dryRun: !hasArg(argv, "--execute")
    }));
    return;
  }

  if (command === "e2e-dry-run") {
    json(await pilotService.runEndToEndPilotDryRun({
      ...baseImportInput(argv),
      packVersionId: optionalArg(argv, "--pack-version-id"),
      fileId: optionalArg(argv, "--file-id")
    }));
    return;
  }

  if (command === "e2e-local") {
    json(await pilotService.runEndToEndPilotLocal({
      ...baseImportInput(argv),
      execute: hasArg(argv, "--execute")
    }));
    return;
  }

  throw new Error(`Unknown W0 pilot command: ${command}`);
}

async function main() {
  try {
    await runWalletW0PilotCli();
  } catch (error) {
    console.error(JSON.stringify(errorJson(error), null, 2));
    process.exitCode = 1;
  } finally {
    await closePilotOpsCliRuntime();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
