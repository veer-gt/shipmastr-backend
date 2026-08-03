import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  getBundledProductionReadinessEvidence,
  productionReadinessAttestation
} from "../production-readiness.attestation.js";

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
    assert.equal(report.attestation.valid, true);
    assert.equal(report.attestation.source_root_commit, "71a44cd93ef9b0dced6712150f48ca7b0db376c3");
    assert.equal(report.attestation.seller_ui_provider_scan.passed, true);
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
    assert.equal(report.attestation.valid, true);
  });

  it("smoke helpers do not contain external mutation calls or runtime source-tree scans", () => {
    const productionSmoke = readFileSync("scripts/smoke/production-readiness-smoke.mjs", "utf8");
    const pilotSmoke = readFileSync("scripts/smoke/pilot-live-flow-smoke.mjs", "utf8");
    const combined = `${productionSmoke}\n${pilotSmoke}`;
    assert.doesNotMatch(combined, /fetch\(|axios|sendMail|nodemailer|createLabel|getLabel|manifestOrder|getRates|shipNow|registerWebhook|setInterval|cron/i);
    assert.doesNotMatch(combined, /readdirSync|statSync|seller-panel\/src|docs\/shipping|process\.cwd\(\)/i);
  });

  it("bundled readiness attestation records immutable reviewed source evidence", () => {
    const evidence = getBundledProductionReadinessEvidence();
    assert.equal(evidence.attestationValid, true);
    assert.equal(evidence.phase30DocumentPresent, true);
    assert.equal(evidence.phase39DocumentPresent, true);
    assert.equal(evidence.sellerUiProviderScanPassed, true);
    assert.equal(productionReadinessAttestation.sourceRootCommit, "71a44cd93ef9b0dced6712150f48ca7b0db376c3");
    assert.equal(productionReadinessAttestation.backendBaseCommit, "224bd09f14271cc87a93d9a17dab7204c14538c7");
    assert.equal(productionReadinessAttestation.documents.phase30BetaAudit.sha256, "a5756394037ab4622df46d1a390aabe1594d3763e1df571ced43bfbe8f7c5d91");
    assert.equal(productionReadinessAttestation.documents.phase39ProductionRunbook.sha256, "c468dd3f1d88702d9fc9d5202f50ce051d0865bfcff64d04b793e7f978b1116b");
    assert.equal(productionReadinessAttestation.sellerUiProviderScan.scannedFiles, 113);
    assert.equal(productionReadinessAttestation.sellerUiProviderScan.treeSha256, "4ac6ce06045e0141f09de01bf365b5791495d0316a45323a193b1eca249c0d61");
    assert.equal(productionReadinessAttestation.sellerUiProviderScan.providerLeakHits, 0);
  });
});
