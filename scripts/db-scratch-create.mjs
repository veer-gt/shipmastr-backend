#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { assertLocalTarget, inspectPostgresContainer, quoteIdentifier, quoteLiteral, redactUrl, runPsql, waitForPostgres } from "./db-local.mjs";
import { assertScratchName, makeScratchName } from "./db-scratch-guards.mjs";

assertLocalTarget();
const container = inspectPostgresContainer();
if (container.state !== "running") throw new Error("PostgreSQL container is not running; run npm run db:up first");
waitForPostgres();
const requested = process.env.SCRATCH_DB_NAME?.trim();
let name = requested ? assertScratchName(requested) : "";
if (!name) {
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  name = makeScratchName(sha);
}
const exists = runPsql("postgres", `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(name)};`);
if (exists === "1") throw new Error(`Scratch database already exists; refusing to drop or reuse it: ${name}`);
runPsql("postgres", `CREATE DATABASE ${quoteIdentifier(name)};`);
const current = runPsql(name, "SELECT current_database();");
if (current !== name) throw new Error("Scratch database live-name assertion failed after creation");
const localDescription = `postgresql://<local-user>:<redacted>@127.0.0.1:5433/${name}`;
console.log(`Scratch database created: ${name}`);
console.log(`Connection (redacted): ${redactUrl(localDescription)}`);
