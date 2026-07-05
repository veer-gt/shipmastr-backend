#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import {
  codInstructionNettingService,
  w2CodReadinessService
} from "../dist/modules/wallet/w2a-cod-netting.service.js";

dotenv.config({ quiet: true });

const DEFAULT_SELLER_ORG_ID = "org_w2a_instruction_seller";
const DEFAULT_COURIER_CODE = "BIGSHIP_SYNTHETIC";
const DEFAULT_PERIOD = "2026-07";
const DEFAULT_SOURCE_REF = "w2a_cod_instruction_fixture_2026_07";

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

function commandArg(argv) {
  const first = argv.find((arg) => !arg.startsWith("--"));
  return first ?? "netting";
}

function fixtureRows(input) {
  const sellerOrgId = input.sellerOrgId ?? DEFAULT_SELLER_ORG_ID;
  const courierCode = input.courierCode ?? DEFAULT_COURIER_CODE;
  const period = input.period ?? DEFAULT_PERIOD;
  return [
    {
      sellerOrgId,
      shipmentId: "shp_w2a_clean_0001",
      courierCode,
      deliveredAt: "2026-07-02T10:00:00.000Z",
      codCollectedMinor: "100000",
      freightDeductionMinor: "18000",
      rtoDeductionMinor: "5000",
      adjustmentMinor: "3000",
      expectedRemittanceMinor: "80000",
      remittanceRef: "rem_w2a_clean_0001",
      period
    },
    {
      sellerOrgId,
      shipmentId: "shp_w2a_negative_0002",
      courierCode,
      deliveredAt: "2026-07-03T10:00:00.000Z",
      codCollectedMinor: "12000",
      freightDeductionMinor: "17000",
      rtoDeductionMinor: "4000",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "0",
      remittanceRef: "rem_w2a_negative_0002",
      period
    },
    {
      sellerOrgId,
      shipmentId: "shp_w2a_duplicate_0003",
      courierCode,
      deliveredAt: "2026-07-04T10:00:00.000Z",
      codCollectedMinor: "45000",
      freightDeductionMinor: "6000",
      rtoDeductionMinor: "0",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "39000",
      remittanceRef: "rem_w2a_duplicate_0003_a",
      period
    },
    {
      sellerOrgId,
      shipmentId: "shp_w2a_duplicate_0003",
      courierCode,
      deliveredAt: "2026-07-04T10:30:00.000Z",
      codCollectedMinor: "45000",
      freightDeductionMinor: "6000",
      rtoDeductionMinor: "0",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "39000",
      remittanceRef: "rem_w2a_duplicate_0003_b",
      period
    },
    {
      sellerOrgId,
      shipmentId: "",
      courierCode,
      deliveredAt: "2026-07-05T10:00:00.000Z",
      codCollectedMinor: "20000",
      freightDeductionMinor: "3000",
      rtoDeductionMinor: "0",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "17000",
      remittanceRef: "rem_w2a_missing_ref_0004",
      period
    }
  ];
}

function inputFromArgs(argv) {
  const sellerOrgId = optionalArg(argv, "--seller-org-id") ?? DEFAULT_SELLER_ORG_ID;
  const courierCode = optionalArg(argv, "--courier-code") ?? DEFAULT_COURIER_CODE;
  const period = optionalArg(argv, "--period") ?? DEFAULT_PERIOD;
  return {
    sellerOrgId,
    courierCode,
    period,
    sourceRef: optionalArg(argv, "--source-ref") ?? DEFAULT_SOURCE_REF,
    execute: hasArg(argv, "--execute"),
    rows: fixtureRows({ sellerOrgId, courierCode, period }),
    createdBy: optionalArg(argv, "--created-by") ?? "usr_w2a_local_operator"
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
  if ("phase" in result) {
    console.log(`W2A COD readiness: ${result.status}`);
    if (result.blockingIssues.length > 0) console.log(`blockingIssues: ${result.blockingIssues.join(", ")}`);
    return;
  }
  console.log(result.dryRun ? "W2A COD instruction dry-run" : "W2A COD instruction recorded");
  console.log(`sellerOrgId: ${result.batch.sellerOrgId}`);
  console.log(`courierCode: ${result.batch.courierCode}`);
  console.log(`period: ${result.batch.period}`);
  console.log(`status: ${result.batch.status}`);
  console.log(`sellerNetReceivableMinor: ${result.batch.totals.sellerNetReceivableMinor}`);
  console.log(`reviewRequiredCount: ${result.batch.totals.reviewRequiredCount}`);
}

export async function runWalletW2ACodNettingSmokeCli(argv = process.argv.slice(2), service = codInstructionNettingService) {
  const command = commandArg(argv);
  const result = command === "readiness"
    ? w2CodReadinessService.getReadiness()
    : await service.createBatch(inputFromArgs(argv));
  if (hasArg(argv, "--json")) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  printHuman(result);
  return result;
}

async function main() {
  try {
    await runWalletW2ACodNettingSmokeCli();
  } catch (error) {
    console.error(JSON.stringify(errorJson(error), null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
