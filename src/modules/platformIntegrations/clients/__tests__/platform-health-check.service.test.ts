import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlatformConnectionStatus,
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformCredentialType,
  PlatformHealthCheckStatus,
  PlatformSyncDirection,
  StorePlatform
} from "@prisma/client";
import { HttpError } from "../../../../lib/httpError.js";
import type { PlatformCredentialVault } from "../../credentials/platform-credentials.crypto.js";
import { assertPlatformReadOnlyOperation } from "../platform-api-client.errors.js";
import type { PlatformApiClient } from "../platform-api-client.types.js";
import {
  getLatestPlatformConnectionHealth,
  listPlatformConnectionHealthChecks,
  runAllPlatformConnectionHealthChecks,
  runPlatformConnectionHealthCheck
} from "../platform-health-check.service.js";

const now = new Date("2026-06-08T03:00:00.000Z");

const testVault: PlatformCredentialVault = {
  storeSecret: (secret) => ({
    encryptedValue: `test-vault:${Buffer.from(JSON.stringify(secret)).toString("base64")}`,
    encryptionVersion: "test-vault"
  }),
  readSecretForInternalUse: (stored) => JSON.parse(Buffer.from(stored.encryptedValue.replace(/^test-vault:/, ""), "base64").toString("utf8")),
  rotateSecret: (secret) => testVault.storeSecret(secret),
  revokeSecret: () => undefined,
  fingerprintSecret: (secret) => `fp_${Buffer.from(JSON.stringify(secret)).toString("base64url").slice(0, 20)}`,
  maskSecret: (secret) => `${secret.slice(0, 4)}...${secret.slice(-4)}`
};

function id(prefix: string, count: number) {
  return `${prefix}_${String(count + 1).padStart(2, "0")}`;
}

function pageRows<T>(rows: T[], args: any = {}) {
  const skip = args.skip ?? 0;
  const take = args.take ?? rows.length;
  return rows.slice(skip, skip + take);
}

function createFakeClient() {
  const state = {
    connections: [] as any[],
    credentials: [] as any[],
    secrets: [] as any[],
    healthChecks: [] as any[]
  };
  const client = {
    platformConnection: {
      findFirst: async ({ where }: any) => state.connections.find((row) => (
        row.id === where.id && row.merchantId === where.merchantId
      )) ?? null,
      findMany: async ({ where }: any = {}) => state.connections.filter((row) => (
        !where?.merchantId || row.merchantId === where.merchantId
      ))
    },
    platformCredential: {
      findFirst: async ({ where }: any) => state.credentials.find((row) => (
        row.id === where.id && row.merchantId === where.merchantId
      )) ?? null
    },
    platformCredentialSecret: {
      findUnique: async ({ where }: any) => state.secrets.find((row) => row.credentialId === where.credentialId) ?? null
    },
    platformConnectionHealthCheck: {
      create: async ({ data }: any) => {
        const row = { id: id("health", state.healthChecks.length), createdAt: now, ...data };
        state.healthChecks.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.healthChecks
        .filter((row) => row.merchantId === where.merchantId && row.connectionId === where.connectionId)
        .sort((a, b) => Number(b.checkedAt) - Number(a.checkedAt))[0] ?? null,
      findMany: async (args: any = {}) => pageRows(state.healthChecks.filter((row) => (
        row.merchantId === args.where?.merchantId && row.connectionId === args.where?.connectionId
      )), args),
      count: async ({ where }: any) => state.healthChecks.filter((row) => (
        row.merchantId === where.merchantId && row.connectionId === where.connectionId
      )).length
    }
  };
  return { client: client as any, state };
}

function addConnection(
  state: ReturnType<typeof createFakeClient>["state"],
  platform: StorePlatform,
  merchantId = "merchant_1"
) {
  const row = {
    id: id("conn", state.connections.length),
    merchantId,
    platform,
    storeName: `${platform} store`,
    storeUrl: platform === StorePlatform.SHOPIFY ? "https://demo.myshopify.com" : "https://store.example/",
    status: PlatformConnectionStatus.ACTIVE,
    syncDirection: PlatformSyncDirection.IMPORT_ONLY,
    credentialsRef: null,
    credentialsMeta: null,
    lastOrderImportAt: null,
    lastTrackingSyncAt: null,
    disabledAt: null,
    createdAt: now,
    updatedAt: now
  };
  state.connections.push(row);
  return row;
}

function providerFor(platform: StorePlatform) {
  return platform as unknown as PlatformCredentialProvider;
}

function credentialTypeFor(platform: StorePlatform) {
  if (platform === StorePlatform.SHOPIFY) return PlatformCredentialType.SHOPIFY_CUSTOM_APP_TOKEN;
  if (platform === StorePlatform.WOOCOMMERCE) return PlatformCredentialType.WOOCOMMERCE_REST_KEYS;
  if (platform === StorePlatform.MAGENTO) return PlatformCredentialType.MAGENTO_INTEGRATION_TOKEN;
  return PlatformCredentialType.CUSTOM_API_KEY;
}

function secretFor(platform: StorePlatform) {
  if (platform === StorePlatform.SHOPIFY) return { shopDomain: "demo.myshopify.com", accessToken: "shpat_health_secret" };
  if (platform === StorePlatform.WOOCOMMERCE) return { siteUrl: "https://woo.example", consumerKey: "ck_health_secret", consumerSecret: "cs_health_secret" };
  if (platform === StorePlatform.MAGENTO) return { baseUrl: "https://magento.example", integrationToken: "magentotoken_health_secret" };
  return { baseUrl: "https://api.example", apiKey: "custom_health_secret" };
}

function safeMetadataFor(platform: StorePlatform) {
  if (platform === StorePlatform.SHOPIFY) return { shop_domain: "demo.myshopify.com", token_prefix: "shpa...cret" };
  if (platform === StorePlatform.WOOCOMMERCE) return { site_url: "https://woo.example/", consumer_key_prefix: "ck_h...cret" };
  if (platform === StorePlatform.MAGENTO) return { base_url: "https://magento.example/", token_prefix: "mage...cret" };
  return { base_url: "https://api.example/", header_name: "Authorization", api_key_prefix: "cust...cret" };
}

function attachCredential(
  state: ReturnType<typeof createFakeClient>["state"],
  connection: any,
  status: PlatformCredentialStatus = PlatformCredentialStatus.ACTIVE,
  platform: StorePlatform = connection.platform
) {
  const credential = {
    id: id("cred", state.credentials.length),
    merchantId: connection.merchantId,
    platform: providerFor(platform),
    credentialType: credentialTypeFor(platform),
    name: `${platform} credential`,
    status,
    secretRef: `vault://platform-credentials/${platform.toLowerCase()}`,
    secretFingerprint: `fp_${platform.toLowerCase()}`,
    safeMetadata: safeMetadataFor(platform),
    lastUsedAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    rotatedAt: null,
    revokedAt: status === PlatformCredentialStatus.REVOKED ? now : null
  };
  const stored = testVault.storeSecret(secretFor(platform));
  state.credentials.push(credential);
  state.secrets.push({
    id: id("secret", state.secrets.length),
    credentialId: credential.id,
    encryptedValue: stored.encryptedValue,
    encryptionVersion: stored.encryptionVersion,
    createdAt: now,
    updatedAt: now
  });
  connection.credentialsRef = `platform-credential:${credential.id}`;
  return credential;
}

function unsafeClient(assertSecretValue: string): PlatformApiClient {
  const result = async (context: any) => {
    assert.equal(JSON.stringify(context.credentialSecret).includes(assertSecretValue), true);
    return {
      status: PlatformHealthCheckStatus.HEALTHY,
      message: "Unsafe details were sanitized.",
      safeDetails: {
        mockMode: true,
        rawResponse: { accessToken: assertSecretValue },
        rawHeaders: { authorization: `Bearer ${assertSecretValue}` },
        secretRef: "vault://unsafe",
        visible: "safe"
      }
    };
  };
  return {
    getPlatformIdentity: result,
    checkAuthentication: result,
    checkReadPermissions: result,
    checkWebhookCapability: result,
    checkFulfillmentOrTrackingCapability: result
  };
}

describe("Phase 19 platform API client health check foundation", () => {
  it("rejects missing platform connections safely", async () => {
    const { client } = createFakeClient();
    await assert.rejects(
      () => runPlatformConnectionHealthCheck("merchant_1", "missing", { client, vault: testVault }),
      (error: unknown) => error instanceof HttpError && error.message === "PLATFORM_CONNECTION_NOT_FOUND"
    );
  });

  it("returns NOT_CONFIGURED when a non-custom connection has no credential", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.SHOPIFY);
    const health = await runPlatformConnectionHealthCheck("merchant_1", connection.id, { client, vault: testVault });

    assert.equal(health.status, PlatformHealthCheckStatus.NOT_CONFIGURED);
    assert.equal(state.healthChecks.length, 1);
    assert.equal((health.safe_details as Record<string, unknown>)?.credentialAttached, false);
  });

  it("rejects revoked credentials and platform mismatches", async () => {
    const { client, state } = createFakeClient();
    const revokedConnection = addConnection(state, StorePlatform.WOOCOMMERCE);
    attachCredential(state, revokedConnection, PlatformCredentialStatus.REVOKED);
    await assert.rejects(
      () => runPlatformConnectionHealthCheck("merchant_1", revokedConnection.id, { client, vault: testVault }),
      (error: unknown) => error instanceof HttpError && error.message === "PLATFORM_HEALTH_CREDENTIAL_INACTIVE"
    );

    const mismatchConnection = addConnection(state, StorePlatform.MAGENTO);
    attachCredential(state, mismatchConnection, PlatformCredentialStatus.ACTIVE, StorePlatform.SHOPIFY);
    await assert.rejects(
      () => runPlatformConnectionHealthCheck("merchant_1", mismatchConnection.id, { client, vault: testVault }),
      (error: unknown) => error instanceof HttpError && error.message === "PLATFORM_HEALTH_CREDENTIAL_PLATFORM_MISMATCH"
    );
  });

  it("runs deterministic mock health checks without external calls", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.CUSTOM);
    const health = await runPlatformConnectionHealthCheck("merchant_1", connection.id, {
      client,
      vault: testVault,
      realReadsEnabled: false
    });

    assert.equal(health.status, PlatformHealthCheckStatus.DEGRADED);
    assert.equal((health.safe_details as Record<string, unknown>)?.mockMode, true);
    assert.doesNotMatch(JSON.stringify(health), /rawResponse|rawHeaders|secretRef|custom_health_secret/i);
  });

  it("uses vaulted Shopify, WooCommerce, and Magento credentials internally without exposing them", async () => {
    for (const platform of [StorePlatform.SHOPIFY, StorePlatform.WOOCOMMERCE, StorePlatform.MAGENTO]) {
      const { client, state } = createFakeClient();
      const connection = addConnection(state, platform);
      attachCredential(state, connection);
      const expectedSecret = platform === StorePlatform.SHOPIFY
        ? "shpat_health_secret"
        : platform === StorePlatform.WOOCOMMERCE
          ? "cs_health_secret"
          : "magentotoken_health_secret";
      const health = await runPlatformConnectionHealthCheck("merchant_1", connection.id, {
        client,
        vault: testVault,
        platformClients: {
          [platform]: unsafeClient(expectedSecret)
        }
      });
      const json = JSON.stringify(health);

      assert.equal(health.status, PlatformHealthCheckStatus.HEALTHY);
      assert.doesNotMatch(json, /shpat_health_secret|cs_health_secret|magentotoken_health_secret|rawResponse|rawHeaders|secretRef|accessToken|consumerSecret|integrationToken/i);
      assert.match(json, /safe/);
    }
  });

  it("stores safe health results and lists latest checks", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.SHOPIFY);
    attachCredential(state, connection);
    await runPlatformConnectionHealthCheck("merchant_1", connection.id, { client, vault: testVault });

    const listed = await listPlatformConnectionHealthChecks("merchant_1", connection.id, { page: 1, per_page: 20 }, client);
    const latest = await getLatestPlatformConnectionHealth("merchant_1", connection.id, client);
    const json = JSON.stringify({ listed, latest, stored: state.healthChecks });

    assert.equal(listed.health_checks.length, 1);
    assert.equal(latest.latest_health_check?.connection_id, connection.id);
    assert.doesNotMatch(json, /encryptedValue|rawResponse|rawHeaders|shpat_health_secret|secretRef/i);
  });

  it("blocks mutation-shaped platform client operations even in real-read mode", () => {
    assert.doesNotThrow(() => assertPlatformReadOnlyOperation("shop.identity", "GET"));
    assert.throws(
      () => assertPlatformReadOnlyOperation("fulfillment.create", "POST"),
      (error: unknown) => error instanceof HttpError && error.message === "PLATFORM_CLIENT_MUTATION_BLOCKED"
    );
  });

  it("runs health check all across multiple connections with partial safe results", async () => {
    const { client, state } = createFakeClient();
    const shopify = addConnection(state, StorePlatform.SHOPIFY);
    attachCredential(state, shopify);
    addConnection(state, StorePlatform.WOOCOMMERCE);

    const result = await runAllPlatformConnectionHealthChecks("merchant_1", { client, vault: testVault });

    assert.equal(result.total, 2);
    assert.equal(result.attention_count, 2);
    assert.equal(state.healthChecks.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /shpat_health_secret|encryptedValue|secretRef/i);
  });

});
