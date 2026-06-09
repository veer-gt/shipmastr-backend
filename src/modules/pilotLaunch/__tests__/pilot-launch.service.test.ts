import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildPilotLaunchReport, getPilotLaunchGoNoGo, getPilotLaunchRollbackPlan, getPilotLaunchSmokeChecklist } from "../pilot-launch.service.js";

function clientWith(options: {
  merchantEnabled?: boolean;
  capabilities?: Array<{ capability: string; status: string }>;
  counts?: Record<string, number>;
} = {}) {
  const counts = {
    platformConnection: 0,
    platformConnectionActive: 0,
    platformCredential: 0,
    pickupLocation: 0,
    platformImportJob: 0,
    platformImportItem: 0,
    platformImportItemReady: 0,
    platformImportItemFailed: 0,
    platformImportConversion: 0,
    shipment: 0,
    shipmentReady: 0,
    merchantNotification: 0,
    shipmastrWorkerRun: 0,
    ...(options.counts ?? {})
  };
  const capabilities = options.capabilities ?? [];
  return {
    livePilotMerchant: {
      findUnique: async () => options.merchantEnabled
        ? {
            id: "pilot_1",
            merchantId: "merchant_1",
            status: "ENABLED",
            notes: null,
            enabledAt: new Date(),
            disabledAt: null,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        : null
    },
    livePilotCapability: {
      findMany: async () => capabilities
    },
    merchantNotificationPreference: {
      findUnique: async () => ({ merchantId: "merchant_1", emailEnabled: true })
    },
    platformConnection: {
      count: async ({ where }: any = {}) => where?.status === "ACTIVE" ? counts.platformConnectionActive : counts.platformConnection
    },
    platformCredential: {
      count: async () => counts.platformCredential
    },
    pickupLocation: {
      count: async () => counts.pickupLocation
    },
    platformImportJob: {
      count: async () => counts.platformImportJob
    },
    platformImportItem: {
      count: async ({ where }: any = {}) => {
        if (where?.status === "FAILED") return counts.platformImportItemFailed;
        if (where?.status?.in) return counts.platformImportItemReady;
        return counts.platformImportItem;
      }
    },
    platformImportConversion: {
      count: async () => counts.platformImportConversion
    },
    shipment: {
      count: async ({ where }: any = {}) => where?.status?.in ? counts.shipmentReady : counts.shipment
    },
    merchantNotification: {
      count: async () => counts.merchantNotification
    },
    shipmastrWorkerRun: {
      count: async () => counts.shipmastrWorkerRun
    }
  } as any;
}

const safeSource = {
  NODE_ENV: "test",
  APP_ENV: "test",
  CREDENTIAL_VAULT_PROVIDER: "ENV_ENCRYPTION_KEY",
  CREDENTIAL_VAULT_ENCRYPTION_KEY: "safe-test-key-with-enough-length",
  CREDENTIAL_VAULT_REQUIRE_LIVE_FOR_PILOT: "false",
  SHIPMASTR_EMAIL_ENABLED: "true",
  SHIPMASTR_EMAIL_MODE: "SANDBOX",
  SHIPMASTR_EMAIL_PROVIDER: "LOCAL_LOG",
  SHIPMASTR_EMAIL_PILOT_ONLY: "true",
  SHIPMASTR_WEBHOOK_REGISTRATION_PILOT_ONLY: "true",
  SHIPMASTR_LIVE_COURIER_RATES_ENABLED: "true",
  SHIPMASTR_LIVE_COURIER_RATES_MODE: "LIVE",
  SHIPMASTR_LIVE_COURIER_RATES_PILOT_ONLY: "true",
  SHIPMASTR_LIVE_AWB_LABEL_ENABLED: "true",
  SHIPMASTR_LIVE_AWB_LABEL_MODE: "LIVE",
  SHIPMASTR_LIVE_AWB_LABEL_PILOT_ONLY: "true",
  SHIPMASTR_PLATFORM_TRACKING_SYNC_ENABLED: "true",
  SHIPMASTR_PLATFORM_TRACKING_SYNC_MODE: "LIVE",
  SHIPMASTR_PLATFORM_TRACKING_SYNC_PILOT_ONLY: "true",
  SHIPMASTR_WORKERS_ENABLED: "true",
  SHIPMASTR_WORKER_DRY_RUN: "true",
  LIVE_KMS_PROVIDER_APPROVED: "true",
  LIVE_COURIER_PROVIDER_APPROVED: "true",
  LIVE_EMAIL_PROVIDER_APPROVED: "true",
  LIVE_WEBHOOK_REGISTRATION_APPROVED: "true",
  LIVE_PLATFORM_WRITE_APPROVED: "true",
  PRODUCTION_DEPLOY_APPROVED: "true",
  SHIPMASTR_LIVE_MERCHANT_ALLOWLIST: "merchant_1"
};

const allCapabilities = [
  "LIVE_KMS",
  "LIVE_EMAIL_SANDBOX",
  "LIVE_WEBHOOK_REGISTRATION",
  "LIVE_COURIER_RATES",
  "LIVE_AWB_LABEL",
  "LIVE_PLATFORM_TRACKING_SYNC",
  "LIVE_WORKER_RUN_ONCE",
  "PRODUCTION_DEPLOY"
].map((capability) => ({ capability, status: "ENABLED" }));

const readyCounts = {
  platformConnection: 1,
  platformConnectionActive: 1,
  platformCredential: 1,
  pickupLocation: 1,
  platformImportJob: 1,
  platformImportItem: 2,
  platformImportItemReady: 2,
  platformImportConversion: 1,
  shipment: 1,
  shipmentReady: 1,
  merchantNotification: 1,
  shipmastrWorkerRun: 1
};

function asJson(value: unknown) {
  return JSON.stringify(value);
}

describe("controlled pilot launch checklist", () => {
  it("defaults conservative with no allowlist and missing merchant data", async () => {
    const report = await buildPilotLaunchReport("merchant_1", {
      client: clientWith(),
      source: {
        NODE_ENV: "test",
        CREDENTIAL_VAULT_PROVIDER: "LOCAL_MOCK",
        SHIPMASTR_WORKER_DRY_RUN: "true"
      },
      checkedAt: "2026-06-09T00:00:00.000Z"
    });
    assert.equal(report.verdict, "NO_GO_BLOCKERS");
    assert.equal(report.merchant_id, "merchant_1");
    assert.ok(report.summary.blockers > 0);
    assert.match(asJson(report), /PILOT_MERCHANT_NOT_ALLOWLISTED/);
    assert.ok(report.go_no_go.forbidden_pilot_actions.includes("Broad production rollout"));
  });

  it("returns go for controlled pilot only when gates and operations are ready", async () => {
    const report = await buildPilotLaunchReport("merchant_1", {
      client: clientWith({ merchantEnabled: true, capabilities: allCapabilities, counts: readyCounts }),
      source: safeSource,
      checkedAt: "2026-06-09T00:00:00.000Z"
    });
    assert.equal(report.verdict, "GO_FOR_CONTROLLED_PILOT");
    assert.equal(report.summary.blockers, 0);
    assert.ok(report.scope.allowed_capabilities.includes("LIVE_AWB_LABEL"));
    assert.ok(report.scope.allowed_capabilities.includes("LIVE_PLATFORM_TRACKING_SYNC"));
  });

  it("allows limited scope when allowlisted but approvals are incomplete", async () => {
    const report = await buildPilotLaunchReport("merchant_1", {
      client: clientWith({
        merchantEnabled: true,
        capabilities: [{ capability: "LIVE_KMS", status: "ENABLED" }],
        counts: readyCounts
      }),
      source: {
        ...safeSource,
        SHIPMASTR_EMAIL_ENABLED: "false",
        SHIPMASTR_LIVE_COURIER_RATES_ENABLED: "false",
        SHIPMASTR_LIVE_AWB_LABEL_ENABLED: "false",
        SHIPMASTR_PLATFORM_TRACKING_SYNC_ENABLED: "false"
      },
      checkedAt: "2026-06-09T00:00:00.000Z"
    });
    assert.equal(report.verdict, "GO_WITH_LIMITED_SCOPE");
    assert.ok(report.summary.warnings > 0);
    assert.ok(report.scope.limited_capabilities.length === 0 || Array.isArray(report.scope.limited_capabilities));
  });

  it("blocks unsafe global live flags without approvals", async () => {
    const report = await buildPilotLaunchReport("merchant_1", {
      client: clientWith({ merchantEnabled: true, capabilities: allCapabilities, counts: readyCounts }),
      source: {
        ...safeSource,
        PRODUCTION_DEPLOY_APPROVED: "false",
        SHIPMASTR_SCHEDULER_ENABLED: "true",
        SHIPMASTR_WEBHOOK_REGISTRATION_PILOT_ONLY: "false",
        SHIPMASTR_LIVE_COURIER_RATES_PILOT_ONLY: "false",
        SHIPMASTR_LIVE_AWB_LABEL_PILOT_ONLY: "false",
        SHIPMASTR_PLATFORM_TRACKING_SYNC_PILOT_ONLY: "false",
        PLATFORM_WRITES_ENABLED: "true"
      },
      checkedAt: "2026-06-09T00:00:00.000Z"
    });
    assert.equal(report.verdict, "NO_GO_BLOCKERS");
    assert.match(asJson(report), /SCHEDULER_ENABLED|WEBHOOK_REGISTRATION_NOT_PILOT_ONLY|PLATFORM_WRITES_GLOBAL/);
  });

  it("go/no-go, rollback, and smoke endpoints return safe slices", async () => {
    const options = {
      client: clientWith({ merchantEnabled: true, capabilities: allCapabilities, counts: readyCounts }),
      source: safeSource
    };
    const goNoGo = await getPilotLaunchGoNoGo("merchant_1", options);
    const rollback = await getPilotLaunchRollbackPlan("merchant_1", options);
    const smoke = await getPilotLaunchSmokeChecklist("merchant_1", options);
    assert.equal(goNoGo.merchant_id, "merchant_1");
    assert.ok(Array.isArray(goNoGo.go_no_go.allowed_pilot_actions));
    assert.equal(rollback.rollback.available, true);
    assert.ok(smoke.smoke_checklist.some((step) => step.command === "npm run smoke:production-readiness"));
  });

  it("serializers do not expose raw env values, credentials, payloads, headers, provider names, or full buyer contact", async () => {
    const report = await buildPilotLaunchReport("merchant_1", {
      client: clientWith({ merchantEnabled: true, capabilities: allCapabilities, counts: readyCounts }),
      source: {
        ...safeSource,
        SMTP_PASS: "smtp-super-secret",
        WEBHOOK_SECRET: "webhook-super-secret",
        CREDENTIAL_VAULT_ENCRYPTION_KEY: "vault-super-secret",
        accessToken: "shpat_secret",
        rawPayload: "unsafe-live-body-123",
        rawHeaders: "unsafe-auth-header-123"
      },
      checkedAt: "2026-06-09T00:00:00.000Z"
    });
    const json = asJson(report);
    assert.doesNotMatch(json, /smtp-super-secret|webhook-super-secret|vault-super-secret|shpat_secret/i);
    assert.doesNotMatch(json, /unsafe-live-body-123|unsafe-auth-header-123|credentialHash|secretHash|Bigship|providerName|9876543210|221 Market Street/i);
  });

  it("routes are GET-only and checklist service is read-only", () => {
    const routes = readFileSync("src/modules/pilotLaunch/pilot-launch.routes.ts", "utf8");
    const service = readFileSync("src/modules/pilotLaunch/pilot-launch.service.ts", "utf8");
    assert.match(routes, /get\("\/pilot-launch\/:merchantId\/checklist"/);
    assert.match(routes, /get\("\/pilot-launch\/:merchantId\/go-no-go"/);
    assert.match(routes, /get\("\/pilot-launch\/:merchantId\/rollback-plan"/);
    assert.match(routes, /get\("\/pilot-launch\/:merchantId\/smoke-checklist"/);
    assert.doesNotMatch(routes, /\.post|\.put|\.patch|\.delete/i);
    assert.doesNotMatch(routes, /launch-now|deploy|activate|enable/i);
    assert.doesNotMatch(service, /fetch\(|axios|sendMail|nodemailer|createLabel|getLabel|manifestOrder|getRates|shipNow|registerWebhook|setInterval|cron|\.create\(|\.update\(|\.upsert\(|\.delete\(/i);
  });
});
