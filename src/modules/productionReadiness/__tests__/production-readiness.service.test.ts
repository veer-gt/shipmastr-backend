import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildProductionReadinessReport } from "../production-readiness.rules.js";
import {
  serializeLiveEnablementPlan,
  serializeProductionReadinessChecks,
  serializeProductionReadinessReport
} from "../production-readiness.serializer.js";

const baseSource = {
  NODE_ENV: "test",
  APP_ENV: "test",
  CREDENTIAL_VAULT_PROVIDER: "LOCAL_MOCK",
  CREDENTIAL_VAULT_ROTATION_ENABLED: "false",
  PLATFORM_INTEGRATIONS_ENABLE_REAL_READS: "false",
  SHIPMASTR_WORKERS_ENABLED: "false",
  SHIPMASTR_IMPORT_WORKER_ENABLED: "false",
  SHIPMASTR_WEBHOOK_WORKER_ENABLED: "false",
  SHIPMASTR_NOTIFICATION_WORKER_ENABLED: "false",
  SHIPMASTR_RETRY_WORKER_ENABLED: "false",
  SHIPMASTR_WORKER_DRY_RUN: "true",
  SHIPMASTR_WORKER_MAX_BATCH: "25",
  SHIPMASTR_WORKER_LOCK_SECONDS: "300",
  BIGSHIP_ENABLE_REAL_CALLS: "false",
  BIGSHIP_MODE: "mock",
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASS: "",
  JOURNAL_EMAIL_LIVE_SEND: "false"
};

function report(overrides: Record<string, string | boolean | number | undefined | null> = {}) {
  return buildProductionReadinessReport({ ...baseSource, ...overrides }, {
    checkedAt: "2026-06-09T00:00:00.000Z",
    betaAuditDocExists: true
  });
}

function json(value: unknown) {
  return JSON.stringify(value);
}

describe("production readiness gate", () => {
  it("defaults to controlled beta with limited mocks and not live-ready", () => {
    const readiness = report();
    assert.equal(readiness.verdict, "READY_WITH_LIMITED_MOCKS");
    assert.equal(readiness.betaVerdict, "READY_WITH_LIMITED_MOCKS");
    assert.equal(readiness.liveVerdict, "NOT_READY_FOR_LIVE");
    assert.equal(readiness.safetyBoundaries.productionLiveBehaviorEnabled, false);
    assert.equal(readiness.safetyBoundaries.deploymentPerformed, false);
    assert.ok(readiness.summary.warnings >= 1);
    assert.match(json(readiness.categories), /MOCK_CREDENTIAL_VAULT/);
  });

  it("allows disabled or dry-run workers for beta but blocks uncontrolled active workers", () => {
    const dryRun = report({
      SHIPMASTR_WORKERS_ENABLED: "true",
      SHIPMASTR_IMPORT_WORKER_ENABLED: "true",
      SHIPMASTR_WORKER_DRY_RUN: "true"
    });
    assert.equal(dryRun.verdict, "READY_WITH_LIMITED_MOCKS");
    assert.doesNotMatch(json(dryRun), /WORKERS_ENABLED_WITHOUT_DRY_RUN_OFF_APPROVAL/);

    const active = report({
      SHIPMASTR_WORKERS_ENABLED: "true",
      SHIPMASTR_IMPORT_WORKER_ENABLED: "true",
      SHIPMASTR_WORKER_DRY_RUN: "false"
    });
    assert.equal(active.verdict, "BLOCKED");
    assert.equal(active.liveVerdict, "BLOCKED");
    assert.match(json(active), /WORKERS_ENABLED_WITHOUT_DRY_RUN_OFF_APPROVAL/);
  });

  it("blocks scheduler, email, webhook registration, platform writes, and tracking sync without approval", () => {
    const blocked = report({
      SHIPMASTR_SCHEDULER_ENABLED: "true",
      SHIPMASTR_EMAIL_LIVE_SEND: "true",
      SMTP_HOST: "",
      PLATFORM_WEBHOOK_REGISTRATION_ENABLED: "true",
      PLATFORM_WRITES_ENABLED: "true",
      PLATFORM_TRACKING_SYNC_ENABLED: "true"
    });
    const serialized = json(blocked);
    assert.equal(blocked.verdict, "BLOCKED");
    assert.match(serialized, /SCHEDULER_ENABLED_WITHOUT_APPROVAL/);
    assert.match(serialized, /EMAIL_ENABLED_WITHOUT_PROVIDER/);
    assert.match(serialized, /WEBHOOK_REGISTRATION_ENABLED/);
    assert.match(serialized, /PLATFORM_WRITES_ENABLED/);
    assert.match(serialized, /TRACKING_SYNC_ENABLED/);
  });

  it("blocks live shipping network calls and live AWB/label flags without approval and allowlist", () => {
    const blocked = report({
      BIGSHIP_ENABLE_REAL_CALLS: "true",
      SHIPMASTR_AWB_LABEL_LIVE_ENABLED: "true",
      LIVE_COURIER_PROVIDER_APPROVED: "false",
      SHIPMASTR_LIVE_MERCHANT_ALLOWLIST: ""
    });
    const serialized = json(blocked);
    assert.equal(blocked.verdict, "BLOCKED");
    assert.match(serialized, /COURIER_LIVE_CALLS_ENABLED/);
    assert.match(serialized, /MISSING_MERCHANT_ALLOWLIST/);
    assert.equal(blocked.safetyBoundaries.liveShippingNetworkCallsEnabled, false);
    assert.equal(blocked.safetyBoundaries.liveAwbLabelBehaviorNewlyEnabled, false);
  });

  it("can only mark controlled live pilot ready when live prerequisites and approvals are explicit", () => {
    const ready = report({
      CREDENTIAL_VAULT_PROVIDER: "LOCAL_ENCRYPTED",
      LIVE_KMS_PROVIDER_APPROVED: "true",
      PRODUCTION_DEPLOY_APPROVED: "true",
      SHIPMASTR_LIVE_MERCHANT_ALLOWLIST: "merchant_pilot_1"
    });
    assert.equal(ready.verdict, "READY_WITH_LIMITED_MOCKS");
    assert.equal(ready.liveVerdict, "READY_FOR_CONTROLLED_LIVE_PILOT");
  });

  it("serializers never expose raw env values, credentials, tokens, hashes, headers, or internal shipping network names", () => {
    const readiness = report({
      SMTP_PASS: "smtp-super-secret",
      WEBHOOK_SECRET: "webhook-super-secret",
      BIGSHIP_API_KEY: "provider-secret-key",
      CREDENTIAL_VAULT_ENCRYPTION_KEY: "vault-secret"
    });
    const serialized = json(serializeProductionReadinessReport(readiness));
    assert.doesNotMatch(serialized, /smtp-super-secret|webhook-super-secret|provider-secret-key|vault-secret/i);
    assert.doesNotMatch(serialized, /accessToken|consumerSecret|Authorization|Bearer|rawPayload|rawHeaders|rawResponse|credentialHash|secretHash/i);
    assert.doesNotMatch(serialized, /Bigship/i);
  });

  it("check and plan serializers remain safe and read-only", () => {
    const readiness = report();
    const checks = serializeProductionReadinessChecks(readiness);
    const plan = serializeLiveEnablementPlan(readiness);
    assert.equal(checks.summary.totalChecks, readiness.summary.totalChecks);
    assert.equal(plan.approval_checklist.approval_required, true);
    assert.equal(plan.live_enablement_plan.length, 10);
    assert.doesNotMatch(json({ checks, plan }), /rawPayload|rawHeaders|rawResponse|secretHash|credentialHash|Bigship/i);
  });

  it("routes are GET-only and do not expose activation actions", () => {
    const routes = readFileSync("src/modules/productionReadiness/production-readiness.routes.ts", "utf8");
    assert.match(routes, /get\("\/production-readiness\/report"/);
    assert.match(routes, /get\("\/production-readiness\/checks"/);
    assert.match(routes, /get\("\/production-readiness\/live-enablement-plan"/);
    assert.doesNotMatch(routes, /\.post|\.put|\.patch|\.delete|activate|deploy/i);
  });

  it("service does not mutate settings, call external platforms, send email, or create shipping records", () => {
    const service = readFileSync("src/modules/productionReadiness/production-readiness.service.ts", "utf8");
    const rules = readFileSync("src/modules/productionReadiness/production-readiness.rules.ts", "utf8");
    const combined = `${service}\n${rules}`;
    assert.doesNotMatch(combined, /prisma|fetch\(|axios|sendMail|nodemailer|createLabel|getLabel|manifestOrder|getRates|shipNow|createShipment|setInterval|cron/i);
  });
});
