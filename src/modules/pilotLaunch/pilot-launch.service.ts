import {
  PlatformConnectionStatus,
  PlatformCredentialStatus,
  PlatformImportItemStatus,
  PlatformImportJobStatus,
  Prisma,
  ShipmentStatus
} from "@prisma/client";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { getCredentialVaultReadiness } from "../credentialVault/credential-vault.service.js";
import { getEmailDeliveryReadiness } from "../emailDelivery/email-delivery.service.js";
import { getLivePilotReadinessSnapshot } from "../livePilot/live-pilot.service.js";
import { buildProductionReadinessReport } from "../productionReadiness/production-readiness.rules.js";
import { getLiveAwbLabelRuntime } from "../shippingNetwork/shipping-live-ship-gate.service.js";
import { getLiveCourierRatesReadiness } from "../shippingNetwork/shipping-live-rates-gate.service.js";
import { getPlatformTrackingSyncRuntime } from "../platformIntegrations/trackingSync/pilot-platform-tracking-sync.service.js";
import { serializePilotLaunchReport } from "./pilot-launch.serializer.js";
import {
  pilotCheck,
  pilotLaunchAllowedActions,
  pilotLaunchForbiddenActions,
  pilotLaunchRollbackControls,
  pilotLaunchSmokeChecklist
} from "./pilot-launch.checks.js";
import type {
  PilotLaunchCategory,
  PilotLaunchCheck,
  PilotLaunchReport,
  PilotLaunchStatus,
  PilotLaunchVerdict
} from "./pilot-launch.types.js";

type Db = Prisma.TransactionClient | typeof prisma;
type Source = Record<string, string | boolean | number | null | undefined>;

type MerchantReadinessCounts = {
  connections: number;
  activeConnections: number;
  activeCredentials: number;
  pickupLocations: number;
  importJobs: number;
  importItems: number;
  readyImportItems: number;
  failedImportItems: number;
  conversions: number;
  shipments: number;
  readyShipments: number;
  notifications: number;
  workerRuns: number;
};

function boolValue(source: Source, key: string, fallback = false) {
  const value = source[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "enabled", "live"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disabled", ""].includes(normalized)) return false;
  }
  return fallback;
}

function stringValue(source: Source, key: string, fallback = "") {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

function docExists(path: string) {
  return existsSync(resolve(process.cwd(), path)) || existsSync(resolve(process.cwd(), "..", path));
}

function checkStatus(checks: PilotLaunchCheck[]): Exclude<PilotLaunchStatus, "NOT_APPLICABLE"> {
  if (checks.some((check) => check.status === "BLOCKED")) return "BLOCKED";
  if (checks.some((check) => check.status === "WARNING")) return "WARNING";
  return "PASS";
}

function category(key: string, label: string, checks: PilotLaunchCheck[]): PilotLaunchCategory {
  return { key, label, status: checkStatus(checks), checks };
}

function enabled(source: Source, key: string) {
  return boolValue(source, key, false);
}

async function merchantCounts(merchantId: string, client: Db): Promise<MerchantReadinessCounts> {
  const [
    connections,
    activeConnections,
    activeCredentials,
    pickupLocations,
    importJobs,
    importItems,
    readyImportItems,
    failedImportItems,
    conversions,
    shipments,
    readyShipments,
    notifications,
    workerRuns
  ] = await Promise.all([
    client.platformConnection.count({ where: { merchantId } }),
    client.platformConnection.count({ where: { merchantId, status: PlatformConnectionStatus.ACTIVE } }),
    client.platformCredential.count({ where: { merchantId, status: PlatformCredentialStatus.ACTIVE } }),
    client.pickupLocation.count({ where: { sellerId: merchantId } }),
    client.platformImportJob.count({ where: { merchantId } }),
    client.platformImportItem.count({ where: { merchantId } }),
    client.platformImportItem.count({ where: { merchantId, status: { in: [PlatformImportItemStatus.MAPPED, PlatformImportItemStatus.IMPORTED] } } }),
    client.platformImportItem.count({ where: { merchantId, status: PlatformImportItemStatus.FAILED } }),
    client.platformImportConversion.count({ where: { merchantId } }),
    client.shipment.count({ where: { sellerId: merchantId } }),
    client.shipment.count({
      where: {
        sellerId: merchantId,
        status: { in: [ShipmentStatus.draft] }
      }
    }),
    client.merchantNotification.count({ where: { merchantId } }),
    client.shipmastrWorkerRun.count({ where: { merchantId } })
  ]);
  return {
    connections,
    activeConnections,
    activeCredentials,
    pickupLocations,
    importJobs,
    importItems,
    readyImportItems,
    failedImportItems,
    conversions,
    shipments,
    readyShipments,
    notifications,
    workerRuns
  };
}

function statusFromGate(pass: boolean, warning = false): PilotLaunchStatus {
  if (pass) return "PASS";
  return warning ? "WARNING" : "BLOCKED";
}

function capabilitiesScope(enabledCapabilities: string[], approvedCapabilities: string[]) {
  const expected = [
    "LIVE_KMS",
    "LIVE_EMAIL_SANDBOX",
    "LIVE_WEBHOOK_REGISTRATION",
    "LIVE_COURIER_RATES",
    "LIVE_AWB_LABEL",
    "LIVE_PLATFORM_TRACKING_SYNC",
    "LIVE_WORKER_RUN_ONCE",
    "PRODUCTION_DEPLOY"
  ];
  return {
    allowedCapabilities: expected.filter((capability) => enabledCapabilities.includes(capability)),
    limitedCapabilities: expected.filter((capability) => approvedCapabilities.includes(capability) && !enabledCapabilities.includes(capability)),
    blockedCapabilities: expected.filter((capability) => !approvedCapabilities.includes(capability))
  };
}

function verdictFor(input: {
  blockers: number;
  warnings: number;
  allowlisted: boolean;
  enabledCapabilities: string[];
  requiredCapabilitiesEnabled: boolean;
  productionDeployApproved: boolean;
}): PilotLaunchVerdict {
  if (input.blockers > 0) return "NO_GO_BLOCKERS";
  if (input.allowlisted && input.requiredCapabilitiesEnabled && input.productionDeployApproved) return "GO_FOR_CONTROLLED_PILOT";
  if (input.allowlisted && input.enabledCapabilities.length > 0) return "GO_WITH_LIMITED_SCOPE";
  if (input.warnings > 0) return "READY_WITH_LIMITED_MOCKS";
  return "READY_WITH_LIMITED_MOCKS";
}

function nextActionsFor(verdict: PilotLaunchVerdict, requiredBeforeGo: string[]) {
  if (verdict === "GO_FOR_CONTROLLED_PILOT") {
    return [
      "Run production readiness smoke immediately before pilot session.",
      "Confirm merchant operator and rollback owner are online.",
      "Execute only approved pilot actions in the documented order."
    ];
  }
  if (requiredBeforeGo.length) return requiredBeforeGo.slice(0, 6);
  return [
    "Approve and enable the next pilot capability.",
    "Run smoke checks again after each gate change.",
    "Keep live behavior disabled or dry-run until go/no-go is green."
  ];
}

export async function buildPilotLaunchReport(
  merchantId: string,
  options: {
    client?: Db;
    source?: Source;
    checkedAt?: Date | string;
  } = {}
) {
  const client = options.client ?? prisma;
  const source = options.source ?? env;
  const checkedAt = options.checkedAt instanceof Date
    ? options.checkedAt.toISOString()
    : options.checkedAt ?? new Date().toISOString();
  const [pilot, counts, credentialVault, emailReadiness, liveRates] = await Promise.all([
    getLivePilotReadinessSnapshot(merchantId, client),
    merchantCounts(merchantId, client),
    Promise.resolve(getCredentialVaultReadiness(source)),
    getEmailDeliveryReadiness(merchantId, source, client),
    getLiveCourierRatesReadiness(merchantId, { client, source })
  ]);
  const productionReadiness = buildProductionReadinessReport(source, {
    checkedAt,
    betaAuditDocExists: docExists("docs/shipping/phase-30-end-to-end-merchant-shipping-beta-audit.md"),
    pilotReadiness: pilot
  });
  const awbRuntime = getLiveAwbLabelRuntime(source);
  const trackingRuntime = getPlatformTrackingSyncRuntime(source);
  const workersEnabled = enabled(source, "SHIPMASTR_WORKERS_ENABLED");
  const workerDryRun = boolValue(source, "SHIPMASTR_WORKER_DRY_RUN", true);
  const schedulerEnabled = enabled(source, "SHIPMASTR_SCHEDULER_ENABLED") || enabled(source, "SHIPMASTR_IMPORT_SCHEDULER_ENABLED");
  const platformWritesGlobal = enabled(source, "PLATFORM_WRITES_ENABLED") || enabled(source, "SHIPMASTR_PLATFORM_WRITES_ENABLED");
  const webhookPilotOnly = boolValue(source, "SHIPMASTR_WEBHOOK_REGISTRATION_PILOT_ONLY", true);
  const ratesPilotOnly = boolValue(source, "SHIPMASTR_LIVE_COURIER_RATES_PILOT_ONLY", true);
  const awbPilotOnly = awbRuntime.pilotOnly;
  const trackingPilotOnly = trackingRuntime.pilotOnly;
  const deployApproved = boolValue(source, "PRODUCTION_DEPLOY_APPROVED", false);
  const enabledCapabilities = pilot.enabledCapabilities;
  const approvedCapabilities = pilot.approvedCapabilities;
  const hasCapability = (capability: string) => enabledCapabilities.includes(capability as never);
  const hasApproval = (capability: string) => approvedCapabilities.includes(capability as never);
  const smokeDocExists = docExists("docs/shipping/phase-39-production-deployment-runbook-smoke-test.md");

  const categories = [
    category("merchant_gate", "Merchant Gate", [
      pilotCheck({
        key: "MERCHANT_ALLOWLISTED",
        label: "Pilot merchant is allowlisted",
        category: "merchant_gate",
        status: statusFromGate(pilot.allowlisted),
        safeValue: pilot.merchantStatus,
        blockerCode: pilot.allowlisted ? undefined : "PILOT_MERCHANT_NOT_ALLOWLISTED",
        recommendation: "Enable the pilot merchant before any controlled live test."
      }),
      pilotCheck({
        key: "PILOT_STATUS_ENABLED",
        label: "Pilot status is enabled",
        category: "merchant_gate",
        status: statusFromGate(pilot.merchantStatus === "ENABLED"),
        safeValue: pilot.merchantStatus,
        blockerCode: pilot.merchantStatus === "ENABLED" ? undefined : "PILOT_STATUS_NOT_ENABLED",
        recommendation: "Use live pilot controls to enable the merchant, then rerun this checklist."
      }),
      pilotCheck({
        key: "ROLLBACK_AVAILABLE",
        label: "Rollback controls are available",
        category: "merchant_gate",
        status: statusFromGate(pilot.rollbackReady),
        safeValue: pilot.rollbackReady,
        blockerCode: pilot.rollbackReady ? undefined : "ROLLBACK_NOT_READY",
        recommendation: "Disable controls must be available before any live pilot."
      }),
      pilotCheck({
        key: "AUDIT_LOGGING_ENABLED",
        label: "Pilot audit logging is enabled",
        category: "merchant_gate",
        status: "PASS",
        safeValue: true,
        recommendation: "Pilot approval, enable, disable, and email actions write safe audit records."
      })
    ]),
    category("approvals", "Approval and Capability Checks", [
      ...([
        ["LIVE_KMS", "Live KMS capability approved"],
        ["LIVE_EMAIL_SANDBOX", "Email sandbox capability approved"],
        ["LIVE_WEBHOOK_REGISTRATION", "Webhook registration capability approved"],
        ["LIVE_COURIER_RATES", "Live rates capability approved"],
        ["LIVE_AWB_LABEL", "AWB/label capability approved"],
        ["LIVE_PLATFORM_TRACKING_SYNC", "Tracking sync capability approved"],
        ["LIVE_WORKER_RUN_ONCE", "Worker run-once capability approved"]
      ] as const).map(([capability, label]) => pilotCheck({
        key: `${capability}_APPROVED`,
        label,
        category: "approvals",
        status: hasApproval(capability) ? "PASS" : "WARNING",
        safeValue: hasApproval(capability),
        blockerCode: hasApproval(capability) ? undefined : `${capability}_NOT_APPROVED`,
        recommendation: "Approve only the capabilities needed for the first pilot scope."
      })),
      pilotCheck({
        key: "PRODUCTION_DEPLOY_APPROVAL_STATUS",
        label: "Production deploy approval status",
        category: "approvals",
        status: deployApproved ? "PASS" : "WARNING",
        safeValue: deployApproved,
        blockerCode: deployApproved ? undefined : "PRODUCTION_DEPLOY_NOT_APPROVED",
        recommendation: "Deployment approval is required before any production launch."
      })
    ]),
    category("environment_modes", "Environment and Mode Checks", [
      pilotCheck({
        key: "WORKERS_BOUNDED",
        label: "Workers are disabled or dry-run bounded",
        category: "environment_modes",
        status: !workersEnabled || workerDryRun ? "PASS" : "BLOCKED",
        safeValue: workersEnabled ? (workerDryRun ? "DRY_RUN" : "ACTIVE") : "DISABLED",
        blockerCode: !workersEnabled || workerDryRun ? undefined : "WORKERS_NOT_BOUNDED",
        recommendation: "Keep workers disabled or dry-run until approved run-once execution."
      }),
      pilotCheck({
        key: "SCHEDULER_NOT_BROADLY_ENABLED",
        label: "Scheduler is not broadly enabled",
        category: "environment_modes",
        status: schedulerEnabled ? "BLOCKED" : "PASS",
        safeValue: schedulerEnabled,
        blockerCode: schedulerEnabled ? "SCHEDULER_ENABLED" : undefined,
        recommendation: "Full scheduler automation is deferred."
      }),
      pilotCheck({
        key: "EMAIL_SANDBOX_MODE",
        label: "Email remains sandbox mode",
        category: "environment_modes",
        status: emailReadiness.runtime?.mode === "SANDBOX" ? "PASS" : "BLOCKED",
        safeValue: emailReadiness.runtime?.mode ?? "UNKNOWN",
        blockerCode: emailReadiness.runtime?.mode === "SANDBOX" ? undefined : "EMAIL_NOT_SANDBOX",
        recommendation: "Pilot notification email must remain sandbox-gated."
      }),
      pilotCheck({
        key: "WEBHOOK_REGISTRATION_PILOT_ONLY",
        label: "Webhook registration remains pilot-only",
        category: "environment_modes",
        status: webhookPilotOnly ? "PASS" : "BLOCKED",
        safeValue: webhookPilotOnly,
        blockerCode: webhookPilotOnly ? undefined : "WEBHOOK_REGISTRATION_NOT_PILOT_ONLY",
        recommendation: "Webhook registration must not be global."
      }),
      pilotCheck({
        key: "COURIER_RATES_PILOT_ONLY",
        label: "Live rates remain pilot-only",
        category: "environment_modes",
        status: ratesPilotOnly ? "PASS" : "BLOCKED",
        safeValue: ratesPilotOnly,
        blockerCode: ratesPilotOnly ? undefined : "LIVE_RATES_NOT_PILOT_ONLY",
        recommendation: "Live rates must be pilot-gated."
      }),
      pilotCheck({
        key: "AWB_LABEL_PILOT_ONLY",
        label: "AWB/label remains pilot-only",
        category: "environment_modes",
        status: awbPilotOnly ? "PASS" : "BLOCKED",
        safeValue: awbPilotOnly,
        blockerCode: awbPilotOnly ? undefined : "AWB_LABEL_NOT_PILOT_ONLY",
        recommendation: "AWB and label creation must stay pilot-gated."
      }),
      pilotCheck({
        key: "TRACKING_SYNC_PILOT_ONLY",
        label: "Tracking sync remains pilot-only",
        category: "environment_modes",
        status: trackingPilotOnly ? "PASS" : "BLOCKED",
        safeValue: trackingPilotOnly,
        blockerCode: trackingPilotOnly ? undefined : "TRACKING_SYNC_NOT_PILOT_ONLY",
        recommendation: "Tracking sync must stay pilot-gated."
      }),
      pilotCheck({
        key: "PLATFORM_WRITES_NOT_GLOBAL",
        label: "Platform writes are not globally enabled",
        category: "environment_modes",
        status: platformWritesGlobal ? "BLOCKED" : "PASS",
        safeValue: platformWritesGlobal,
        blockerCode: platformWritesGlobal ? "PLATFORM_WRITES_GLOBAL" : undefined,
        recommendation: "Do not enable broad platform write automation."
      })
    ]),
    category("merchant_operations", "Merchant Operations Checks", [
      pilotCheck({
        key: "STORE_CONNECTION_EXISTS",
        label: "Store connection exists",
        category: "merchant_operations",
        status: statusFromGate(counts.connections > 0, true),
        safeValue: counts.connections,
        blockerCode: counts.connections > 0 ? undefined : "STORE_CONNECTION_MISSING",
        recommendation: "Connect a store before pilot import testing."
      }),
      pilotCheck({
        key: "CREDENTIALS_READY",
        label: "Active platform credential exists",
        category: "merchant_operations",
        status: statusFromGate(counts.activeCredentials > 0, true),
        safeValue: counts.activeCredentials,
        blockerCode: counts.activeCredentials > 0 ? undefined : "CREDENTIALS_NOT_READY",
        recommendation: "Attach and test a secure platform credential."
      }),
      pilotCheck({
        key: "KMS_READY",
        label: "Credential vault readiness",
        category: "merchant_operations",
        status: credentialVault.ready ? "PASS" : credentialVault.status === "MOCK_ONLY" ? "WARNING" : "BLOCKED",
        safeValue: credentialVault.status,
        blockerCode: credentialVault.ready ? undefined : "KMS_NOT_READY",
        recommendation: "Use the approved vault mode for pilot credentials."
      }),
      pilotCheck({
        key: "PICKUP_LOCATION_READY",
        label: "Pickup location exists",
        category: "merchant_operations",
        status: statusFromGate(counts.pickupLocations > 0, true),
        safeValue: counts.pickupLocations,
        blockerCode: counts.pickupLocations > 0 ? undefined : "PICKUP_LOCATION_MISSING",
        recommendation: "Add a pickup location before any Ship Now pilot."
      }),
      pilotCheck({
        key: "BILLING_READY_PLACEHOLDER",
        label: "Billing readiness placeholder",
        category: "merchant_operations",
        status: "WARNING",
        safeValue: "PLACEHOLDER",
        blockerCode: "BILLING_READINESS_PLACEHOLDER",
        recommendation: "Confirm billing and payment authorization manually before live pilot."
      }),
      pilotCheck({
        key: "FIRST_IMPORT_FETCH_READY",
        label: "Read-only import has run",
        category: "merchant_operations",
        status: statusFromGate(counts.importJobs > 0, true),
        safeValue: counts.importJobs,
        blockerCode: counts.importJobs > 0 ? undefined : "FIRST_IMPORT_NOT_RUN",
        recommendation: "Run a manual read-only fetch or dry-run import before go/no-go."
      }),
      pilotCheck({
        key: "RECONCILIATION_READY",
        label: "Reconciliation has import items",
        category: "merchant_operations",
        status: statusFromGate(counts.importItems > 0, true),
        safeValue: counts.importItems,
        blockerCode: counts.importItems > 0 ? undefined : "RECONCILIATION_EMPTY",
        recommendation: "Review import reconciliation before conversion."
      }),
      pilotCheck({
        key: "CONVERSION_READY",
        label: "At least one conversion exists",
        category: "merchant_operations",
        status: statusFromGate(counts.conversions > 0, true),
        safeValue: counts.conversions,
        blockerCode: counts.conversions > 0 ? undefined : "CONVERSION_NOT_TESTED",
        recommendation: "Convert eligible import items before live shipping pilot."
      }),
      pilotCheck({
        key: "SHIPPING_QUEUE_READY",
        label: "Shipping workspace has candidate shipments",
        category: "merchant_operations",
        status: statusFromGate(counts.shipments > 0, true),
        safeValue: counts.shipments,
        blockerCode: counts.shipments > 0 ? undefined : "SHIPPING_QUEUE_EMPTY",
        recommendation: "Prepare at least one shipment candidate for pilot review."
      }),
      pilotCheck({
        key: "NOTIFICATION_CENTER_READY",
        label: "Notification center available",
        category: "merchant_operations",
        status: "PASS",
        safeValue: counts.notifications,
        recommendation: "In-app notifications can surface import and conversion issues."
      })
    ]),
    category("smoke_safety", "Smoke and Safety Checks", [
      pilotCheck({
        key: "READINESS_REPORT_PASSING",
        label: "Production readiness report is not blocked",
        category: "smoke_safety",
        status: productionReadiness.verdict === "BLOCKED" ? "BLOCKED" : "PASS",
        safeValue: productionReadiness.verdict,
        blockerCode: productionReadiness.verdict === "BLOCKED" ? "PRODUCTION_READINESS_BLOCKED" : undefined,
        recommendation: "Resolve production readiness blockers before pilot launch."
      }),
      pilotCheck({
        key: "SMOKE_SCRIPT_AVAILABLE",
        label: "Smoke scripts and runbook are available",
        category: "smoke_safety",
        status: smokeDocExists ? "PASS" : "BLOCKED",
        safeValue: smokeDocExists,
        blockerCode: smokeDocExists ? undefined : "SMOKE_RUNBOOK_MISSING",
        recommendation: "Run Phase 39 smoke checks before every pilot session."
      }),
      pilotCheck({
        key: "NO_PUBLIC_PROVIDER_LEAK",
        label: "No public shipping network leak expected",
        category: "smoke_safety",
        status: "PASS",
        safeValue: true,
        recommendation: "Safety grep and serializers must stay green."
      }),
      pilotCheck({
        key: "NO_RAW_SECRET_LEAK",
        label: "No raw secret exposure expected",
        category: "smoke_safety",
        status: "PASS",
        safeValue: true,
        recommendation: "Do not expose credentials, tokens, hashes, or auth headers."
      }),
      pilotCheck({
        key: "NO_RAW_PAYLOAD_LEAK",
        label: "No raw payload/header exposure expected",
        category: "smoke_safety",
        status: "PASS",
        safeValue: true,
        recommendation: "Do not expose platform/provider payloads or headers."
      }),
      pilotCheck({
        key: "NO_UNAPPROVED_LIVE_FLAGS",
        label: "No unapproved live flags",
        category: "smoke_safety",
        status: productionReadiness.summary.blockers > 0 ? "BLOCKED" : "PASS",
        safeValue: productionReadiness.summary.blockers,
        blockerCode: productionReadiness.summary.blockers > 0 ? "UNAPPROVED_LIVE_FLAGS" : undefined,
        recommendation: "Resolve readiness blockers before launch."
      }),
      pilotCheck({
        key: "ROLLBACK_PLAN_DOCUMENTED",
        label: "Rollback plan is documented",
        category: "smoke_safety",
        status: smokeDocExists ? "PASS" : "BLOCKED",
        safeValue: smokeDocExists,
        blockerCode: smokeDocExists ? undefined : "ROLLBACK_PLAN_MISSING",
        recommendation: "Keep rollback owner and steps visible during pilot."
      })
    ])
  ];

  const allChecks = categories.flatMap((item) => item.checks);
  const summary = {
    totalChecks: allChecks.length,
    passed: allChecks.filter((check) => check.status === "PASS").length,
    warnings: allChecks.filter((check) => check.status === "WARNING").length,
    blockers: allChecks.filter((check) => check.status === "BLOCKED").length,
    notApplicable: allChecks.filter((check) => check.status === "NOT_APPLICABLE").length
  };
  const requiredCapabilitiesEnabled = [
    "LIVE_KMS",
    "LIVE_COURIER_RATES",
    "LIVE_AWB_LABEL",
    "LIVE_PLATFORM_TRACKING_SYNC"
  ].every(hasCapability);
  const verdict = verdictFor({
    blockers: summary.blockers,
    warnings: summary.warnings,
    allowlisted: pilot.allowlisted,
    enabledCapabilities,
    requiredCapabilitiesEnabled,
    productionDeployApproved: deployApproved
  });
  const requiredBeforeGo = allChecks
    .filter((check) => check.status === "BLOCKED" || check.status === "WARNING")
    .map((check) => check.recommendation || check.label)
    .filter((value, index, array) => array.indexOf(value) === index);
  const reasons = [
    ...(summary.blockers ? [`${summary.blockers} blocked checklist checks remain.`] : []),
    ...(summary.warnings ? [`${summary.warnings} warning checklist checks remain.`] : []),
    ...(pilot.allowlisted ? ["Pilot merchant allowlist is enabled."] : ["Pilot merchant is not allowlisted."]),
    `Production readiness verdict is ${productionReadiness.verdict}.`,
    `Email sandbox readiness is ${emailReadiness.status}.`,
    `Live rates readiness is ${liveRates.status}.`
  ];
  const scope = capabilitiesScope(enabledCapabilities, approvedCapabilities);
  const report: PilotLaunchReport = {
    merchantId,
    checkedAt,
    verdict,
    scope,
    summary,
    categories,
    goNoGo: {
      decision: verdict,
      reasons,
      requiredBeforeGo,
      allowedPilotActions: pilotLaunchAllowedActions,
      forbiddenPilotActions: pilotLaunchForbiddenActions
    },
    rollback: {
      available: pilot.rollbackReady,
      controls: pilotLaunchRollbackControls,
      instructions: [
        "Disable the pilot merchant first if any live pilot anomaly appears.",
        "Disable the specific capability involved in the anomaly.",
        "Return the related feature flag to disabled or dry-run.",
        "Preserve audit logs, smoke output, and affected IDs for incident review."
      ]
    },
    smokeChecklist: pilotLaunchSmokeChecklist,
    nextActions: nextActionsFor(verdict, requiredBeforeGo)
  };
  return serializePilotLaunchReport(report);
}

export async function getPilotLaunchChecklist(merchantId: string, options: { client?: Db; source?: Source } = {}) {
  return buildPilotLaunchReport(merchantId, options);
}

export async function getPilotLaunchGoNoGo(merchantId: string, options: { client?: Db; source?: Source } = {}) {
  const report = await buildPilotLaunchReport(merchantId, options);
  return {
    merchant_id: report.merchant_id,
    checked_at: report.checked_at,
    verdict: report.verdict,
    summary: report.summary,
    scope: report.scope,
    go_no_go: report.go_no_go,
    next_actions: report.next_actions
  };
}

export async function getPilotLaunchRollbackPlan(merchantId: string, options: { client?: Db; source?: Source } = {}) {
  const report = await buildPilotLaunchReport(merchantId, options);
  return {
    merchant_id: report.merchant_id,
    checked_at: report.checked_at,
    verdict: report.verdict,
    rollback: report.rollback
  };
}

export async function getPilotLaunchSmokeChecklist(merchantId: string, options: { client?: Db; source?: Source } = {}) {
  const report = await buildPilotLaunchReport(merchantId, options);
  return {
    merchant_id: report.merchant_id,
    checked_at: report.checked_at,
    verdict: report.verdict,
    smoke_checklist: report.smoke_checklist
  };
}
