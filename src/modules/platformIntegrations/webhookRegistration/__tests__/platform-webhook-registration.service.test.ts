import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  StorePlatform
} from "@prisma/client";
import { HttpError } from "../../../../lib/httpError.js";
import {
  disablePlatformWebhookRegistration,
  dryRunPlatformWebhookRegistration,
  getPlatformWebhookRegistration,
  getPlatformWebhookRegistrationReadiness,
  listPlatformWebhookRegistrations,
  registerPlatformConnectionWebhooks
} from "../platform-webhook-registration.service.js";

const now = new Date("2026-06-08T16:00:00.000Z");

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("merchantId" in expected && "capability" in expected) {
        return row.merchantId === (expected as any).merchantId && row.capability === (expected as any).capability;
      }
      if ("connectionId" in expected && "topic" in expected) {
        return row.connectionId === (expected as any).connectionId && row.topic === (expected as any).topic;
      }
    }
    return row[key] === expected;
  });
}

function source(overrides: Record<string, string | boolean | undefined> = {}) {
  return {
    SHIPMASTR_WEBHOOK_REGISTRATION_ENABLED: "true",
    SHIPMASTR_WEBHOOK_REGISTRATION_MODE: "DRY_RUN",
    SHIPMASTR_WEBHOOK_REGISTRATION_PILOT_ONLY: "true",
    PUBLIC_WEBHOOK_BASE_URL: "https://hooks.shipmastr.test",
    ...overrides
  };
}

function createClient() {
  const state = {
    connections: [{
      id: "conn_shopify",
      merchantId: "merchant_1",
      platform: StorePlatform.SHOPIFY,
      storeName: "Demo Store",
      storeUrl: "https://demo.myshopify.com",
      status: "ACTIVE",
      syncDirection: "IMPORT_ONLY",
      credentialsRef: "platform-credential:cred_1",
      credentialsMeta: null,
      createdAt: now,
      updatedAt: now
    }] as any[],
    credentials: [{
      id: "cred_1",
      merchantId: "merchant_1",
      platform: PlatformCredentialProvider.SHOPIFY,
      credentialType: "SHOPIFY_CUSTOM_APP_TOKEN",
      name: "Demo credential",
      status: PlatformCredentialStatus.ACTIVE,
      secretRef: "vault://secret",
      secretFingerprint: "fingerprint_internal",
      safeMetadata: { shop_domain: "demo.myshopify.com" },
      lastUsedAt: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
      rotatedAt: null,
      revokedAt: null
    }] as any[],
    secrets: [{
      id: "secret_1",
      credentialId: "cred_1",
      encryptedValue: "encrypted-secret-internal",
      encryptionVersion: "test",
      createdAt: now,
      updatedAt: now
    }] as any[],
    pilotMerchants: [{
      id: "pilot_1",
      merchantId: "merchant_1",
      status: "ENABLED",
      createdAt: now,
      updatedAt: now
    }] as any[],
    pilotCapabilities: [{
      id: "pilot_cap_1",
      merchantId: "merchant_1",
      capability: "LIVE_WEBHOOK_REGISTRATION",
      status: "ENABLED",
      approvalId: "approval_1",
      createdAt: now,
      updatedAt: now
    }] as any[],
    registrations: [] as any[],
    auditLogs: [] as any[]
  };
  const id = (prefix: string, count: number) => `${prefix}_${count + 1}`;
  const client = {
    platformConnection: {
      findFirst: async ({ where }: any) => state.connections.find((row) => matches(row, where)) ?? null
    },
    platformCredential: {
      findFirst: async ({ where }: any) => state.credentials.find((row) => matches(row, where)) ?? null
    },
    platformCredentialSecret: {
      findUnique: async ({ where }: any) => state.secrets.find((row) => row.credentialId === where.credentialId) ?? null
    },
    livePilotMerchant: {
      findUnique: async ({ where }: any) => state.pilotMerchants.find((row) => row.merchantId === where.merchantId) ?? null
    },
    livePilotCapability: {
      findMany: async ({ where }: any) => state.pilotCapabilities.filter((row) => matches(row, where))
    },
    livePilotAuditLog: {
      create: async ({ data }: any) => {
        const row = { id: id("audit", state.auditLogs.length), ...data, createdAt: now };
        state.auditLogs.push(row);
        return row;
      }
    },
    platformWebhookRegistration: {
      upsert: async ({ where, create, update }: any) => {
        const existing = state.registrations.find((row) => row.connectionId === where.connectionId_topic.connectionId && row.topic === where.connectionId_topic.topic);
        if (existing) {
          Object.assign(existing, update, { updatedAt: now });
          return existing;
        }
        const row = {
          id: id("registration", state.registrations.length),
          ...create,
          externalWebhookId: null,
          registeredAt: create.registeredAt ?? null,
          disabledAt: create.disabledAt ?? null,
          createdAt: now,
          updatedAt: now
        };
        state.registrations.push(row);
        return row;
      },
      findMany: async ({ where = {}, skip = 0, take = 20 }: any) => state.registrations.filter((row) => matches(row, where)).slice(skip, skip + take),
      count: async ({ where = {} }: any) => state.registrations.filter((row) => matches(row, where)).length,
      findFirst: async ({ where }: any) => state.registrations.find((row) => matches(row, where)) ?? null,
      update: async ({ where, data }: any) => {
        const row = state.registrations.find((item) => item.id === where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    }
  };
  return { state, client: client as any };
}

describe("platform webhook registration foundation", () => {
  it("is disabled by default", async () => {
    const { client } = createClient();
    const readiness = await getPlatformWebhookRegistrationReadiness("merchant_1", "conn_shopify", client, {
      SHIPMASTR_WEBHOOK_REGISTRATION_ENABLED: "false",
      PUBLIC_WEBHOOK_BASE_URL: "https://hooks.shipmastr.test"
    });
    assert.equal((readiness as any).status, "DISABLED");
    assert.match(JSON.stringify((readiness as any).blockers), /PLATFORM_WEBHOOK_REGISTRATION_DISABLED/);
  });

  it("dry-run creates safe draft/ready records only", async () => {
    const { state, client } = createClient();
    const result = await dryRunPlatformWebhookRegistration("merchant_1", {
      connectionId: "conn_shopify",
      topics: ["ORDER_CREATED"]
    }, client, source());
    assert.equal(result.registrations.length, 1);
    assert.equal(result.registrations[0]?.status, "READY");
    assert.equal(result.registrations[0]?.live_registration_performed, false);
    assert.equal(state.auditLogs[0]?.action, "PLATFORM_WEBHOOK_REGISTRATION_DRY_RUN");
    assert.equal(state.registrations[0]?.externalWebhookId, null);
  });

  it("blocks live registration without pilot allowlist", async () => {
    const { state, client } = createClient();
    state.pilotMerchants = [];
    await assert.rejects(
      () => registerPlatformConnectionWebhooks("merchant_1", "conn_shopify", {}, client, source({
        SHIPMASTR_WEBHOOK_REGISTRATION_MODE: "LIVE"
      })),
      (error) => error instanceof HttpError && error.message === "LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED"
    );
  });

  it("blocks live registration without capability", async () => {
    const { state, client } = createClient();
    state.pilotCapabilities = [];
    await assert.rejects(
      () => registerPlatformConnectionWebhooks("merchant_1", "conn_shopify", {}, client, source({
        SHIPMASTR_WEBHOOK_REGISTRATION_MODE: "LIVE"
      })),
      (error) => error instanceof HttpError && error.message === "LIVE_WEBHOOK_REGISTRATION_CAPABILITY_REQUIRED"
    );
  });

  it("blocks registration without credential readiness and callback URL", async () => {
    const missingCallback = createClient();
    await assert.rejects(
      () => dryRunPlatformWebhookRegistration("merchant_1", { connectionId: "conn_shopify" }, missingCallback.client, source({
        PUBLIC_WEBHOOK_BASE_URL: ""
      })),
      (error) => error instanceof HttpError && error.message === "PLATFORM_WEBHOOK_CALLBACK_URL_MISSING"
    );

    const missingCredential = createClient();
    missingCredential.state.secrets = [];
    const result = await dryRunPlatformWebhookRegistration("merchant_1", { connectionId: "conn_shopify" }, missingCredential.client, source());
    assert.equal(result.registrations[0]?.status, "BLOCKED");
    assert.match(JSON.stringify(result.readiness), /PLATFORM_WEBHOOK_CREDENTIAL_DATA_MISSING/);
  });

  it("lists, fetches, and disables registrations safely", async () => {
    const { client } = createClient();
    const result = await dryRunPlatformWebhookRegistration("merchant_1", { connectionId: "conn_shopify" }, client, source());
    const listed = await listPlatformWebhookRegistrations("merchant_1", { page: 1, per_page: 20 }, client);
    assert.equal(listed.registrations.length, 2);
    const fetched = await getPlatformWebhookRegistration("merchant_1", result.registrations[0]!.registration_id, client);
    assert.equal(fetched.registration_id, result.registrations[0]!.registration_id);
    const disabled = await disablePlatformWebhookRegistration("merchant_1", fetched.registration_id, { reason: "Rollback" }, client);
    assert.equal(disabled.status, "DISABLED");
  });

  it("serializers do not expose secrets, raw payloads, provider refs, or courier names", async () => {
    const { state, client } = createClient();
    state.credentials[0]!.safeMetadata = {
      rawPayload: { accessToken: "shpat_secret" },
      rawHeaders: { authorization: "Bearer secret" },
      providerName: "Bigship"
    };
    const result = await dryRunPlatformWebhookRegistration("merchant_1", { connectionId: "conn_shopify" }, client, source());
    const json = JSON.stringify(result);
    assert.doesNotMatch(json, /shpat_secret|Bearer secret|rawPayload|rawHeaders|externalWebhookId|webhookSecret|providerName|Bigship|courier/i);
  });

  it("does not add platform order writes, webhook provider HTTP calls, schedulers, or shipping actions", () => {
    const files = [
      readFileSync("src/modules/platformIntegrations/webhookRegistration/platform-webhook-registration.service.ts", "utf8"),
      readFileSync("src/modules/platformIntegrations/webhookRegistration/platform-webhook-registration.providers.ts", "utf8")
    ].join("\n");
    assert.doesNotMatch(files, /fetch\(|axios|createWebhook|registerWebhook|fulfillment|tracking sync|createLabel|getLabel|manifestOrder|getRates|setInterval|cron|sendMail|nodemailer/i);
  });
});
