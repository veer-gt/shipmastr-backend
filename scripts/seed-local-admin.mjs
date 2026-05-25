import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

export const LOCAL_ADMIN_EMAIL = "local-admin@shipmastr.test";
export const LOCAL_ADMIN_MERCHANT_ID = "merchant_local_admin";
export const LOCAL_ADMIN_MERCHANT_EMAIL = "local-admin-merchant@shipmastr.test";
export const LOCAL_ADMIN_ROLE = "MASTER_ADMIN";
export const LOCAL_ADMIN_USER_TYPE = "INTERNAL_SHIPMASTR";

const PROD_DATABASE_MARKERS = [
  "shipmastr-core-prod",
  "cloudsql",
  "asia-south1",
  "prod"
];

export function databaseUrlLooksProductionLike(databaseUrl) {
  const normalized = String(databaseUrl || "").toLowerCase();
  return PROD_DATABASE_MARKERS.some((marker) => normalized.includes(marker));
}

export function assertLocalAdminSeedSafety(source = process.env) {
  const nodeEnv = String(source.NODE_ENV || "").toLowerCase();
  const databaseUrl = String(source.DATABASE_URL || "");

  if (nodeEnv === "production") {
    throw new Error("Refusing to seed local admin while NODE_ENV=production");
  }

  if (source.K_SERVICE || source.CLOUD_RUN_JOB) {
    throw new Error("Refusing to seed local admin inside Cloud Run");
  }

  if (!databaseUrl) {
    throw new Error("Refusing to seed local admin without DATABASE_URL");
  }

  if (databaseUrlLooksProductionLike(databaseUrl)) {
    throw new Error("Refusing to seed local admin against a production-looking DATABASE_URL");
  }

  if (!source.LOCAL_ADMIN_PASSWORD) {
    throw new Error("LOCAL_ADMIN_PASSWORD is required");
  }
}

export async function seedLocalAdmin({
  client,
  source = process.env,
  hashPassword = (password) => bcrypt.hash(password, 12)
}) {
  assertLocalAdminSeedSafety(source);

  const existing = await client.user.findUnique({
    where: { email: LOCAL_ADMIN_EMAIL },
    select: { id: true }
  });
  const passwordHash = await hashPassword(String(source.LOCAL_ADMIN_PASSWORD));

  await client.merchant.upsert({
    where: { id: LOCAL_ADMIN_MERCHANT_ID },
    update: {
      name: "Shipmastr Local Admin",
      email: LOCAL_ADMIN_MERCHANT_EMAIL
    },
    create: {
      id: LOCAL_ADMIN_MERCHANT_ID,
      name: "Shipmastr Local Admin",
      email: LOCAL_ADMIN_MERCHANT_EMAIL
    }
  });

  await client.user.upsert({
    where: { email: LOCAL_ADMIN_EMAIL },
    update: {
      merchantId: LOCAL_ADMIN_MERCHANT_ID,
      passwordHash,
      role: LOCAL_ADMIN_ROLE,
      userType: LOCAL_ADMIN_USER_TYPE,
      name: "Local Admin"
    },
    create: {
      merchantId: LOCAL_ADMIN_MERCHANT_ID,
      email: LOCAL_ADMIN_EMAIL,
      passwordHash,
      role: LOCAL_ADMIN_ROLE,
      userType: LOCAL_ADMIN_USER_TYPE,
      name: "Local Admin"
    }
  });

  return {
    email: LOCAL_ADMIN_EMAIL,
    action: existing ? "updated" : "created",
    localOnly: true
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await seedLocalAdmin({ client: prisma });
    console.log(`Local admin ${result.action}: ${result.email}`);
    console.log("Local/dev-only admin seed completed. No password, hash, token, or secret was printed.");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
