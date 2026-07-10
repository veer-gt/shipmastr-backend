import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  CRITICAL_TABLES,
  VERIFICATION_QUERIES,
  assertTargetInstance,
  resolvePrismaClient,
  runVerification,
  schemaFingerprint,
  targetInstanceAllowed,
} from "./pitr-readonly-verify.mjs";

const execFileAsync = promisify(execFile);
const target = "shipmastr-pitr-drill-local-fixture";
const backendRoot = fileURLToPath(new URL("../../", import.meta.url));

function baseConfig(overrides = {}) {
  return {
    targetInstance: target,
    pgOptions: "-c default_transaction_read_only=on",
    migrationStatus: "current",
    migrationCount: 99,
    ...overrides,
  };
}

function makeAdapter({ missing = null, off = false, malformed = false } = {}) {
  const columns = CRITICAL_TABLES.map((table, index) => ({
    table_name: table,
    column_name: "id",
    ordinal_position: index + 1,
    data_type: "text",
    udt_name: "text",
    is_nullable: "NO",
    column_default: null,
  }));
  return {
    queries: [],
    async query(sql) {
      this.queries.push(sql);
      if (malformed) return {};
      if (sql === "SELECT current_database() AS database_name") return { rows: [{ database_name: "fixture" }] };
      if (sql === "SELECT current_setting('server_version_num') AS server_version_num") return { rows: [{ server_version_num: "160004" }] };
      if (sql === "SELECT current_setting('transaction_read_only') AS transaction_read_only") return { rows: [{ transaction_read_only: off ? "off" : "on" }] };
      if (sql === "SET TRANSACTION READ ONLY" || sql === "BEGIN TRANSACTION READ ONLY" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("SELECT table_name FROM information_schema.tables")) return { rows: CRITICAL_TABLES.map((table_name) => ({ table_name })) };
      if (sql.startsWith("SELECT table_name, column_name")) return { rows: columns };
      if (sql.startsWith("SELECT to_regclass('")) {
        const table = sql.match(/to_regclass\('\"([^\"]+)\"'\)/)?.[1];
        return { rows: [{ table_name: table === missing ? null : table }] };
      }
      if (sql.startsWith("SELECT COUNT(*)::text AS row_count FROM ")) return { rows: [{ row_count: "7" }] };
      throw new Error("unexpected query");
    },
  };
}

test("valid temporary clone target is accepted", () => {
  assert.equal(targetInstanceAllowed(target), true);
  assert.doesNotThrow(() => assertTargetInstance(target));
});

test("production, empty, and unrelated targets are rejected", () => {
  for (const value of ["shipmastr-postgres", "", "staging-postgres", "shipmastr-pitr-drill-staging", "other-pitr-drill-x"]) {
    assert.throws(() => assertTargetInstance(value));
  }
});

test("missing read-only configuration is rejected", async () => {
  await assert.rejects(() => runVerification(baseConfig({ pgOptions: "" })), { code: "READ_ONLY_REQUIRED" });
});

test("transaction_read_only=off is rejected", async () => {
  await assert.rejects(() => runVerification({ ...baseConfig(), adapter: makeAdapter({ off: true }) }), { code: "READ_ONLY_NOT_CONFIRMED" });
});

test("all critical tables present passes with aggregate-only output", async () => {
  const result = await runVerification({ ...baseConfig(), adapter: makeAdapter() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingCriticalTables, []);
  assert.deepEqual(result.aggregateCounts, Object.fromEntries(CRITICAL_TABLES.map((table) => [table, 7])));
  assert.equal(result.writeQueriesAttempted, false);
  assert.equal("row_values" in result, false);
});

test("managed adapters keep all verification queries in one read-only transaction", async () => {
  const base = makeAdapter();
  let transactionCalls = 0;
  const adapter = {
    query: (...args) => base.query(...args),
    withReadOnlyTransaction: async (callback) => {
      transactionCalls += 1;
      return callback(base);
    },
  };
  const result = await runVerification({ ...baseConfig(), adapter });
  assert.equal(result.ok, true);
  assert.equal(transactionCalls, 1);
  assert.equal(base.queries[0], "SET TRANSACTION READ ONLY");
  assert.equal(base.queries.includes("BEGIN TRANSACTION READ ONLY"), false);
});

test("missing critical table fails closed", async () => {
  await assert.rejects(() => runVerification({ ...baseConfig(), adapter: makeAdapter({ missing: "Order" }) }), { code: "CRITICAL_TABLE_MISSING" });
});

test("schema fingerprint is deterministic", () => {
  const columns = [{ table_name: "A", column_name: "id", ordinal_position: 1, data_type: "text", udt_name: "text", is_nullable: "NO", column_default: null }];
  assert.equal(schemaFingerprint(columns), schemaFingerprint(columns));
  assert.notEqual(schemaFingerprint(columns), schemaFingerprint([{ ...columns[0], data_type: "uuid" }]));
});

test("two successful runs produce the same schema fingerprint", async () => {
  const first = await runVerification({ ...baseConfig(), adapter: makeAdapter() });
  const second = await runVerification({ ...baseConfig(), adapter: makeAdapter() });
  assert.equal(first.schemaSha256, second.schemaSha256);
});

test("Prisma client resolves from the application root even when verifier is elsewhere", () => {
  const resolved = resolvePrismaClient(backendRoot);
  assert.equal(typeof resolved.PrismaClient, "function");
});

test("missing module root fails closed with a sanitized resolution error", () => {
  assert.throws(() => resolvePrismaClient("/tmp/pitr-missing-application-root"), { code: "PRISMA_CLIENT_RESOLUTION_FAILED" });
});

test("malformed adapter result fails closed", async () => {
  await assert.rejects(() => runVerification({ ...baseConfig(), adapter: makeAdapter({ malformed: true }) }), { code: "ADAPTER_RESULT_INVALID" });
});

test("verification query set contains no write-like SQL", () => {
  assert.equal(VERIFICATION_QUERIES.some((sql) => /\b(INSERT|UPDATE|DELETE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i.test(sql)), false);
  assert.equal(VERIFICATION_QUERIES.filter((sql) => sql.includes("to_regclass")).every((sql) => sql.includes("::text")), true);
});

test("dry-run does not open a database connection", async () => {
  let opened = false;
  const result = await runVerification({ ...baseConfig({ readOnly: true, pgOptions: "" }), dryRun: true, adapter: { query: async () => { opened = true; return { rows: [] }; } } });
  assert.equal(opened, false);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.databaseName, "not-connected");
});

test("negative dry-runs fail closed for production and missing read-only mode", async () => {
  await assert.rejects(() => runVerification({ ...baseConfig({ targetInstance: "shipmastr-postgres", readOnly: true, pgOptions: "" }), dryRun: true }), { code: "TARGET_INSTANCE_NOT_ALLOWED" });
  await assert.rejects(() => runVerification({ ...baseConfig({ readOnly: false, pgOptions: "" }), dryRun: true }), { code: "READ_ONLY_REQUIRED" });
});

test("output redaction never exposes fake credentials", async () => {
  const result = await runVerification({ ...baseConfig({ readOnly: true }), dryRun: true });
  const text = JSON.stringify(result);
  assert.equal(text.includes("fake-password"), false);
  assert.equal(text.includes("fake-token"), false);
  assert.equal(text.includes("DATABASE_URL"), false);
});

test("verifier copied to /tmp uses the validated app root and sanitizes fake DB failure", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pitr-verifier-tmp-"));
  const verifierPath = join(temp, "pitr-readonly-verify.mjs");
  await writeFile(verifierPath, await readFile(new URL("./pitr-readonly-verify.mjs", import.meta.url)));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [verifierPath], {
        cwd: backendRoot,
        env: {
          ...process.env,
          PITR_APP_ROOT: backendRoot,
          PITR_TARGET_INSTANCE: "shipmastr-pitr-drill-local-replay",
          PGOPTIONS: "-c default_transaction_read_only=on",
          PITR_READ_ONLY: "1",
          PITR_MIGRATION_STATUS: "current",
          PITR_MIGRATION_COUNT: "99",
          PITR_DATABASE_URL: "postgresql://fake-password@127.0.0.1:1/shipmastr",
        },
      }),
      (error) => error.code === 1 && error.stdout.includes('"code":"DATABASE_CONNECTION_FAILED"') && !error.stdout.includes("fake-password") && error.stderr === "",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("wrapper decodes and runs the verifier dry-run", async () => {
  const { stdout, stderr } = await execFileAsync("bash", ["scripts/pitr/run-pitr-readonly-verifier.sh"], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, DRY_RUN: "1", PITR_TARGET_INSTANCE: target, PITR_READ_ONLY: "1", PITR_DATABASE_URL: "postgresql://fake-password@fixture/shipmastr" },
  });
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).ok, true);
});

test("wrapper handles a path containing spaces", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pitr verifier spaces "));
  const wrapperPath = join(temp, "run-pitr-readonly-verifier.sh");
  await writeFile(join(temp, "pitr-readonly-verify.mjs"), await readFile(new URL("./pitr-readonly-verify.mjs", import.meta.url)));
  await writeFile(wrapperPath, await readFile(new URL("./run-pitr-readonly-verifier.sh", import.meta.url)), { mode: 0o700 });
  try {
    const { stdout } = await execFileAsync("bash", [wrapperPath], {
      cwd: backendRoot,
      env: { ...process.env, DRY_RUN: "1", PITR_TARGET_INSTANCE: target, PITR_READ_ONLY: "1" },
    });
    assert.equal(JSON.parse(stdout).ok, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("missing verifier file fails closed", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pitr-wrapper-missing-"));
  const wrapperPath = join(temp, "run-pitr-readonly-verifier.sh");
  await writeFile(wrapperPath, await readFile(new URL("./run-pitr-readonly-verifier.sh", import.meta.url)), { mode: 0o700 });
  try {
    await assert.rejects(execFileAsync("bash", [wrapperPath], { cwd: backendRoot, env: { ...process.env, DRY_RUN: "1", PITR_TARGET_INSTANCE: target, PITR_READ_ONLY: "1" } }), (error) => error.code === 2 && error.stdout.includes('"code":"WRAPPER_BOOTSTRAP_FAILED"') && !String(error.stdout).includes("fake-password"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("wrapper cleans its temporary decoded files", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pitr-wrapper-cleanup-"));
  const wrapperPath = join(temp, "run-pitr-readonly-verifier.sh");
  await writeFile(join(temp, "pitr-readonly-verify.mjs"), await readFile(new URL("./pitr-readonly-verify.mjs", import.meta.url)));
  await writeFile(wrapperPath, await readFile(new URL("./run-pitr-readonly-verifier.sh", import.meta.url)), { mode: 0o700 });
  const scratch = await mkdtemp(join(tmpdir(), "pitr-wrapper-tmp-"));
  try {
    await execFileAsync("bash", [wrapperPath], { cwd: backendRoot, env: { ...process.env, DRY_RUN: "1", PITR_TARGET_INSTANCE: target, PITR_READ_ONLY: "1", TMPDIR: scratch } });
    assert.deepEqual(await readdir(scratch), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("wrapper has no nested JavaScript or eval", async () => {
  const source = await readFile(new URL("./run-pitr-readonly-verifier.sh", import.meta.url), "utf8");
  assert.equal(source.includes("node -e"), false);
  assert.equal(source.includes("eval"), false);
  assert.equal(source.includes("Syntax error"), false);
});

test("previous shell parentheses pattern is not present", async () => {
  const source = await readFile(new URL("./run-pitr-readonly-verifier.sh", import.meta.url), "utf8");
  assert.equal(source.includes("node -e"), false);
  assert.equal(source.includes("'SELECT"), false);
  assert.equal(source.includes("base64 --decode"), true);
  assert.equal(source.includes("base64 -D"), true);
});
