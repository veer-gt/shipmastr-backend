import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CRITICAL_TABLES = Object.freeze([
  "Merchant",
  "User",
  "Storefront",
  "StorefrontAsset",
  "StorefrontProduct",
  "Order",
  "checkout_quotes",
  "checkout_orders",
]);

const SAFE_TABLES = new Set(CRITICAL_TABLES);
const SAFE_ERROR_MESSAGES = Object.freeze({
  TARGET_INSTANCE_REQUIRED: "a temporary PITR clone target is required",
  TARGET_INSTANCE_NOT_ALLOWED: "the target must be a shipmastr-pitr-drill temporary clone",
  READ_ONLY_REQUIRED: "read-only configuration is required",
  READ_ONLY_NOT_CONFIRMED: "the database did not confirm transaction read-only mode",
  MIGRATION_STATUS_REQUIRED: "current Prisma migration status is required",
  MIGRATION_STATUS_NOT_CURRENT: "Prisma migration status is not current",
  MIGRATION_COUNT_INVALID: "migration count is invalid",
  MIGRATION_COUNT_MISMATCH: "migration count does not match the expected count",
  ADAPTER_RESULT_INVALID: "the database adapter returned a malformed result",
  CRITICAL_TABLE_MISSING: "a critical table is missing",
  QUERY_FAILED: "a read-only verification query failed",
  INVALID_ARGUMENT: "an argument is invalid",
  DATABASE_URL_REQUIRED: "an explicit verifier database URL is required for normal mode",
  PRISMA_CLIENT_RESOLUTION_FAILED: "Prisma client resolution failed from the validated application root",
  DATABASE_CONNECTION_FAILED: "database connection bootstrap failed",
  VERIFICATION_FAILED: "read-only verification failed",
});

/**
 * The SQL strings are deliberately static. Dynamic table names are generated
 * only from CRITICAL_TABLES, which is the verifier's hardcoded allowlist.
 */
export const VERIFICATION_QUERIES = Object.freeze([
  "SET TRANSACTION READ ONLY",
  "SELECT current_database() AS database_name",
  "SELECT current_setting('server_version_num') AS server_version_num",
  "SELECT current_setting('transaction_read_only') AS transaction_read_only",
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  "SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
  ...CRITICAL_TABLES.map((table) => `SELECT to_regclass('${quoteIdentifier(table)}')::text AS table_name`),
  ...CRITICAL_TABLES.map((table) => `SELECT COUNT(*)::text AS row_count FROM ${quoteIdentifier(table)}`),
]);

function quoteIdentifier(identifier) {
  if (!SAFE_TABLES.has(identifier)) {
    throw verificationError("INVALID_ARGUMENT");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function verificationError(code, cause) {
  const error = new Error(SAFE_ERROR_MESSAGES[code] ?? SAFE_ERROR_MESSAGES.VERIFICATION_FAILED);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function isTruthyFlag(value) {
  return value === true || value === "1" || value === "true" || value === "on" || value === "yes";
}

export function targetInstanceAllowed(targetInstance) {
  return typeof targetInstance === "string"
    && /^shipmastr-pitr-drill-[a-z0-9][a-z0-9-]*$/.test(targetInstance)
    && !/(?:^|-)(?:prod|production|staging)(?:-|$)/i.test(targetInstance);
}

export function assertTargetInstance(targetInstance) {
  if (typeof targetInstance !== "string" || targetInstance.trim() === "") {
    throw verificationError("TARGET_INSTANCE_REQUIRED");
  }
  if (!targetInstanceAllowed(targetInstance)) {
    throw verificationError("TARGET_INSTANCE_NOT_ALLOWED");
  }
  return targetInstance;
}

export function readOnlyConfigured({ pgOptions = "", readOnly = false, dryRun = false } = {}) {
  const configured = /(?:^|\s)-c\s+default_transaction_read_only=on(?:\s|$)/.test(String(pgOptions)) || isTruthyFlag(readOnly);
  return dryRun ? configured : /default_transaction_read_only\s*=\s*on/.test(String(pgOptions));
}

function parseNonNegativeInteger(value, code = "MIGRATION_COUNT_INVALID") {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  if (!/^\d+$/.test(String(value))) throw verificationError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw verificationError(code);
  return parsed;
}

function normalizeCount(value) {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^\d+$/.test(text)) throw verificationError("ADAPTER_RESULT_INVALID");
  const numeric = Number(text);
  return Number.isSafeInteger(numeric) ? numeric : text;
}

function assertRows(result) {
  if (!result || !Array.isArray(result.rows)) throw verificationError("ADAPTER_RESULT_INVALID");
  return result.rows;
}

async function queryRows(adapter, sql) {
  try {
    return assertRows(await adapter.query(sql));
  } catch (error) {
    if (["ADAPTER_RESULT_INVALID", "DATABASE_CONNECTION_FAILED"].includes(error?.code)) throw error;
    throw verificationError("QUERY_FAILED", error);
  }
}

async function executeCommand(adapter, sql) {
  try {
    if (typeof adapter.execute === "function") {
      await adapter.execute(sql);
      return;
    }
    assertRows(await adapter.query(sql));
  } catch (error) {
    if (["ADAPTER_RESULT_INVALID", "DATABASE_CONNECTION_FAILED"].includes(error?.code)) throw error;
    throw verificationError("QUERY_FAILED", error);
  }
}

function oneRow(rows) {
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
    throw verificationError("ADAPTER_RESULT_INVALID");
  }
  return rows[0];
}

function normalizeMigrationStatus({ migrationStatus, migrationCount, expectedMigrationCount } = {}) {
  if (typeof migrationStatus !== "string" || migrationStatus.trim() === "") {
    throw verificationError("MIGRATION_STATUS_REQUIRED");
  }
  const status = migrationStatus.trim().toLowerCase();
  if (status !== "current" && status !== "up-to-date") throw verificationError("MIGRATION_STATUS_NOT_CURRENT");
  const count = parseNonNegativeInteger(migrationCount);
  if (count === null) throw verificationError("MIGRATION_COUNT_INVALID");
  const expected = parseNonNegativeInteger(expectedMigrationCount);
  if (expected !== null && count !== expected) throw verificationError("MIGRATION_COUNT_MISMATCH");
  return { count, status: "current" };
}

export function schemaFingerprint(columns) {
  if (!Array.isArray(columns)) throw verificationError("ADAPTER_RESULT_INVALID");
  const canonical = columns.map((column) => {
    if (!column || typeof column !== "object") throw verificationError("ADAPTER_RESULT_INVALID");
    const required = ["table_name", "column_name", "ordinal_position", "data_type", "udt_name", "is_nullable", "column_default"];
    for (const key of required) {
      if (!(key in column)) throw verificationError("ADAPTER_RESULT_INVALID");
    }
    return required.map((key) => [key, column[key] === null ? null : String(column[key])]);
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function publicTableNames(rows) {
  return rows.map((row) => {
    if (!row || typeof row.table_name !== "string") throw verificationError("ADAPTER_RESULT_INVALID");
    return row.table_name;
  });
}

function tablePresence(rows) {
  const present = {};
  for (const row of rows) {
    if (!row || !("table_name" in row)) throw verificationError("ADAPTER_RESULT_INVALID");
    present[CRITICAL_TABLES[Object.keys(present).length]] = row.table_name !== null;
  }
  if (Object.keys(present).length !== CRITICAL_TABLES.length) throw verificationError("ADAPTER_RESULT_INVALID");
  return present;
}

function aggregateCounts(rows) {
  if (rows.length !== CRITICAL_TABLES.length) throw verificationError("ADAPTER_RESULT_INVALID");
  return Object.fromEntries(rows.map((row, index) => {
    if (!row || !("row_count" in row)) throw verificationError("ADAPTER_RESULT_INVALID");
    return [CRITICAL_TABLES[index], normalizeCount(row.row_count)];
  }));
}

export function sanitizeResult(result) {
  return JSON.parse(JSON.stringify(result, (_, value) => {
    if (typeof value === "bigint") return value.toString();
    return value;
  }));
}

export async function runVerification({
  adapter,
  targetInstance,
  pgOptions = "",
  readOnly = false,
  migrationStatus,
  migrationCount,
  expectedMigrationCount,
  dryRun = false,
} = {}) {
  assertTargetInstance(targetInstance);
  if (!readOnlyConfigured({ pgOptions, readOnly, dryRun })) throw verificationError("READ_ONLY_REQUIRED");
  const migrations = normalizeMigrationStatus({ migrationStatus: dryRun ? migrationStatus ?? "current" : migrationStatus, migrationCount: dryRun ? migrationCount ?? 0 : migrationCount, expectedMigrationCount });

  if (dryRun) {
    return sanitizeResult({
      ok: true,
      mode: "dry-run",
      targetInstance,
      databaseName: "not-connected",
      postgresqlMajorVersion: null,
      transactionReadOnly: true,
      migrationStatus: migrations,
      publicTableCount: null,
      criticalTablePresence: null,
      missingCriticalTables: [],
      aggregateCounts: {},
      schemaSha256: null,
      writeQueriesAttempted: false,
    });
  }

  if (!adapter || typeof adapter.query !== "function") throw verificationError("ADAPTER_RESULT_INVALID");
  if (typeof adapter.withReadOnlyTransaction === "function") {
    return adapter.withReadOnlyTransaction((transactionAdapter) => verifyQueries(transactionAdapter, { managedTransaction: true, targetInstance, migrations }));
  }
  return verifyQueries(adapter, { managedTransaction: false, targetInstance, migrations });
}

async function verifyQueries(adapter, { managedTransaction, targetInstance, migrations }) {
  let transactionStarted = false;
  try {
    if (managedTransaction) {
      await executeCommand(adapter, "SET TRANSACTION READ ONLY");
    } else {
      await executeCommand(adapter, "BEGIN TRANSACTION READ ONLY");
      transactionStarted = true;
    }
    const database = oneRow(await queryRows(adapter, "SELECT current_database() AS database_name"));
    const version = oneRow(await queryRows(adapter, "SELECT current_setting('server_version_num') AS server_version_num"));
    const connectionReadOnly = oneRow(await queryRows(adapter, "SELECT current_setting('transaction_read_only') AS transaction_read_only"));
    if (String(connectionReadOnly.transaction_read_only).toLowerCase() !== "on") throw verificationError("READ_ONLY_NOT_CONFIRMED");

    const transactionReadOnly = oneRow(await queryRows(adapter, "SELECT current_setting('transaction_read_only') AS transaction_read_only"));
    if (String(transactionReadOnly.transaction_read_only).toLowerCase() !== "on") throw verificationError("READ_ONLY_NOT_CONFIRMED");

    const tables = publicTableNames(await queryRows(adapter, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"));
    const columns = await queryRows(adapter, "SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position");
    const presence = tablePresence(await Promise.all(CRITICAL_TABLES.map((table) => queryRows(adapter, `SELECT to_regclass('${quoteIdentifier(table)}')::text AS table_name`))).then((rows) => rows.map(oneRow)));
    const missing = CRITICAL_TABLES.filter((table) => !presence[table]);
    if (missing.length > 0) throw Object.assign(verificationError("CRITICAL_TABLE_MISSING"), { missing });
    const counts = aggregateCounts(await Promise.all(CRITICAL_TABLES.map((table) => queryRows(adapter, `SELECT COUNT(*)::text AS row_count FROM ${quoteIdentifier(table)}`))).then((rows) => rows.map(oneRow)));
    const result = sanitizeResult({
      ok: true,
      mode: "verify",
      targetInstance,
      databaseName: database.database_name,
      postgresqlMajorVersion: String(version.server_version_num).slice(0, -4) || "0",
      transactionReadOnly: true,
      migrationStatus: migrations,
      publicTableCount: tables.length,
      criticalTablePresence: presence,
      missingCriticalTables: [],
      aggregateCounts: counts,
      schemaSha256: schemaFingerprint(columns),
      writeQueriesAttempted: false,
    });
    if (!managedTransaction) await executeCommand(adapter, "COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try { await executeCommand(adapter, "ROLLBACK"); } catch { /* cleanup is best effort and never changes the sanitized failure */ }
    }
    throw error;
  }
}

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "--read-only") { options.readOnly = true; continue; }
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replaceAll("-", "");
      if (!["targetinstance", "migrationstatus", "migrationcount", "expectedmigrationcount"].includes(key)) throw verificationError("INVALID_ARGUMENT");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw verificationError("INVALID_ARGUMENT");
      options[{ targetinstance: "targetInstance", migrationstatus: "migrationStatus", migrationcount: "migrationCount", expectedmigrationcount: "expectedMigrationCount" }[key]] = value;
      index += 1;
      continue;
    }
    throw verificationError("INVALID_ARGUMENT");
  }
  return options;
}

export function resolvePrismaClient(appRoot = process.env.PITR_APP_ROOT ?? process.cwd()) {
  try {
    if (typeof appRoot !== "string" || !appRoot.startsWith("/")) throw verificationError("PRISMA_CLIENT_RESOLUTION_FAILED");
    const resolvedRoot = realpathSync(appRoot);
    const packagePath = join(resolvedRoot, "package.json");
    if (!existsSync(packagePath) || !existsSync(join(resolvedRoot, "node_modules", "@prisma", "client"))) {
      throw verificationError("PRISMA_CLIENT_RESOLUTION_FAILED");
    }
    const loaded = createRequire(packagePath)("@prisma/client");
    if (!loaded || typeof loaded.PrismaClient !== "function") throw verificationError("PRISMA_CLIENT_RESOLUTION_FAILED");
    return loaded;
  } catch (error) {
    if (error?.code === "PRISMA_CLIENT_RESOLUTION_FAILED") throw error;
    throw verificationError("PRISMA_CLIENT_RESOLUTION_FAILED", error);
  }
}

async function createPrismaAdapter(databaseUrl, appRoot) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") throw verificationError("DATABASE_URL_REQUIRED");
  const { PrismaClient } = resolvePrismaClient(appRoot);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });
  return {
    query: async (sql) => {
      try {
        return { rows: await prisma.$queryRawUnsafe(sql) };
      } catch (error) {
        throw verificationError("DATABASE_CONNECTION_FAILED", error);
      }
    },
    withReadOnlyTransaction: async (callback) => {
      try {
        return await prisma.$transaction(async (tx) => callback({
          query: async (sql) => {
            try {
              return { rows: await tx.$queryRawUnsafe(sql) };
            } catch (error) {
              throw verificationError("DATABASE_CONNECTION_FAILED", error);
            }
          },
          execute: async (sql) => {
            try {
              return await tx.$executeRawUnsafe(sql);
            } catch (error) {
              throw verificationError("DATABASE_CONNECTION_FAILED", error);
            }
          },
        }));
      } catch (error) {
        if (error?.code && SAFE_ERROR_MESSAGES[error.code]) throw error;
        throw verificationError("DATABASE_CONNECTION_FAILED", error);
      }
    },
    disconnect: () => prisma.$disconnect(),
  };
}

function cliConfig(argv, env = process.env) {
  const args = parseArgs(argv);
  return {
    ...args,
    targetInstance: args.targetInstance ?? env.PITR_TARGET_INSTANCE,
    pgOptions: env.PGOPTIONS ?? "",
    readOnly: args.readOnly ?? isTruthyFlag(env.PITR_READ_ONLY),
    migrationStatus: args.migrationStatus ?? env.PITR_MIGRATION_STATUS,
    migrationCount: args.migrationCount ?? env.PITR_MIGRATION_COUNT,
    expectedMigrationCount: args.expectedMigrationCount ?? env.PITR_EXPECTED_MIGRATION_COUNT,
    appRoot: env.PITR_APP_ROOT,
    databaseUrl: env.PITR_DATABASE_URL,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let config;
  let adapter;
  try {
    config = cliConfig(argv, env);
    assertTargetInstance(config.targetInstance);
    if (!readOnlyConfigured({ pgOptions: config.pgOptions, readOnly: config.readOnly, dryRun: config.dryRun })) {
      throw verificationError("READ_ONLY_REQUIRED");
    }
    normalizeMigrationStatus({
      migrationStatus: config.dryRun ? config.migrationStatus ?? "current" : config.migrationStatus,
      migrationCount: config.dryRun ? config.migrationCount ?? 0 : config.migrationCount,
      expectedMigrationCount: config.expectedMigrationCount,
    });
    if (!config.dryRun) adapter = await createPrismaAdapter(config.databaseUrl, config.appRoot);
    const result = await runVerification({ ...config, adapter });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = error?.code && SAFE_ERROR_MESSAGES[error.code] ? error.code : "VERIFICATION_FAILED";
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message: SAFE_ERROR_MESSAGES[code] } })}\n`);
    return 1;
  } finally {
    if (adapter?.disconnect) await adapter.disconnect().catch(() => {});
  }
}

const invokedDirectly = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = await main();
}
