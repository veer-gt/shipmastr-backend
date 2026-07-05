#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { earlyCodPrequalificationService } from "../dist/modules/wallet/w3c-early-cod-prequalification.service.js";

dotenv.config({ quiet: true });

const DEFAULT_SELLER_ORG_ID = "org_w3c_sandbox_seller";
const DEFAULT_PERIOD = "2026-07";
const DEFAULT_SOURCE_REF = "src_w3c_early_cod_prequalification_2026_07";
const DEFAULT_CREATED_BY = "usr_w3c_operator";

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

function row(input, overrides = {}) {
  return {
    sellerOrgId: input.sellerOrgId,
    codInstructionBatchId: "cnb_w3c_clean_0001",
    checkoutPreviewBatchId: "cspb_w3c_clean_0001",
    courierCode: "BIGSHIP_SYNTHETIC",
    period: input.period,
    currency: "INR",
    grossCodDueMinor: "100000",
    expectedDeductionMinor: "12000",
    riskReserveMinor: "8000",
    partnerFeeEstimateMinor: "2000",
    maxAdvanceRateBps: "7000",
    requestedAdvanceMinor: "50000",
    daysSinceDelivery: "5",
    disputeCount: "0",
    rtoCount: "0",
    reviewIssueCount: "0",
    ...overrides
  };
}

function fixtureRows(input) {
  return [
    row(input),
    row(input, {
      codInstructionBatchId: "cnb_w3c_negative_0002",
      checkoutPreviewBatchId: "cspb_w3c_negative_0002",
      grossCodDueMinor: "1000"
    }),
    row(input, {
      codInstructionBatchId: "cnb_w3c_above_cap_0003",
      checkoutPreviewBatchId: "cspb_w3c_above_cap_0003",
      requestedAdvanceMinor: "90000"
    }),
    row(input, {
      codInstructionBatchId: "",
      checkoutPreviewBatchId: ""
    }),
    row(input, {
      codInstructionBatchId: "cnb_w3c_currency_0005",
      checkoutPreviewBatchId: "cspb_w3c_currency_0005",
      currency: "USD"
    }),
    row(input, {
      codInstructionBatchId: "cnb_w3c_review_0006",
      checkoutPreviewBatchId: "cspb_w3c_review_0006",
      disputeCount: "3",
      rtoCount: "4",
      reviewIssueCount: "1"
    }),
    row(input, {
      codInstructionBatchId: "cnb_public_9876543210",
      checkoutPreviewBatchId: "cspb_w3c_public_0007"
    })
  ];
}

function inputFromArgs(argv) {
  const sellerOrgId = optionalArg(argv, "--seller-org-id") ?? DEFAULT_SELLER_ORG_ID;
  const period = optionalArg(argv, "--period") ?? DEFAULT_PERIOD;
  return {
    sellerOrgId,
    period,
    sourceRef: optionalArg(argv, "--source-ref") ?? DEFAULT_SOURCE_REF,
    execute: hasArg(argv, "--execute"),
    rows: fixtureRows({ sellerOrgId, period }),
    createdBy: optionalArg(argv, "--created-by") ?? DEFAULT_CREATED_BY
  };
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

function printHuman(result) {
  console.log(result.dryRun ? "W3C early COD prequalification dry-run" : "W3C early COD prequalification recorded");
  console.log(`sellerOrgId: ${result.batch.sellerOrgId}`);
  console.log(`period: ${result.batch.period}`);
  console.log(`status: ${result.batch.status}`);
  console.log(`eligibleBaseMinor: ${result.batch.totals.eligibleBaseMinor}`);
  console.log(`maxPreviewAdvanceMinor: ${result.batch.totals.maxPreviewAdvanceMinor}`);
  console.log(`previewAdvanceMinor: ${result.batch.totals.previewAdvanceMinor}`);
  console.log(`reviewRequiredCount: ${result.batch.totals.reviewRequiredCount}`);
  console.log(`previewOnly: ${result.policy.previewOnly ? "yes" : "no"}`);
  console.log(`movementExecuted: ${result.policy.movementExecuted ? "yes" : "no"}`);
}

export async function runWalletW3CEarlyCodPrequalificationSmokeCli(argv = process.argv.slice(2), service = earlyCodPrequalificationService) {
  const result = await service.createBatch(inputFromArgs(argv));
  if (hasArg(argv, "--json")) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  printHuman(result);
  return result;
}

async function main() {
  try {
    await runWalletW3CEarlyCodPrequalificationSmokeCli();
  } catch (error) {
    console.error(JSON.stringify(errorJson(error), null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
