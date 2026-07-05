#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { checkoutSettlementPreviewService } from "../dist/modules/wallet/w3a-checkout-settlement-preview.service.js";

dotenv.config({ quiet: true });

const DEFAULT_SELLER_ORG_ID = "org_w3a_sandbox_seller";
const DEFAULT_PERIOD = "2026-07";
const DEFAULT_SOURCE_REF = "src_w3a_checkout_preview_2026_07";
const DEFAULT_CREATED_BY = "usr_w3a_operator";

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
    checkoutRef: "chk_w3a_clean_0001",
    orderRef: "ord_w3a_clean_0001",
    shipmentId: "shp_w3a_clean_0001",
    period: input.period,
    currency: "INR",
    grossAmountMinor: "100000",
    paymentFeeMinor: "2500",
    platformFeeMinor: "5000",
    shippingChargeMinor: "8000",
    taxMinor: "1800",
    discountMinor: "3000",
    refundMinor: "0",
    adjustmentMinor: "1300",
    ...overrides
  };
}

function fixtureRows(input) {
  return [
    row(input),
    row(input, {
      checkoutRef: "chk_w3a_negative_0002",
      orderRef: "ord_w3a_negative_0002",
      shipmentId: "shp_w3a_negative_0002",
      grossAmountMinor: "1000",
      paymentFeeMinor: "2500",
      platformFeeMinor: "1000",
      shippingChargeMinor: "800",
      taxMinor: "180",
      discountMinor: "300",
      refundMinor: "0",
      adjustmentMinor: "0"
    }),
    row(input, {
      checkoutRef: "chk_w3a_duplicate_0003",
      orderRef: "ord_w3a_duplicate_a_0003",
      shipmentId: "shp_w3a_duplicate_a_0003"
    }),
    row(input, {
      checkoutRef: "chk_w3a_duplicate_0003",
      orderRef: "ord_w3a_duplicate_b_0003",
      shipmentId: "shp_w3a_duplicate_b_0003"
    }),
    row(input, {
      checkoutRef: "",
      orderRef: "ord_w3a_missing_0004",
      shipmentId: "shp_w3a_missing_0004"
    }),
    row(input, {
      checkoutRef: "chk_w3a_currency_0005",
      orderRef: "ord_w3a_currency_0005",
      shipmentId: "shp_w3a_currency_0005",
      currency: "USD"
    }),
    row(input, {
      checkoutRef: "chk_public_9876543210",
      orderRef: "ord_w3a_public_0006",
      shipmentId: "shp_w3a_public_0006"
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
  console.log(result.dryRun ? "W3A checkout settlement preview dry-run" : "W3A checkout settlement preview recorded");
  console.log(`sellerOrgId: ${result.batch.sellerOrgId}`);
  console.log(`period: ${result.batch.period}`);
  console.log(`status: ${result.batch.status}`);
  console.log(`sellerPreviewReceivableMinor: ${result.batch.totals.sellerPreviewReceivableMinor}`);
  console.log(`reviewRequiredCount: ${result.batch.totals.reviewRequiredCount}`);
  console.log(`previewOnly: ${result.policy.previewOnly ? "yes" : "no"}`);
  console.log(`movementExecuted: ${result.policy.movementExecuted ? "yes" : "no"}`);
}

export async function runWalletW3ACheckoutSettlementPreviewSmokeCli(argv = process.argv.slice(2), service = checkoutSettlementPreviewService) {
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
    await runWalletW3ACheckoutSettlementPreviewSmokeCli();
  } catch (error) {
    console.error(JSON.stringify(errorJson(error), null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
