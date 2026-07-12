#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { assertLocalTarget, inspectPostgresContainer, quoteLiteral, runPsql, waitForPostgres } from "./db-local.mjs";
import { makeScratchName } from "./db-scratch-guards.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
assertLocalTarget();
const container = inspectPostgresContainer();
if (container.state !== "running") throw new Error("PostgreSQL container is not running; run npm run db:up first");
waitForPostgres();
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const name = makeScratchName(sha);
runPsql("postgres", `CREATE DATABASE "${name}";`);
let dropped = false;
const drop = () => {
  if (dropped) return;
  const result = spawnSync(process.execPath, [new URL("./db-scratch-drop.mjs", import.meta.url).pathname, name], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`SCRATCH_DB_REMAINS=${name}`);
    throw new Error(`Scratch teardown failed for ${name}`);
  }
  dropped = true;
  process.stdout.write(result.stdout);
};
const url = `postgresql://postgres:postgres@127.0.0.1:5433/${name}`;
function safeOutput(value) {
  return String(value ?? "")
    .replaceAll(url, "<redacted scratch URL>")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "<redacted PostgreSQL URL>");
}
const safeEnv = {
  ...process.env,
  DATABASE_URL: url,
  APP_ENV: "test",
  NODE_ENV: "test",
  JWT_SECRET: process.env.JWT_SECRET || "scratch-test-jwt-secret-generated-for-local-only-32",
  APP_SECRET_PEPPER: process.env.APP_SECRET_PEPPER || "scratch-test-pepper-generated",
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "scratch-test-webhook-secret-generated-local-only"
};
try {
  const current = runPsql(name, "SELECT current_database();");
  if (!/^shipmastr_scratch_[a-zA-Z0-9_]+$/.test(current)) throw new Error(`Live database assertion refused: ${current}`);
  console.log(`Scratch database live assertion: ${current}`);

  const validate = spawnSync("npx", ["prisma", "validate"], { cwd: root, env: safeEnv, encoding: "utf8" });
  process.stdout.write(safeOutput(validate.stdout));
  process.stderr.write(safeOutput(validate.stderr));
  if (validate.status !== 0) throw new Error("Prisma validation failed");

  const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], { cwd: root, env: safeEnv, encoding: "utf8" });
  process.stdout.write(safeOutput(migrate.stdout));
  process.stderr.write(safeOutput(migrate.stderr));
  if (migrate.status !== 0) throw new Error("Prisma migration chain failed on scratch database");

  const status = spawnSync("npx", ["prisma", "migrate", "status"], { cwd: root, env: safeEnv, encoding: "utf8" });
  process.stdout.write(safeOutput(status.stdout));
  process.stderr.write(safeOutput(status.stderr));
  if (status.status !== 0) throw new Error("Prisma migration status failed on scratch database");

  const table = runPsql(name, "SELECT to_regclass('public.auth_abuse_states');");
  if (table !== "auth_abuse_states") throw new Error("AuthAbuseState table was not created by the migration chain");
  const columns = runPsql(name, "SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='auth_abuse_states';");
  console.log(`AuthAbuseState columns verified: ${columns}`);
  const indexes = runPsql(name, "SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname='public' AND tablename='auth_abuse_states';");
  if (!indexes.includes("auth_abuse_states_scope_key_key") || !indexes.includes("auth_abuse_states_lock_until_idx")) throw new Error("AuthAbuseState indexes are incomplete");
  console.log(`AuthAbuseState indexes verified: ${indexes}`);

  const build = spawnSync("npm", ["run", "build"], { cwd: root, env: safeEnv, encoding: "utf8" });
  process.stdout.write(safeOutput(build.stdout));
  process.stderr.write(safeOutput(build.stderr));
  if (build.status !== 0) throw new Error("Backend build failed before scratch DB tests");
  const tests = spawnSync(process.execPath, ["--test", "dist/modules/auth/auth-abuse.postgres.test.js"], {
    cwd: root,
    env: { ...safeEnv, RUN_SCRATCH_DB_TESTS: "1" },
    encoding: "utf8"
  });
  process.stdout.write(safeOutput(tests.stdout));
  process.stderr.write(safeOutput(tests.stderr));
  if (tests.status !== 0) throw new Error("DB-backed H1 scratch tests failed");
} finally {
  try {
    drop();
  } catch (error) {
    console.error(`SCRATCH_DB_REMAINS=${name}`);
    throw error;
  }
}
