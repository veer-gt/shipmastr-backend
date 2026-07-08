import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

export const STAGING_BOOTSTRAP_APPROVAL = "APPROVE_STAGING_ONLY_MASTER_ADMIN_USER_CREATION";
export const STAGING_MASTER_ADMIN_EMAIL = "indraveer.chauhan@gmail.com";
export const STAGING_MASTER_ADMIN_ROLE = "MASTER_ADMIN";
export const STAGING_MASTER_ADMIN_USER_TYPE = "INTERNAL_SHIPMASTR";
export const STAGING_ADMIN_MERCHANT_NAME = "Shipmastr Staging Master Admin";
export const STAGING_ADMIN_USER_NAME = "Shipmastr Staging Master Admin";

const DATABASE_REF_KEYS = [
  "DATABASE_URL_REF",
  "DATABASE_URL_SECRET_NAME",
  "SHIPMASTR_DATABASE_URL_REF",
  "SHIPMASTR_DATABASE_IDENTIFIER",
  "DB_IDENTIFIER"
];

function requiredString(source, key) {
  return String(source[key] || "").trim();
}

function assertStagingDatabaseTarget(source) {
  const databaseUrl = String(source.DATABASE_URL || "");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for staging admin bootstrap");
  }

  const identifiers = DATABASE_REF_KEYS
    .map((key) => String(source[key] || "").trim())
    .filter(Boolean);
  const joined = [databaseUrl, ...identifiers].join(" ").toLowerCase();
  const joinedIdentifiers = identifiers.join(" ").toLowerCase();

  if (!/database_url_staging|staging/.test(joined)) {
    throw new Error("Refusing staging admin bootstrap without a DATABASE_URL_STAGING/staging database identifier");
  }

  if (/database_url\b/.test(joinedIdentifiers) && !/database_url_staging|staging/.test(joinedIdentifiers)) {
    throw new Error("Refusing staging admin bootstrap with production DATABASE_URL identifier");
  }

  if (/(^|[_\W])prod(uction)?($|[_\W])/.test(joinedIdentifiers) && !/staging/.test(joinedIdentifiers)) {
    throw new Error("Refusing staging admin bootstrap with production database identifier");
  }
}

export function sanitizeBootstrapErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/postgresql:\/\/[^\s"']+/gi, "[redacted-database-url]")
    .replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, "[redacted-password-hash]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/(passwordHash:\s*")[^"]+(")/g, "$1[redacted-password-hash]$2")
    .replace(/(password:\s*")[^"]+(")/g, "$1[redacted-password]$2")
    .slice(0, 2000);
}

export function assertStagingAdminBootstrapSafety(source = process.env) {
  if (requiredString(source, "SHIPMASTR_STAGING_ADMIN_BOOTSTRAP_APPROVAL") !== STAGING_BOOTSTRAP_APPROVAL) {
    throw new Error("SHIPMASTR_STAGING_ADMIN_BOOTSTRAP_APPROVAL must exactly approve staging-only bootstrap");
  }

  if (requiredString(source, "TARGET_ENV") !== "staging") {
    throw new Error("TARGET_ENV must exactly equal staging");
  }

  const appEnv = requiredString(source, "APP_ENV");
  if (appEnv && appEnv !== "staging") {
    throw new Error("APP_ENV must be unset or exactly equal staging");
  }

  if (source.K_SERVICE) {
    throw new Error("Refusing staging admin bootstrap inside a live Cloud Run service");
  }

  if (source.CLOUD_RUN_JOB && requiredString(source, "TARGET_ENV") !== "staging") {
    throw new Error("CLOUD_RUN_JOB bootstrap is allowed only for TARGET_ENV=staging");
  }

  if (requiredString(source, "ADMIN_EMAIL") !== STAGING_MASTER_ADMIN_EMAIL) {
    throw new Error(`ADMIN_EMAIL must exactly equal ${STAGING_MASTER_ADMIN_EMAIL}`);
  }

  const password = String(source.STAGING_MASTER_ADMIN_PASSWORD || "");
  if (password.length < 8) {
    throw new Error("STAGING_MASTER_ADMIN_PASSWORD must be provided and at least 8 characters");
  }

  assertStagingDatabaseTarget(source);
}

export async function bootstrapStagingMasterAdmin({
  client,
  source = process.env,
  hashPassword = (password) => bcrypt.hash(password, 12)
}) {
  assertStagingAdminBootstrapSafety(source);

  const email = STAGING_MASTER_ADMIN_EMAIL;
  const existingUser = await client.user.findUnique({
    where: { email },
    select: { id: true }
  });
  const passwordHash = await hashPassword(String(source.STAGING_MASTER_ADMIN_PASSWORD));

  const merchant = await client.merchant.upsert({
    where: { email },
    update: {
      name: STAGING_ADMIN_MERCHANT_NAME
    },
    create: {
      name: STAGING_ADMIN_MERCHANT_NAME,
      email
    },
    select: {
      id: true,
      email: true
    }
  });

  const user = await client.user.upsert({
    where: { email },
    update: {
      merchantId: merchant.id,
      passwordHash,
      role: STAGING_MASTER_ADMIN_ROLE,
      userType: STAGING_MASTER_ADMIN_USER_TYPE,
      name: STAGING_ADMIN_USER_NAME
    },
    create: {
      merchantId: merchant.id,
      email,
      passwordHash,
      role: STAGING_MASTER_ADMIN_ROLE,
      userType: STAGING_MASTER_ADMIN_USER_TYPE,
      name: STAGING_ADMIN_USER_NAME
    },
    select: {
      id: true,
      email: true,
      merchantId: true,
      role: true,
      userType: true
    }
  });

  return {
    action: existingUser ? "updated" : "created",
    email: user.email,
    userId: user.id,
    merchantId: user.merchantId,
    role: user.role,
    userType: user.userType,
    stagingOnly: true
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await bootstrapStagingMasterAdmin({ client: prisma });
    console.log(JSON.stringify(result, null, 2));
    console.log("Staging-only admin bootstrap completed. No password, hash, token, or secret was printed.");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(sanitizeBootstrapErrorMessage(error));
    process.exitCode = 1;
  });
}
