import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

describe("controlled pilot production smoke checks", () => {
  it("production readiness smoke passes by default without mutating production", () => {
    const result = spawnSync("node", ["scripts/smoke/production-readiness-smoke.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SHIPMASTR_WORKERS_ENABLED: "false",
        SHIPMASTR_WORKER_DRY_RUN: "true",
        SHIPMASTR_EMAIL_ENABLED: "false",
        SHIPMASTR_WEBHOOK_REGISTRATION_ENABLED: "false",
        SHIPMASTR_LIVE_COURIER_RATES_ENABLED: "false",
        SHIPMASTR_LIVE_AWB_LABEL_ENABLED: "false",
        SHIPMASTR_PLATFORM_TRACKING_SYNC_ENABLED: "false",
        BIGSHIP_ENABLE_REAL_CALLS: "false"
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "READY_WITH_LIMITED_MOCKS");
    assert.equal(report.live_flags.scheduler, "DISABLED");
    assert.deepEqual(report.hard_stops, []);
  });

  it("pilot live smoke blocks live actions without approvals and allowlist", () => {
    const result = spawnSync("node", ["scripts/smoke/production-readiness-smoke.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SHIPMASTR_LIVE_COURIER_RATES_ENABLED: "true",
        SHIPMASTR_LIVE_COURIER_RATES_MODE: "LIVE",
        SHIPMASTR_LIVE_AWB_LABEL_ENABLED: "true",
        SHIPMASTR_LIVE_AWB_LABEL_MODE: "LIVE",
        SHIPMASTR_PLATFORM_TRACKING_SYNC_ENABLED: "true",
        SHIPMASTR_PLATFORM_TRACKING_SYNC_MODE: "LIVE",
        LIVE_COURIER_PROVIDER_APPROVED: "false",
        LIVE_PLATFORM_WRITE_APPROVED: "false",
        SHIPMASTR_LIVE_MERCHANT_ALLOWLIST: ""
      }
    });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "HARD_STOP");
    assert.ok(report.hard_stops.includes("LIVE_RATES_WITHOUT_APPROVAL_OR_ALLOWLIST"));
    assert.ok(report.hard_stops.includes("LIVE_AWB_LABEL_WITHOUT_APPROVAL_OR_ALLOWLIST"));
    assert.ok(report.hard_stops.includes("LIVE_TRACKING_SYNC_WITHOUT_APPROVAL_OR_ALLOWLIST"));
  });

  it("smoke helpers do not contain external platform or shipping mutation calls", () => {
    const productionSmoke = readFileSync("scripts/smoke/production-readiness-smoke.mjs", "utf8");
    const pilotSmoke = readFileSync("scripts/smoke/pilot-live-flow-smoke.mjs", "utf8");
    const combined = `${productionSmoke}\n${pilotSmoke}`;
    assert.doesNotMatch(combined, /fetch\(|axios|sendMail|nodemailer|createLabel|getLabel|manifestOrder|getRates|shipNow|registerWebhook|setInterval|cron/i);
  });

  it("runbook doc exists and records hard-stop conditions", () => {
    const docPath = "../docs/shipping/phase-39-production-deployment-runbook-smoke-test.md";
    assert.equal(existsSync(docPath), true);
    const doc = readFileSync(docPath, "utf8");
    assert.match(doc, /No production deployment was performed/);
    assert.match(doc, /Hard-Stop Conditions/);
    assert.doesNotMatch(doc, /accessToken|consumerSecret|credentialHash|secretHash|rawPayload|rawHeaders|Bigship/i);
  });
});
