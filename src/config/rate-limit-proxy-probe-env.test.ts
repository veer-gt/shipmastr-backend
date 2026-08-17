import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const VALID_TOKEN = "a".repeat(64);

function runEnv(overrides: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    APP_ENV: "staging",
    DATABASE_URL: "postgresql://x:x@127.0.0.1:5432/x",
    JWT_SECRET: "j".repeat(32),
    APP_SECRET_PEPPER: "p".repeat(16),
    WEBHOOK_SECRET: "w".repeat(32),
    COURIER_AUDIT_INTAKE_ENABLED: "false",
    ...overrides
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import('./dist/config/env.js').then(({env}) => console.log(JSON.stringify({configured: Boolean(env.RATE_LIMIT_PROXY_PROBE_TOKEN)})))"
  ], { env, encoding: "utf8" });
}

test("rate-limit proxy probe token is optional", () => {
  const result = runEnv({ RATE_LIMIT_PROXY_PROBE_TOKEN: undefined });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"configured":false/);
});

test("staging accepts an exact 64-character hexadecimal probe token", () => {
  const result = runEnv({ RATE_LIMIT_PROXY_PROBE_TOKEN: VALID_TOKEN });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"configured":true/);
});

test("production fails closed when the probe token is configured", () => {
  const result = runEnv({ APP_ENV: "production", RATE_LIMIT_PROXY_PROBE_TOKEN: VALID_TOKEN });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RATE_LIMIT_PROXY_PROBE_TOKEN_STAGING_ONLY/);
});

test("probe tokens must contain exactly 64 hexadecimal characters", () => {
  for (const token of ["a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
    const result = runEnv({ RATE_LIMIT_PROXY_PROBE_TOKEN: token });
    assert.notEqual(result.status, 0);
  }
});
