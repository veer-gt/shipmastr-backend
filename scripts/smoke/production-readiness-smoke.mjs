#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");
const backend = process.cwd();
const sellerPanel = resolve(root, "seller-panel");

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on", "enabled", "live"].includes(String(value).trim().toLowerCase());
}

function stringEnv(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : String(value).trim();
}

function readFiles(dir, predicate, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) readFiles(path, predicate, files);
    else if (predicate(path)) files.push(path);
  }
  return files;
}

function countMatches(paths, pattern) {
  const matches = [];
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    if (pattern.test(text)) matches.push(path);
  }
  return matches;
}

export function buildProductionReadinessSmokeReport(source = process.env) {
  const docs = {
    betaAudit: existsSync(resolve(root, "docs/shipping/phase-30-end-to-end-merchant-shipping-beta-audit.md")),
    productionRunbook: existsSync(resolve(root, "docs/shipping/phase-39-production-deployment-runbook-smoke-test.md"))
  };
  const liveFlags = {
    workersEnabled: boolEnvFrom(source, "SHIPMASTR_WORKERS_ENABLED", false),
    workerDryRun: boolEnvFrom(source, "SHIPMASTR_WORKER_DRY_RUN", true),
    schedulerEnabled: boolEnvFrom(source, "SHIPMASTR_SCHEDULER_ENABLED", false),
    emailEnabled: boolEnvFrom(source, "SHIPMASTR_EMAIL_ENABLED", false),
    emailMode: stringEnvFrom(source, "SHIPMASTR_EMAIL_MODE", "SANDBOX").toUpperCase(),
    webhookRegistrationEnabled: boolEnvFrom(source, "SHIPMASTR_WEBHOOK_REGISTRATION_ENABLED", false),
    webhookRegistrationMode: stringEnvFrom(source, "SHIPMASTR_WEBHOOK_REGISTRATION_MODE", "DRY_RUN").toUpperCase(),
    liveCourierRatesEnabled: boolEnvFrom(source, "SHIPMASTR_LIVE_COURIER_RATES_ENABLED", false),
    liveCourierRatesMode: stringEnvFrom(source, "SHIPMASTR_LIVE_COURIER_RATES_MODE", "DRY_RUN").toUpperCase(),
    liveAwbLabelEnabled: boolEnvFrom(source, "SHIPMASTR_LIVE_AWB_LABEL_ENABLED", false),
    liveAwbLabelMode: stringEnvFrom(source, "SHIPMASTR_LIVE_AWB_LABEL_MODE", "DRY_RUN").toUpperCase(),
    trackingSyncEnabled: boolEnvFrom(source, "SHIPMASTR_PLATFORM_TRACKING_SYNC_ENABLED", false),
    trackingSyncMode: stringEnvFrom(source, "SHIPMASTR_PLATFORM_TRACKING_SYNC_MODE", "DRY_RUN").toUpperCase(),
    platformWritesEnabled: boolEnvFrom(source, "SHIPMASTR_PLATFORM_WRITES_ENABLED", false)
      || boolEnvFrom(source, "PLATFORM_WRITES_ENABLED", false),
    courierRealCallsEnabled: boolEnvFrom(source, "BIGSHIP_ENABLE_REAL_CALLS", false)
      || stringEnvFrom(source, "BIGSHIP_MODE", "mock").toLowerCase() === "live"
  };
  const approvals = {
    liveKms: boolEnvFrom(source, "LIVE_KMS_PROVIDER_APPROVED", false),
    liveCourier: boolEnvFrom(source, "LIVE_COURIER_PROVIDER_APPROVED", false),
    liveEmail: boolEnvFrom(source, "LIVE_EMAIL_PROVIDER_APPROVED", false),
    liveWebhook: boolEnvFrom(source, "LIVE_WEBHOOK_REGISTRATION_APPROVED", false),
    livePlatformWrite: boolEnvFrom(source, "LIVE_PLATFORM_WRITE_APPROVED", false),
    productionDeploy: boolEnvFrom(source, "PRODUCTION_DEPLOY_APPROVED", false)
  };
  const allowlistConfigured = Boolean(stringEnvFrom(source, "SHIPMASTR_LIVE_MERCHANT_ALLOWLIST", ""));
  const hardStops = [];

  if (!docs.betaAudit) hardStops.push("MISSING_PHASE_30_BETA_AUDIT_DOC");
  if (!docs.productionRunbook) hardStops.push("MISSING_PHASE_39_PRODUCTION_RUNBOOK_DOC");
  if (liveFlags.workersEnabled && !liveFlags.workerDryRun && !approvals.productionDeploy) hardStops.push("WORKERS_ACTIVE_WITHOUT_DEPLOY_APPROVAL");
  if (liveFlags.schedulerEnabled && !approvals.productionDeploy) hardStops.push("SCHEDULER_ENABLED_WITHOUT_APPROVAL");
  if (liveFlags.emailEnabled && liveFlags.emailMode === "LIVE" && (!approvals.liveEmail || !allowlistConfigured)) hardStops.push("LIVE_EMAIL_WITHOUT_APPROVAL_OR_ALLOWLIST");
  if (liveFlags.webhookRegistrationEnabled && liveFlags.webhookRegistrationMode === "LIVE" && (!approvals.liveWebhook || !allowlistConfigured)) hardStops.push("LIVE_WEBHOOK_REGISTRATION_WITHOUT_APPROVAL_OR_ALLOWLIST");
  if (liveFlags.platformWritesEnabled && !approvals.livePlatformWrite) hardStops.push("PLATFORM_WRITES_WITHOUT_APPROVAL");
  if (liveFlags.trackingSyncEnabled && liveFlags.trackingSyncMode === "LIVE" && (!approvals.livePlatformWrite || !allowlistConfigured)) hardStops.push("LIVE_TRACKING_SYNC_WITHOUT_APPROVAL_OR_ALLOWLIST");
  if (liveFlags.liveCourierRatesEnabled && liveFlags.liveCourierRatesMode === "LIVE" && (!approvals.liveCourier || !allowlistConfigured)) hardStops.push("LIVE_RATES_WITHOUT_APPROVAL_OR_ALLOWLIST");
  if (liveFlags.liveAwbLabelEnabled && liveFlags.liveAwbLabelMode === "LIVE" && (!approvals.liveCourier || !allowlistConfigured)) hardStops.push("LIVE_AWB_LABEL_WITHOUT_APPROVAL_OR_ALLOWLIST");
  if (liveFlags.courierRealCallsEnabled && !approvals.liveCourier) hardStops.push("COURIER_REAL_CALLS_WITHOUT_APPROVAL");

  const sellerFiles = readFiles(resolve(sellerPanel, "src"), (path) => /\.(jsx?|css)$/.test(path));
  const sellerUnsafeProviderMatches = countMatches(sellerFiles, /\bBigship\b|bigship/);
  if (sellerUnsafeProviderMatches.length) hardStops.push("SELLER_UI_PROVIDER_NAME_LEAK_RISK");

  return {
    verdict: hardStops.length ? "HARD_STOP" : "READY_WITH_LIMITED_MOCKS",
    checked_at: new Date().toISOString(),
    docs,
    live_flags: {
      workers: liveFlags.workersEnabled ? (liveFlags.workerDryRun ? "DRY_RUN" : "ACTIVE") : "DISABLED",
      scheduler: liveFlags.schedulerEnabled ? "ENABLED" : "DISABLED",
      email: liveFlags.emailEnabled ? liveFlags.emailMode : "DISABLED",
      webhook_registration: liveFlags.webhookRegistrationEnabled ? liveFlags.webhookRegistrationMode : "DISABLED",
      platform_writes: liveFlags.platformWritesEnabled ? "ENABLED" : "DISABLED",
      tracking_sync: liveFlags.trackingSyncEnabled ? liveFlags.trackingSyncMode : "DISABLED",
      courier_rates: liveFlags.liveCourierRatesEnabled ? liveFlags.liveCourierRatesMode : "DISABLED",
      awb_label: liveFlags.liveAwbLabelEnabled ? liveFlags.liveAwbLabelMode : "DISABLED"
    },
    allowlist_configured: allowlistConfigured,
    hard_stops: hardStops,
    smoke_checks: [
      "readiness_report_reachable_by_api_contract",
      "pilot_merchant_allowlist_gate_present",
      "credential_readiness_gate_present",
      "read_only_import_foundation_present",
      "reconciliation_foundation_present",
      "conversion_foundation_present",
      "notification_foundation_present",
      "webhook_ingestion_foundation_present",
      "worker_run_once_bounded",
      "live_rates_blocked_without_pilot_approval",
      "live_awb_label_blocked_without_pilot_approval",
      "tracking_sync_blocked_without_pilot_approval",
      "public_serializers_redact_unsafe_values"
    ]
  };
}

function boolEnvFrom(source, name, fallback) {
  const previous = process.env[name];
  if (Object.prototype.hasOwnProperty.call(source, name)) process.env[name] = String(source[name] ?? "");
  const value = boolEnv(name, fallback);
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
  return value;
}

function stringEnvFrom(source, name, fallback) {
  const previous = process.env[name];
  if (Object.prototype.hasOwnProperty.call(source, name)) process.env[name] = String(source[name] ?? "");
  const value = stringEnv(name, fallback);
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = buildProductionReadinessSmokeReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.hard_stops.length) process.exit(1);
}
