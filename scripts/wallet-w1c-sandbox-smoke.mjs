#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { w1SandboxSmokeService } from "../dist/modules/wallet/w1c-sandbox-smoke.service.js";

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

function errorJson(error) {
  const details = error && typeof error === "object" && "details" in error ? error.details : undefined;
  return {
    ok: false,
    ...(error && typeof error === "object" && "status" in error ? { status: error.status } : {}),
    error: error instanceof Error ? error.message : String(error),
    ...(details ? { details } : {})
  };
}

function cliInput(argv) {
  const execute = hasArg(argv, "--execute");
  return {
    sellerOrgId: optionalArg(argv, "--seller-org-id"),
    createdBy: optionalArg(argv, "--created-by"),
    period: optionalArg(argv, "--period"),
    execute,
    dryRun: !execute || hasArg(argv, "--dry-run")
  };
}

function printHuman(result) {
  if (result.dryRun) {
    console.log("W1C sandbox smoke dry-run");
    console.log(`sellerOrgId: ${result.sellerOrgId}`);
    console.log(`period: ${result.period}`);
    console.log(`readiness: ${result.readiness.ok ? "ok" : "blocked"}`);
    if (result.readiness.blockingIssues.length > 0) {
      console.log(`blockingIssues: ${result.readiness.blockingIssues.join(", ")}`);
    }
    console.log(`plannedSteps: ${result.steps.join(", ")}`);
    return;
  }
  console.log("W1C sandbox smoke executed");
  console.log(`sellerOrgId: ${result.sellerOrgId}`);
  console.log(`period: ${result.period}`);
  console.log(`finalPostedMinor: ${result.summaries.final.postedMinor}`);
  console.log(`finalHeldMinor: ${result.summaries.final.heldMinor}`);
  console.log(`finalAvailableMinor: ${result.summaries.final.availableMinor}`);
  console.log(`statementEntries: ${result.statement.entries.length}`);
}

export async function runWalletW1CSandboxSmokeCli(argv = process.argv.slice(2), service = w1SandboxSmokeService) {
  const result = await service.run(cliInput(argv));
  if (hasArg(argv, "--json")) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  printHuman(result);
  return result;
}

async function main() {
  try {
    await runWalletW1CSandboxSmokeCli();
  } catch (error) {
    console.error(JSON.stringify(errorJson(error), null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
