import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixtureStatusAllowsAuthentication, lifecycleEnabledFor, safeFixtureStatus } from "./h2a-staging-tenant.service.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("lifecycle is enabled only for staging with the explicit flag", () => {
  assert.equal(lifecycleEnabledFor({ appEnv: "staging", enabled: true }), true);
  assert.equal(lifecycleEnabledFor({ appEnv: "production", enabled: true }), false);
  assert.equal(lifecycleEnabledFor({ appEnv: "staging", enabled: false }), false);
});

test("safe status exposes state only and fails closed after expiry", () => {
  const status = safeFixtureStatus({
    status: "ACTIVE" as never,
    expiresAt: new Date("2020-01-01T00:00:00Z"),
    cleanupAt: null,
    merchantId: null
  }, { connections: 0, credentials: 0 }, new Date("2020-01-02T00:00:00Z"));
  assert.equal(status.status, "EXPIRED");
  assert.equal(status.active, false);
  assert.equal(status.ownerEnabled, false);
  assert.equal("merchantId" in status, false);
  assert.equal("password" in status, false);
});

test("fixture authentication is allowed only while ACTIVE and before expiry", () => {
  const now = new Date("2026-07-14T10:00:00Z");
  assert.equal(fixtureStatusAllowsAuthentication({ status: "ACTIVE" as never, expiresAt: new Date("2026-07-14T10:01:00Z"), now }), true);
  assert.equal(fixtureStatusAllowsAuthentication({ status: "ACTIVE" as never, expiresAt: now, now }), false);
  assert.equal(fixtureStatusAllowsAuthentication({ status: "CLEANED" as never, expiresAt: new Date("2026-07-14T10:01:00Z"), now }), false);
});

test("lifecycle source has no email, invite, reset, lead, Firebase, or automation dependency", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/modules/securityFixtures/h2a-staging-tenant.service.ts"), "utf8");
  for (const forbidden of ["sendTransactionalEmail", "createSellerInvite", "password-reset", "lead.service", "firebase", "n8n"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes("H2A_CONNECTION_MARKER"), true);
});

test("route and migration gates are fail-closed and additive", () => {
  const routeSource = fs.readFileSync(path.join(repoRoot, "src/modules/securityFixtures/h2a-staging-tenant.routes.ts"), "utf8");
  const indexSource = fs.readFileSync(path.join(repoRoot, "src/routes/index.ts"), "utf8");
  const migration = fs.readFileSync(path.join(repoRoot, "prisma/migrations/20260714100000_h2a_synthetic_tenant_lifecycle/migration.sql"), "utf8");
  assert.equal(routeSource.includes("X-Shipmastr-Security-Fixture"), true);
  assert.equal(routeSource.includes("requireMasterAdminJwt"), true);
  assert.equal(indexSource.includes("H2A_SYNTHETIC_TENANT_LIFECYCLE_ENABLED && env.APP_ENV === \"staging\""), true);
  assert.equal(/\b(DROP TABLE|DROP TYPE|DELETE FROM|UPDATE\s+\")/i.test(migration), false);
});

test("cleanup preserves a stable blocker if failure-state recording itself fails", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/modules/securityFixtures/h2a-staging-tenant.service.ts"), "utf8");
  assert.match(source, /try \{\s*await markCleanupFailed\(fixtureId, code\);\s*\} catch \{/s);
  assert.match(source, /throw new HttpError\(409, code\);/);
});

test("runner contains no cloud, database, migration, deployment, traffic, or provider command", () => {
  const runner = fs.readFileSync(path.join(repoRoot, "scripts/security-fixtures/h2a-second-tenant-runner.py"), "utf8");
  for (const forbidden of ["gcloud", "DATABASE_URL", "subprocess", "psycopg", "docker", "podman", "cloud_sql_proxy", "n8n"]) {
    assert.equal(runner.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.match(runner, /register_sensitive/);
  assert.match(runner, /scan_response/);
});
