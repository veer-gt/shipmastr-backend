#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { assertLocalTarget, inspectPostgresContainer, quoteIdentifier, quoteLiteral, redactUrl, runPsql, waitForPostgres } from "./db-local.mjs";
import { assertLocalDatabaseUrl, assertScratchName, assertScratchOwner, makeScratchName } from "./db-scratch-guards.mjs";

assertLocalTarget();
const container = inspectPostgresContainer();
if (container.state !== "running") throw new Error("PostgreSQL container is not running; run npm run db:up first");
waitForPostgres();
const scratchUrl = assertLocalDatabaseUrl(process.env.DATABASE_URL);
const owner = assertScratchOwner(decodeURIComponent(scratchUrl.username));
const roleReadiness = runPsql(
  "postgres",
  `SELECT CASE WHEN rolcanlogin AND NOT rolsuper THEN 'LOGIN_NON_SUPERUSER' ELSE 'REFUSED' END FROM pg_roles WHERE rolname = ${quoteLiteral(owner)};`
);
if (roleReadiness !== "LOGIN_NON_SUPERUSER") {
  throw new Error("Scratch database owner must exist, allow login, and not be a superuser");
}
const requested = process.env.SCRATCH_DB_NAME?.trim();
let name = requested ? assertScratchName(requested) : "";
if (!name) {
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  name = makeScratchName(sha);
}
const exists = runPsql("postgres", `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(name)};`);
if (exists === "1") throw new Error(`Scratch database already exists; refusing to drop or reuse it: ${name}`);
runPsql(
  "postgres",
  `CREATE DATABASE ${quoteIdentifier(name)} OWNER ${quoteIdentifier(owner)};`
);
const current = runPsql(name, "SELECT current_database();");
if (current !== name) throw new Error("Scratch database live-name assertion failed after creation");
const actualOwner = runPsql(
  "postgres",
  `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = ${quoteLiteral(name)};`
);
if (actualOwner !== owner) throw new Error("Scratch database owner assertion failed after creation");
const ownerCanCreate = runPsql(
  name,
  `SELECT has_schema_privilege(${quoteLiteral(owner)}, 'public', 'CREATE');`
);
if (ownerCanCreate !== "t") {
  throw new Error("Scratch database owner lacks CREATE privilege on public schema");
}
const localDescription = `postgresql://<local-user>:<redacted>@127.0.0.1:5433/${name}`;
console.log(`Scratch database created: ${name}`);
console.log("Scratch database owner verified as a login-capable non-superuser");
console.log(`Connection (redacted): ${redactUrl(localDescription)}`);
