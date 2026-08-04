import assert from "node:assert/strict";
import test from "node:test";

import {
  assertOwnerReconciliationSafety,
  OWNER_EMAIL,
  OWNER_PRODUCTION_RECONCILIATION_APPROVAL,
  OWNER_RECONCILIATION_APPROVAL,
  sanitizeOwnerReconciliationError
} from "./reconcile-shipmastr-owner-master-admin.mjs";

function validSource(overrides = {}) {
  return {
    SHIPMASTR_OWNER_RECONCILIATION_APPROVAL: OWNER_RECONCILIATION_APPROVAL,
    OWNER_MASTER_ADMIN_TARGET_EMAIL: OWNER_EMAIL,
    OWNER_MASTER_ADMIN_OPERATOR: "security-operator@shipmastr.com",
    OWNER_MASTER_ADMIN_REASON: "Restore the permanent Shipmastr owner authority.",
    APP_ENV: "development",
    TARGET_ENV: "development",
    DATABASE_URL: "postgresql://user:password@127.0.0.1:5433/shipmastr_dev",
    OWNER_RECONCILIATION_EXPECTED_DATABASE: "shipmastr_dev",
    ...overrides
  };
}

test("accepts an exact, explicit non-production reconciliation request", () => {
  const result = assertOwnerReconciliationSafety(validSource());
  assert.equal(result.ownerEmail, OWNER_EMAIL);
  assert.equal(result.appEnv, "development");
  assert.equal(result.databaseName, "shipmastr_dev");
});

test("rejects wrong target email and missing approval", () => {
  assert.throws(
    () => assertOwnerReconciliationSafety(validSource({
      OWNER_MASTER_ADMIN_TARGET_EMAIL: "other@example.com"
    })),
    /must exactly equal/
  );

  assert.throws(
    () => assertOwnerReconciliationSafety(validSource({
      SHIPMASTR_OWNER_RECONCILIATION_APPROVAL: ""
    })),
    /is not exact/
  );
});

test("rejects ambiguous database targets", () => {
  assert.throws(
    () => assertOwnerReconciliationSafety(validSource({
      OWNER_RECONCILIATION_EXPECTED_DATABASE: "another_database"
    })),
    /does not match/
  );
});

test("requires a separate exact production approval", () => {
  const production = validSource({
    APP_ENV: "production",
    TARGET_ENV: "production",
    DATABASE_URL: "postgresql://user:password@db.example/shipmastr_prod",
    OWNER_RECONCILIATION_EXPECTED_DATABASE: "shipmastr_prod"
  });

  assert.throws(
    () => assertOwnerReconciliationSafety(production),
    /exact second approval/
  );

  assert.doesNotThrow(() => assertOwnerReconciliationSafety({
    ...production,
    SHIPMASTR_PRODUCTION_OWNER_RECONCILIATION_APPROVAL: OWNER_PRODUCTION_RECONCILIATION_APPROVAL
  }));
});

test("refuses live service execution and redacts database URLs", () => {
  assert.throws(
    () => assertOwnerReconciliationSafety(validSource({ K_SERVICE: "shipmastr-api" })),
    /live Cloud Run service/
  );

  const sanitized = sanitizeOwnerReconciliationError(
    new Error("failed postgresql://user:secret@example.com:5432/shipmastr_prod")
  );
  assert.doesNotMatch(sanitized, /user:secret/);
  assert.match(sanitized, /\[redacted-database-url\]/);
});
