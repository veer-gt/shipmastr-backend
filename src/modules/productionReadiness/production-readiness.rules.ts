import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../../config/env.js";
import { getCredentialVaultRuntime } from "../credentialVault/credential-vault.providers.js";
import type {
  LiveEnablementStep,
  ProductionReadinessCategory,
  ProductionReadinessCheck,
  ProductionReadinessReport,
  ProductionReadinessSource,
  ProductionReadinessStatus,
  ProductionReadinessSummary,
  ProductionReadinessVerdict
} from "./production-readiness.types.js";

const approvalFlags = {
  LIVE_KMS_PROVIDER_APPROVED: "LIVE_KMS_PROVIDER_APPROVAL",
  LIVE_COURIER_PROVIDER_APPROVED: "LIVE_COURIER_PROVIDER_APPROVAL",
  LIVE_EMAIL_PROVIDER_APPROVED: "LIVE_EMAIL_PROVIDER_APPROVAL",
  LIVE_WEBHOOK_REGISTRATION_APPROVED: "LIVE_WEBHOOK_REGISTRATION_APPROVAL",
  LIVE_PLATFORM_WRITE_APPROVED: "LIVE_PLATFORM_WRITE_APPROVAL",
  PRODUCTION_DEPLOY_APPROVED: "PRODUCTION_DEPLOY_APPROVAL"
} as const;

const livePlan: LiveEnablementStep[] = [
  {
    step: 1,
    title: "Configure live KMS provider",
    status: "NOT_STARTED",
    requiredApproval: "LIVE_KMS_PROVIDER_APPROVAL",
    risk: "HIGH",
    instructions: ["Switch credential vault from local/mock mode to an approved live KMS-backed provider."]
  },
  {
    step: 2,
    title: "Add merchant allowlist for live pilot",
    status: "NOT_STARTED",
    requiredApproval: "PRODUCTION_DEPLOY_APPROVAL",
    risk: "HIGH",
    instructions: ["Enable live actions only for explicitly approved pilot merchant IDs."]
  },
  {
    step: 3,
    title: "Enable real email provider in sandbox mode",
    status: "NOT_STARTED",
    requiredApproval: "LIVE_EMAIL_PROVIDER_APPROVAL",
    risk: "MEDIUM",
    instructions: ["Verify sender domain, SPF, DKIM, DMARC, bounce handling, and opt-out behavior before merchant email delivery."]
  },
  {
    step: 4,
    title: "Register platform webhooks for pilot merchant only",
    status: "NOT_STARTED",
    requiredApproval: "LIVE_WEBHOOK_REGISTRATION_APPROVAL",
    risk: "HIGH",
    instructions: ["Register order webhooks only after signature secret storage, replay defense, and rollback are approved."]
  },
  {
    step: 5,
    title: "Enable production worker run-once controls",
    status: "NOT_STARTED",
    requiredApproval: "PRODUCTION_DEPLOY_APPROVAL",
    risk: "MEDIUM",
    instructions: ["Keep workers bounded, observable, and manually triggered before any scheduler is approved."]
  },
  {
    step: 6,
    title: "Enable scheduled polling after worker audit",
    status: "NOT_STARTED",
    requiredApproval: "PRODUCTION_DEPLOY_APPROVAL",
    risk: "HIGH",
    instructions: ["Enable scheduled import continuation only after queue locks, retry policy, and alerting pass audit."]
  },
  {
    step: 7,
    title: "Enable live shipping network rates for pilot merchant",
    status: "NOT_STARTED",
    requiredApproval: "LIVE_COURIER_PROVIDER_APPROVAL",
    risk: "HIGH",
    instructions: ["Gate live rate calls behind merchant allowlist and rollback controls."]
  },
  {
    step: 8,
    title: "Enable live AWB and label creation for pilot merchant",
    status: "NOT_STARTED",
    requiredApproval: "LIVE_COURIER_PROVIDER_APPROVAL",
    risk: "CRITICAL",
    instructions: ["Enable booking only after rate audit, billing audit, and shipment cancellation fallback are approved."]
  },
  {
    step: 9,
    title: "Enable platform tracking sync for pilot merchant only",
    status: "NOT_STARTED",
    requiredApproval: "LIVE_PLATFORM_WRITE_APPROVAL",
    risk: "HIGH",
    instructions: ["Allow platform writes only after tracking payload contract and reconciliation rollback are approved."]
  },
  {
    step: 10,
    title: "Complete production deployment checklist",
    status: "NOT_STARTED",
    requiredApproval: "PRODUCTION_DEPLOY_APPROVAL",
    risk: "CRITICAL",
    instructions: ["Complete environment, database, logging, alerting, backup, rollback, and incident drills before launch."]
  }
];

const deferredGaps = [
  "Live KMS provider approval and implementation",
  "Merchant allowlist for controlled live pilot",
  "Real email provider approval and sandbox verification",
  "Real platform webhook registration",
  "Real platform write and tracking sync controls",
  "Live shipping network rate, booking, and label approvals",
  "Production deployment approval"
];

const hardStops = [
  "Do not enable platform writes without explicit approval and merchant allowlist.",
  "Do not enable scheduled polling without worker audit and rollback controls.",
  "Do not enable live shipping network calls without pilot approval.",
  "Do not expose secrets, raw headers, raw payloads, or internal shipping network references.",
  "Do not deploy production changes from this readiness gate."
];

function boolValue(source: ProductionReadinessSource, key: string, fallback = false) {
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

function stringValue(source: ProductionReadinessSource, key: string, fallback = "") {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

function approval(source: ProductionReadinessSource, key: keyof typeof approvalFlags) {
  return boolValue(source, key, false);
}

function check(input: ProductionReadinessCheck): ProductionReadinessCheck {
  return input;
}

function category(key: string, label: string, checks: ProductionReadinessCheck[]): ProductionReadinessCategory {
  const status = checks.some((item) => item.status === "BLOCKED")
    ? "BLOCKED"
    : checks.some((item) => item.status === "WARNING")
      ? "WARNING"
      : "PASS";
  return { key, label, status, checks };
}

function migrationDocExists() {
  return existsSync(resolve(process.cwd(), "../docs/shipping/phase-30-end-to-end-merchant-shipping-beta-audit.md"))
    || existsSync(resolve(process.cwd(), "docs/shipping/phase-30-end-to-end-merchant-shipping-beta-audit.md"));
}

export function productionReadinessPlan() {
  return livePlan;
}

export function buildProductionReadinessReport(
  source: ProductionReadinessSource = env,
  options: {
    checkedAt?: Date | string;
    betaAuditDocExists?: boolean;
    pilotReadiness?: ProductionReadinessReport["pilotReadiness"];
  } = {}
): ProductionReadinessReport {
  const checkedAt = options.checkedAt instanceof Date
    ? options.checkedAt.toISOString()
    : options.checkedAt ?? new Date().toISOString();
  const nodeEnv = stringValue(source, "NODE_ENV", "development");
  const appEnv = stringValue(source, "APP_ENV", "development");
  const vaultRuntime = getCredentialVaultRuntime(source);
  const vaultMode = vaultRuntime.provider;
  const vaultIsMock = vaultRuntime.local_mock;
  const vaultIsLiveReady = vaultRuntime.live_ready;
  const workersEnabled = boolValue(source, "SHIPMASTR_WORKERS_ENABLED", false);
  const importWorkerEnabled = boolValue(source, "SHIPMASTR_IMPORT_WORKER_ENABLED", false);
  const webhookWorkerEnabled = boolValue(source, "SHIPMASTR_WEBHOOK_WORKER_ENABLED", false);
  const notificationWorkerEnabled = boolValue(source, "SHIPMASTR_NOTIFICATION_WORKER_ENABLED", false);
  const retryWorkerEnabled = boolValue(source, "SHIPMASTR_RETRY_WORKER_ENABLED", false);
  const workerDryRun = boolValue(source, "SHIPMASTR_WORKER_DRY_RUN", true);
  const schedulerEnabled = boolValue(source, "SHIPMASTR_SCHEDULER_ENABLED", false)
    || boolValue(source, "SHIPMASTR_IMPORT_SCHEDULER_ENABLED", false);
  const emailProviderConfigured = Boolean(stringValue(source, "SMTP_HOST"))
    && Boolean(stringValue(source, "SMTP_USER"))
    && Boolean(stringValue(source, "SMTP_PASS"));
  const pilotEmailEnabled = boolValue(source, "SHIPMASTR_EMAIL_ENABLED", false);
  const pilotEmailMode = stringValue(source, "SHIPMASTR_EMAIL_MODE", "SANDBOX").toUpperCase();
  const pilotEmailProvider = stringValue(source, "SHIPMASTR_EMAIL_PROVIDER", "LOCAL_LOG").toUpperCase();
  const pilotEmailPilotOnly = boolValue(source, "SHIPMASTR_EMAIL_PILOT_ONLY", true);
  const liveEmailEnabled = boolValue(source, "SHIPMASTR_EMAIL_LIVE_SEND", false)
    || boolValue(source, "MERCHANT_EMAIL_LIVE_SEND", false)
    || boolValue(source, "JOURNAL_EMAIL_LIVE_SEND", false);
  const platformRealReads = boolValue(source, "PLATFORM_INTEGRATIONS_ENABLE_REAL_READS", false);
  const webhookRegistrationEnabled = boolValue(source, "PLATFORM_WEBHOOK_REGISTRATION_ENABLED", false)
    || boolValue(source, "SHIPMASTR_PLATFORM_WEBHOOK_REGISTRATION_ENABLED", false);
  const platformWritesEnabled = boolValue(source, "PLATFORM_WRITES_ENABLED", false)
    || boolValue(source, "SHIPMASTR_PLATFORM_WRITES_ENABLED", false);
  const trackingSyncEnabled = boolValue(source, "PLATFORM_TRACKING_SYNC_ENABLED", false)
    || boolValue(source, "SHIPMASTR_PLATFORM_TRACKING_SYNC_ENABLED", false);
  const shippingNetworkLiveCalls = boolValue(source, "BIGSHIP_ENABLE_REAL_CALLS", false)
    || stringValue(source, "BIGSHIP_MODE", "mock").toLowerCase() === "live"
    || boolValue(source, "SHIPMASTR_COURIER_LIVE_CALLS_ENABLED", false);
  const awbLabelLiveEnabled = boolValue(source, "SHIPMASTR_AWB_LABEL_LIVE_ENABLED", false)
    || boolValue(source, "SHIPMASTR_SHIP_NOW_LIVE_ENABLED", false);
  const pilotReadiness = options.pilotReadiness ?? {
    merchantId: stringValue(source, "SHIPMASTR_PILOT_MERCHANT_ID", "current_merchant"),
    allowlisted: false,
    merchantStatus: "DISABLED",
    enabledCapabilities: [],
    approvedCapabilities: [],
    rollbackReady: true,
    blockers: ["MISSING_PILOT_MERCHANT_ALLOWLIST"]
  };
  const merchantAllowlistConfigured = Boolean(stringValue(source, "SHIPMASTR_LIVE_MERCHANT_ALLOWLIST"))
    || pilotReadiness.allowlisted;
  const betaDocExists = options.betaAuditDocExists ?? migrationDocExists();

  const categories = [
    category("beta_audit", "Beta Audit", [
      check({
        key: "phase_30_beta_audit_doc",
        label: "Phase 30 beta audit document exists",
        status: betaDocExists ? "PASS" : "BLOCKED",
        safeValue: betaDocExists,
        blockerCode: betaDocExists ? undefined : "MISSING_BETA_AUDIT_DOC",
        recommendation: betaDocExists
          ? "Keep beta audit updated as live gaps close."
          : "Create and review the Phase 30 beta audit before live enablement."
      })
    ]),
    category("credential_vault", "Credential Vault", [
      check({
        key: "credential_vault_provider",
        label: "Credential vault provider is live-ready",
        status: vaultIsLiveReady ? "PASS" : "WARNING",
        safeValue: vaultMode,
        blockerCode: vaultIsLiveReady ? undefined : "MOCK_CREDENTIAL_VAULT",
        recommendation: vaultIsLiveReady
          ? "Credential vault mode is ready for controlled pilot review."
          : "Configure a live KMS-backed credential provider before live merchant launch."
      }),
      check({
        key: "credential_vault_pilot_provider",
        label: "Credential vault is acceptable for pilot credentials",
        status: vaultRuntime.pilot_ready ? "PASS" : vaultRuntime.local_mock ? "WARNING" : "BLOCKED",
        safeValue: vaultRuntime.pilot_ready ? "PILOT_READY" : vaultRuntime.provider,
        blockerCode: vaultRuntime.pilot_ready ? undefined : "MOCK_CREDENTIAL_VAULT",
        recommendation: vaultRuntime.pilot_ready
          ? "Credential vault satisfies the current pilot gate."
          : "Use ENV_ENCRYPTION_KEY or KMS_INTERFACE, or record an explicit local mock pilot override."
      })
    ]),
    category("live_pilot_gate", "Controlled Live Pilot Gate", [
      check({
        key: "pilot_merchant_allowlisted",
        label: "Pilot merchant allowlist is explicit",
        status: pilotReadiness.allowlisted ? "PASS" : "WARNING",
        safeValue: pilotReadiness.merchantStatus,
        blockerCode: pilotReadiness.allowlisted ? undefined : "MISSING_PILOT_MERCHANT_ALLOWLIST",
        recommendation: "Add a merchant to the controlled pilot allowlist before any live capability can be enabled."
      }),
      check({
        key: "pilot_live_kms_approval",
        label: "Live KMS capability is approved for pilot",
        status: pilotReadiness.approvedCapabilities.includes("LIVE_KMS") ? "PASS" : "WARNING",
        safeValue: pilotReadiness.approvedCapabilities.includes("LIVE_KMS"),
        blockerCode: pilotReadiness.approvedCapabilities.includes("LIVE_KMS") ? undefined : "LIVE_KMS_CAPABILITY_NOT_APPROVED",
        recommendation: "Approve the LIVE_KMS capability before resolving live pilot credentials."
      }),
      check({
        key: "pilot_capability_gates",
        label: "Live capabilities are per-merchant gated",
        status: pilotReadiness.enabledCapabilities.length ? "WARNING" : "PASS",
        safeValue: pilotReadiness.enabledCapabilities.length,
        recommendation: "Enable live capabilities one at a time only after approval and rollback review."
      }),
      check({
        key: "pilot_rollback_ready",
        label: "Pilot rollback controls are available",
        status: pilotReadiness.rollbackReady ? "PASS" : "BLOCKED",
        safeValue: pilotReadiness.rollbackReady,
        blockerCode: pilotReadiness.rollbackReady ? undefined : "PILOT_ROLLBACK_NOT_READY",
        recommendation: "Disable controls must remain available for every pilot capability."
      })
    ]),
    category("workers", "Workers and Scheduler", [
      check({
        key: "workers_bounded",
        label: "Workers are disabled or dry-run bounded",
        status: !workersEnabled || workerDryRun ? "PASS" : "BLOCKED",
        safeValue: workersEnabled ? (workerDryRun ? "DRY_RUN" : "ACTIVE") : "DISABLED",
        blockerCode: !workersEnabled || workerDryRun ? undefined : "WORKERS_ENABLED_WITHOUT_DRY_RUN_OFF_APPROVAL",
        recommendation: "Keep workers disabled or dry-run until run-once controls and approvals are complete."
      }),
      check({
        key: "scheduler_disabled",
        label: "Production scheduler remains disabled",
        status: schedulerEnabled ? "BLOCKED" : "PASS",
        safeValue: schedulerEnabled,
        blockerCode: schedulerEnabled ? "SCHEDULER_ENABLED_WITHOUT_APPROVAL" : undefined,
        recommendation: "Enable scheduled polling only after worker audit and explicit approval."
      })
    ]),
    category("email", "Email Delivery", [
      check({
        key: "email_delivery_gate",
        label: "Real email delivery is disabled or fully configured",
        status: liveEmailEnabled && !emailProviderConfigured ? "BLOCKED" : liveEmailEnabled ? "WARNING" : "PASS",
        safeValue: liveEmailEnabled ? (emailProviderConfigured ? "CONFIGURED" : "NOT_CONFIGURED") : "DISABLED",
        blockerCode: liveEmailEnabled && !emailProviderConfigured ? "EMAIL_ENABLED_WITHOUT_PROVIDER" : undefined,
        recommendation: "Keep merchant email disabled until provider, sender authentication, and approval are complete."
      }),
      check({
        key: "pilot_email_sandbox_gate",
        label: "Pilot email sandbox is allowlist and capability gated",
        status: !pilotEmailEnabled
          ? "PASS"
          : pilotEmailMode !== "SANDBOX" || !pilotEmailPilotOnly
            ? "BLOCKED"
            : pilotReadiness.allowlisted && pilotReadiness.enabledCapabilities.includes("LIVE_EMAIL_SANDBOX")
              ? "WARNING"
              : "BLOCKED",
        safeValue: pilotEmailEnabled
          ? `${pilotEmailMode}:${pilotEmailProvider}:${pilotEmailPilotOnly ? "PILOT_ONLY" : "BROAD"}`
          : "DISABLED",
        blockerCode: !pilotEmailEnabled
          ? undefined
          : pilotEmailMode !== "SANDBOX"
            ? "EMAIL_LIVE_MODE_BLOCKED"
            : !pilotEmailPilotOnly
              ? "EMAIL_SANDBOX_NOT_PILOT_ONLY"
              : !pilotReadiness.allowlisted
                ? "MISSING_PILOT_MERCHANT_ALLOWLIST"
                : !pilotReadiness.enabledCapabilities.includes("LIVE_EMAIL_SANDBOX")
                  ? "LIVE_EMAIL_SANDBOX_CAPABILITY_REQUIRED"
                  : undefined,
        recommendation: "Use sandbox email only for allowlisted pilot merchants with LIVE_EMAIL_SANDBOX enabled."
      })
    ]),
    category("platform_integrations", "Platform Integrations", [
      check({
        key: "platform_read_mode",
        label: "Platform read mode is explicit",
        status: platformRealReads ? "WARNING" : "PASS",
        safeValue: platformRealReads ? "READ_ONLY_LIVE_FLAG_ON" : "MOCK_OR_DISABLED",
        recommendation: "Use real read-only mode only for allowlisted pilot stores with credential readiness."
      }),
      check({
        key: "webhook_registration_disabled",
        label: "Platform webhook registration remains disabled",
        status: webhookRegistrationEnabled && !approval(source, "LIVE_WEBHOOK_REGISTRATION_APPROVED") ? "BLOCKED" : "PASS",
        safeValue: webhookRegistrationEnabled,
        blockerCode: webhookRegistrationEnabled && !approval(source, "LIVE_WEBHOOK_REGISTRATION_APPROVED") ? "WEBHOOK_REGISTRATION_ENABLED" : undefined,
        recommendation: "Do not register platform webhooks until signature storage and rollback are approved."
      }),
      check({
        key: "platform_writes_disabled",
        label: "Platform writes remain disabled",
        status: platformWritesEnabled && !approval(source, "LIVE_PLATFORM_WRITE_APPROVED") ? "BLOCKED" : "PASS",
        safeValue: platformWritesEnabled,
        blockerCode: platformWritesEnabled && !approval(source, "LIVE_PLATFORM_WRITE_APPROVED") ? "PLATFORM_WRITES_ENABLED" : undefined,
        recommendation: "Do not enable platform writes until tracking sync and reconciliation approval are complete."
      }),
      check({
        key: "tracking_sync_disabled",
        label: "Tracking sync remains disabled",
        status: trackingSyncEnabled && !approval(source, "LIVE_PLATFORM_WRITE_APPROVED") ? "BLOCKED" : "PASS",
        safeValue: trackingSyncEnabled,
        blockerCode: trackingSyncEnabled && !approval(source, "LIVE_PLATFORM_WRITE_APPROVED") ? "TRACKING_SYNC_ENABLED" : undefined,
        recommendation: "Keep tracking sync simulation-only until platform write approval and merchant allowlist are in place."
      })
    ]),
    category("shipping_network", "Shipping Network Live Calls", [
      check({
        key: "live_shipping_network_calls",
        label: "Live shipping network calls remain gated",
        status: shippingNetworkLiveCalls && !approval(source, "LIVE_COURIER_PROVIDER_APPROVED") ? "BLOCKED" : shippingNetworkLiveCalls ? "WARNING" : "PASS",
        safeValue: shippingNetworkLiveCalls ? "LIVE_FLAG_ON" : "MOCK_OR_DISABLED",
        blockerCode: shippingNetworkLiveCalls && !approval(source, "LIVE_COURIER_PROVIDER_APPROVED") ? "COURIER_LIVE_CALLS_ENABLED" : undefined,
        recommendation: "Enable live rates only for allowlisted merchants after approval."
      }),
      check({
        key: "awb_label_live_behavior",
        label: "Live AWB and label behavior remains gated",
        status: awbLabelLiveEnabled && (!approval(source, "LIVE_COURIER_PROVIDER_APPROVED") || !merchantAllowlistConfigured) ? "BLOCKED" : awbLabelLiveEnabled ? "WARNING" : "PASS",
        safeValue: awbLabelLiveEnabled,
        blockerCode: awbLabelLiveEnabled && !merchantAllowlistConfigured ? "MISSING_MERCHANT_ALLOWLIST" : awbLabelLiveEnabled ? "AWB_LABEL_LIVE_ENABLED" : undefined,
        recommendation: "Do not enable live AWB or label behavior without approval and merchant allowlist."
      })
    ]),
    category("serializer_safety", "Serializer and Route Safety", [
      check({
        key: "raw_payload_exposure",
        label: "Raw payload exposure remains blocked by serializers",
        status: "PASS",
        safeValue: false,
        recommendation: "Continue safety grep and serializer tests before every live gate change."
      }),
      check({
        key: "credential_exposure",
        label: "Credential exposure remains blocked by serializers",
        status: "PASS",
        safeValue: false,
        recommendation: "Never serialize secret references, tokens, headers, or hashes in seller-facing responses."
      }),
      check({
        key: "provider_name_public_leak",
        label: "Internal shipping network references remain seller-safe",
        status: "PASS",
        safeValue: false,
        recommendation: "Public UI must keep using Shipmastr shipping labels only."
      })
    ])
  ];

  const checks = categories.flatMap((item) => item.checks);
  const summary: ProductionReadinessSummary = {
    totalChecks: checks.length,
    passed: checks.filter((item) => item.status === "PASS").length,
    warnings: checks.filter((item) => item.status === "WARNING").length,
    blockers: checks.filter((item) => item.status === "BLOCKED").length
  };
  const hasHardBlockers = summary.blockers > 0;
  const liveRequirementsMet = !hasHardBlockers
    && !vaultIsMock
    && vaultRuntime.pilot_ready
    && merchantAllowlistConfigured
    && (approval(source, "LIVE_KMS_PROVIDER_APPROVED") || pilotReadiness.approvedCapabilities.includes("LIVE_KMS"))
    && approval(source, "PRODUCTION_DEPLOY_APPROVED");
  const liveVerdict: ProductionReadinessVerdict = hasHardBlockers
    ? "BLOCKED"
    : liveRequirementsMet
      ? "READY_FOR_CONTROLLED_LIVE_PILOT"
      : "NOT_READY_FOR_LIVE";
  const verdict: ProductionReadinessVerdict = hasHardBlockers ? "BLOCKED" : "READY_WITH_LIMITED_MOCKS";

  return {
    verdict,
    betaVerdict: "READY_WITH_LIMITED_MOCKS",
    liveVerdict,
    checkedAt,
    summary,
    categories,
    environment: {
      nodeEnv,
      appEnv,
      credentialVaultMode: vaultMode,
      workerMode: workersEnabled ? (workerDryRun ? "DRY_RUN" : "ACTIVE") : "DISABLED",
      emailMode: liveEmailEnabled ? (emailProviderConfigured ? "CONFIGURED" : "INCOMPLETE") : "DISABLED",
      pilotEmailMode: pilotEmailEnabled ? `${pilotEmailMode}:${pilotEmailProvider}` : "DISABLED",
      platformReadMode: platformRealReads ? "READ_ONLY_LIVE_FLAG_ON" : "MOCK_OR_DISABLED",
      platformWriteMode: platformWritesEnabled ? "LIVE_FLAG_ON" : "DISABLED",
      shippingNetworkMode: shippingNetworkLiveCalls ? "LIVE_FLAG_ON" : "MOCK_OR_DISABLED",
      pilotMerchantMode: pilotReadiness.allowlisted ? "ALLOWLISTED" : "NOT_ALLOWLISTED"
    },
    pilotReadiness,
    approvalChecklist: {
      approvalRequired: true,
      approvals: Object.values(approvalFlags)
    },
    liveEnablementPlan: livePlan,
    deferredGaps,
    hardStops,
    safetyBoundaries: {
      productionLiveBehaviorEnabled: false,
      schedulerEnabled: false,
      realEmailDeliveryEnabled: false,
      platformWebhookRegistrationPerformed: false,
      platformWritesEnabled: false,
      trackingSyncEnabled: false,
      liveShippingNetworkCallsEnabled: false,
      liveAwbLabelBehaviorNewlyEnabled: false,
      deploymentPerformed: false,
      productionMutationPerformed: false,
      rawEnvValuesExposed: false,
      secretValuesExposed: false
    }
  };
}

export function mostSevereStatus(statuses: ProductionReadinessStatus[]): ProductionReadinessStatus {
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("WARNING")) return "WARNING";
  return "PASS";
}
