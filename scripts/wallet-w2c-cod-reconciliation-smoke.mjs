#!/usr/bin/env node

import { W2CCodReconciliationSmokeService } from "../dist/modules/wallet/w2c-cod-reconciliation-smoke.service.js";

function readArgs(argv) {
  const args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--execute") {
      args.execute = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--seller-org-id") {
      args.sellerOrgId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--courier-code") {
      args.courierCode = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--period") {
      args.period = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--created-by") {
      args.createdBy = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const report = await new W2CCodReconciliationSmokeService().run({
    sellerOrgId: args.sellerOrgId,
    courierCode: args.courierCode,
    period: args.period,
    createdBy: args.createdBy,
    dryRun: args.dryRun,
    execute: args.execute
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  const status = error && typeof error === "object" && "status" in error ? error.status : 500;
  const code = error instanceof Error ? error.message : "W2C_SMOKE_FAILED";
  process.stderr.write(`${JSON.stringify({ ok: false, status, code }, null, 2)}\n`);
  process.exitCode = 1;
});
