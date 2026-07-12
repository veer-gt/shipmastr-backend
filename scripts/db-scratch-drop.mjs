#!/usr/bin/env node
import { assertLocalTarget, inspectPostgresContainer, quoteIdentifier, quoteLiteral, runPsql, waitForPostgres } from "./db-local.mjs";
import { assertDropTarget } from "./db-scratch-guards.mjs";

assertLocalTarget();
const name = assertDropTarget(process.argv[2] ?? process.env.SCRATCH_DB_NAME ?? "");
const container = inspectPostgresContainer();
if (container.state !== "running") throw new Error("PostgreSQL container is not running; refusing scratch teardown");
waitForPostgres();
const exists = runPsql("postgres", `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(name)};`);
if (exists !== "1") {
  console.log(`Scratch database already absent: ${name}`);
  process.exit(0);
}
runPsql("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quoteLiteral(name)} AND pid <> pg_backend_pid();`);
runPsql("postgres", `DROP DATABASE ${quoteIdentifier(name)};`);
const remaining = runPsql("postgres", `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(name)};`);
if (remaining === "1") throw new Error(`Scratch database remains after drop attempt: ${name}`);
console.log(`Scratch database dropped: ${name}`);
