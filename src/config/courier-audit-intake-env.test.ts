import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runEnv(overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL || "postgresql://x:x@127.0.0.1:5432/x",
    JWT_SECRET: "j".repeat(32),
    APP_SECRET_PEPPER: "p".repeat(16),
    WEBHOOK_SECRET: "w".repeat(32),
    ...overrides
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawnSync(process.execPath, ["--input-type=module", "-e", "import('./dist/config/env.js').then(({env}) => console.log(JSON.stringify({enabled: env.COURIER_AUDIT_INTAKE_ENABLED, hasSecret: Boolean(env.COURIER_AUDIT_INTAKE_SIGNING_SECRET)})))"], { env, encoding: "utf8" });
}

test("courier audit intake defaults disabled", () => {
  const result = runEnv({ COURIER_AUDIT_INTAKE_ENABLED: undefined, COURIER_AUDIT_INTAKE_SIGNING_SECRET: undefined });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"enabled":false/);
});

test("enabled intake requires dedicated secret", () => {
  const result = runEnv({ COURIER_AUDIT_INTAKE_ENABLED: "true", COURIER_AUDIT_INTAKE_SIGNING_SECRET: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /COURIER_AUDIT_INTAKE_SIGNING_SECRET_REQUIRED/);
});
