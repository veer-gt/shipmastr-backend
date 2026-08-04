#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import dotenv from "dotenv";

dotenv.config();

export const OWNER_RECONCILIATION_APPROVAL = "APPROVE_SHIPMASTR_OWNER_MASTER_ADMIN_RECONCILIATION";
export const OWNER_PRODUCTION_RECONCILIATION_APPROVAL = "APPROVE_PRODUCTION_SHIPMASTR_OWNER_RECONCILIATION";
export const OWNER_EMAIL = "indraveer.chauhan@gmail.com";

function required(source, key) {
  return String(source[key] || "").trim();
}

function databaseNameFromUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is invalid");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, "").split("?")[0] || "");
  if (!databaseName) throw new Error("DATABASE_URL database name is missing");
  return databaseName;
}

export function sanitizeOwnerReconciliationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-database-url]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .slice(0, 2000);
}

export function assertOwnerReconciliationSafety(source = process.env) {
  if (required(source, "SHIPMASTR_OWNER_RECONCILIATION_APPROVAL") !== OWNER_RECONCILIATION_APPROVAL) {
    throw new Error("SHIPMASTR_OWNER_RECONCILIATION_APPROVAL is not exact");
  }

  if (required(source, "OWNER_MASTER_ADMIN_TARGET_EMAIL").toLowerCase() !== OWNER_EMAIL) {
    throw new Error(`OWNER_MASTER_ADMIN_TARGET_EMAIL must exactly equal ${OWNER_EMAIL}`);
  }

  const operator = required(source, "OWNER_MASTER_ADMIN_OPERATOR");
  if (operator.length < 3 || operator.length > 320) {
    throw new Error("OWNER_MASTER_ADMIN_OPERATOR is invalid");
  }

  const reason = required(source, "OWNER_MASTER_ADMIN_REASON");
  if (reason.length < 10 || reason.length > 500) {
    throw new Error("OWNER_MASTER_ADMIN_REASON is invalid");
  }

  const appEnv = required(source, "APP_ENV");
  const targetEnv = required(source, "TARGET_ENV");
  if (!["development", "staging", "production"].includes(appEnv) || targetEnv !== appEnv) {
    throw new Error("APP_ENV and TARGET_ENV must match an approved environment");
  }

  if (source.K_SERVICE) {
    throw new Error("Refusing owner reconciliation inside a live Cloud Run service");
  }

  const databaseUrl = required(source, "DATABASE_URL");
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const actualDatabase = databaseNameFromUrl(databaseUrl);
  const expectedDatabase = required(source, "OWNER_RECONCILIATION_EXPECTED_DATABASE");
  if (!expectedDatabase || expectedDatabase !== actualDatabase) {
    throw new Error("OWNER_RECONCILIATION_EXPECTED_DATABASE does not match DATABASE_URL");
  }

  if (
    appEnv === "production"
    && required(source, "SHIPMASTR_PRODUCTION_OWNER_RECONCILIATION_APPROVAL")
      !== OWNER_PRODUCTION_RECONCILIATION_APPROVAL
  ) {
    throw new Error("Production owner reconciliation requires the exact second approval");
  }

  return {
    ownerEmail: OWNER_EMAIL,
    operator,
    reason,
    appEnv,
    databaseName: actualDatabase
  };
}

async function main() {
  const safety = assertOwnerReconciliationSafety(process.env);
  const [{ PrismaClient }, service] = await Promise.all([
    import("@prisma/client"),
    import("../dist/modules/auth/owner-master-admin-reconciliation.service.js")
  ]);

  const prisma = new PrismaClient();
  try {
    const result = await service.reconcileShipmastrOwnerMasterAdmin(
      {
        operator: safety.operator,
        reason: safety.reason,
        source: `offline-${safety.appEnv}-reconciliation`
      },
      { client: prisma }
    );

    console.log(JSON.stringify({
      changed: result.changed,
      ownerEmail: result.ownerEmail,
      userId: result.userId,
      role: result.role,
      userType: result.userType,
      environment: safety.appEnv,
      databaseName: safety.databaseName
    }, null, 2));
    console.log("Owner reconciliation completed without printing credentials or secrets.");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(sanitizeOwnerReconciliationError(error));
    process.exitCode = 1;
  });
}
