#!/usr/bin/env node
// SF1c verification gate — confirms no StorefrontSettings.themeJson row still contains an
// inline `data:image` blob after running migrate-storefront-base64-assets.mjs --apply.
// Exits non-zero (and prints offending storefrontIds) if any are found, so this can be
// wired into a deploy/CI gate before the base64-acceptance flag is ever removed from the
// renderer (see storefront-production-hardening-sf1-sf5.md SF1c).
//
// Usage: node scripts/verify-zero-base64-storefront-theme.mjs

import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

const prisma = new PrismaClient();

async function run() {
  // Raw query mirrors the exact verification query from the SF1 spec:
  //   themeJson::text LIKE '%data:image%'
  const offending = await prisma.$queryRaw`
    SELECT ss.id AS "settingsId", s.id AS "storefrontId", s."merchantId" AS "merchantId"
    FROM "StorefrontSettings" ss
    JOIN "Storefront" s ON s.id = ss."storefrontId"
    WHERE ss."themeJson"::text LIKE '%data:image%'
  `;

  if (offending.length === 0) {
    console.log(JSON.stringify({ ok: true, offendingRows: 0 }, null, 2));
    return;
  }

  console.error(JSON.stringify({
    ok: false,
    offendingRows: offending.length,
    rows: offending
  }, null, 2));
  process.exitCode = 1;
}

run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
