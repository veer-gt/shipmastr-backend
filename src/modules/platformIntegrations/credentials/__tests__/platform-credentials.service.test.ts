import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlatformConnectionStatus,
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformCredentialType,
  PlatformSyncDirection,
  StorePlatform
} from "@prisma/client";
import { env } from "../../../../config/env.js";
import { HttpError } from "../../../../lib/httpError.js";
import { createLocalPlatformCredentialVault, type PlatformCredentialVault } from "../platform-credentials.crypto.js";
import {
  attachCredentialToConnection,
  createPlatformCredential,
  detachCredentialFromConnection,
  listPlatformCredentials,
  revokePlatformCredential,
  rotatePlatformCredential,
  validateCredentialShapeForResponse
} from "../platform-credentials.service.js";

const now = new Date("2026-06-08T01:00:00.000Z");

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
    credentials: [] as any[],
    secrets: [] as any[],
    connections: [] as any[]
  };
  const client = {
    platformCredential: {
      create: async ({ data }: any) => {
        const row = { id: id("cred", state.credentials.length), createdAt: now, updatedAt: now, ...data };
        state.credentials.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.credentials.find((row) => (
        row.id === where.id && row.merchantId === where.merchantId
      )) ?? null,
      findMany: async (args: any = {}) => pageRows(state.credentials.filter((row) => (
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.platform || row.platform === args.where.platform) &&
        (!args.where?.status || row.status === args.where.status)
      )), args),
      count: async ({ where }: any = {}) => state.credentials.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.platform || row.platform === where.platform) &&
        (!where?.status || row.status === where.status)
      )).length,
      update: async ({ where, data }: any) => {
        const row = state.credentials.find((item) => item.id === where.id);
        if (!row) throw new Error("credential missing");
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    platformCredentialSecret: {
      create: async ({ data }: any) => {
        const row = { id: id("secret", state.secrets.length), createdAt: now, updatedAt: now, ...data };
        state.secrets.push(row);
        return row;
      },
      upsert: async ({ where, create, update }: any) => {
        const row = state.secrets.find((item) => item.credentialId === where.credentialId);
        if (row) {
          Object.assign(row, update, { updatedAt: now });
          return row;
        }
        const created = { id: id("secret", state.secrets.length), createdAt: now, updatedAt: now, ...create };
        state.secrets.push(created);
        return created;
      }
    },
    platformConnection: {
      findFirst: async ({ where }: any) => state.connections.find((row) => (
        row.id === where.id && row.merchantId === where.merchantId
      )) ?? null,
      update: async ({ where, data }: any) => {
        const row = state.connections.find((item) => item.id === where.id);
        if (!row) throw new Error("connection missing");
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    }
  };
  return { client: client as any, state };
}

function addConnection(state: ReturnType<typeof createFakeClient>["state"], platform: StorePlatform, merchantId = "merchant_1") {
  const row = {
    id: id("conn", state.connections.length),
    merchantId,
    platform,
    storeName: `${platform} store`,
    storeUrl: "https://store.example/",
    status: PlatformConnectionStatus.DRAFT,
    syncDirection: PlatformSyncDirection.IMPORT_ONLY,
    credentialsRef: null,
    credentialsMeta: null,
    createdAt: now,
    updatedAt: now
  };
  state.connections.push(row);
  return row;
}

describe("Phase 18 platform credential vault foundation", () => {
  it("creates encrypted platform credentials and returns safe metadata only", async () => {
    const { client, state } = createFakeClient();
    const created = await createPlatformCredential("merchant_1", {
      platform: "SHOPIFY",
      credentialType: "SHOPIFY_CUSTOM_APP_TOKEN",
      name: "Shopify private app",
      credentials: {
        shopDomain: "demo.myshopify.com",
        apiVersion: "2025-10",
        accessToken: "shpat_secret_should_not_store"
      }
    }, client, testVault);
    const json = JSON.stringify(created);

    assert.equal(created.platform, PlatformCredentialProvider.SHOPIFY);
    assert.equal(created.credential_type, PlatformCredentialType.SHOPIFY_CUSTOM_APP_TOKEN);
    assert.equal(created.safe_metadata?.shop_domain, "demo.myshopify.com");
    assert.match(String(created.safe_metadata?.token_prefix), /^shpa/);
    assert.notEqual(state.secrets[0]?.encryptedValue, JSON.stringify(state.credentials[0]?.safeMetadata));
    assert.doesNotMatch(state.secrets[0]?.encryptedValue, /shpat_secret_should_not_store/);
    assert.doesNotMatch(json, /shpat_secret_should_not_store|secretRef|encryptedValue|accessToken|credentialsRef/i);
  });

  it("validates Shopify, WooCommerce, Magento, and Custom credential shapes safely", () => {
    const shopify = validateCredentialShapeForResponse({
      platform: "SHOPIFY",
      credentialType: "SHOPIFY_CUSTOM_APP_TOKEN",
      credentials: { shopDomain: "demo.myshopify.com", apiVersion: "2025-10", accessToken: "shpat_valid_test_secret" }
    });
    const woo = validateCredentialShapeForResponse({
      platform: "WOOCOMMERCE",
      credentialType: "WOOCOMMERCE_REST_KEYS",
      credentials: { siteUrl: "https://woo.example", consumerKey: "ck_test_secret", consumerSecret: "cs_test_secret" }
    });
    const magento = validateCredentialShapeForResponse({
      platform: "MAGENTO",
      credentialType: "MAGENTO_INTEGRATION_TOKEN",
      credentials: { baseUrl: "https://magento.example", storeViewCode: "default", integrationToken: "magentotoken_secret" }
    });
    const custom = validateCredentialShapeForResponse({
      platform: "CUSTOM",
      credentialType: "CUSTOM_API_KEY",
      credentials: { baseUrl: "https://api.example", headerName: "X-Shipmastr-Key", apiKey: "custom_secret_key" }
    });
    const json = JSON.stringify({ shopify, woo, magento, custom });
    const wooMeta = woo.safe_metadata as Record<string, unknown>;
    const magentoMeta = magento.safe_metadata as Record<string, unknown>;
    const customMeta = custom.safe_metadata as Record<string, unknown>;

    assert.equal(shopify.valid, true);
    assert.equal(wooMeta.site_url, "https://woo.example/");
    assert.equal(magentoMeta.store_view_code, "default");
    assert.equal(customMeta.header_name, "X-Shipmastr-Key");
    assert.doesNotMatch(json, /shpat_valid_test_secret|cs_test_secret|magentotoken_secret|custom_secret_key|secretRef|encryptedValue/i);
  });

  it("rotates credentials without exposing secret material", async () => {
    const { client, state } = createFakeClient();
    const credential = await createPlatformCredential("merchant_1", {
      platform: "MAGENTO",
      credentialType: "MAGENTO_INTEGRATION_TOKEN",
      name: "Magento integration",
      credentials: { baseUrl: "https://magento.example", integrationToken: "old_magento_secret" }
    }, client, testVault);
    const oldFingerprint = credential.secret_fingerprint;
    const oldEncrypted = state.secrets[0]?.encryptedValue;
    const rotated = await rotatePlatformCredential("merchant_1", credential.credential_id, {
      credentials: { baseUrl: "https://magento.example", integrationToken: "new_magento_secret" }
    }, client, testVault);
    const json = JSON.stringify(rotated);

    assert.equal(rotated.status, PlatformCredentialStatus.ROTATED);
    assert.ok(rotated.rotated_at);
    assert.notEqual(rotated.secret_fingerprint, oldFingerprint);
    assert.notEqual(state.secrets[0]?.encryptedValue, oldEncrypted);
    assert.doesNotMatch(json, /old_magento_secret|new_magento_secret|encryptedValue|secretRef/i);
  });

  it("attaches and detaches credentials with platform scoping and safe connection metadata", async () => {
    const { client, state } = createFakeClient();
    const shopifyConnection = addConnection(state, StorePlatform.SHOPIFY);
    const wooConnection = addConnection(state, StorePlatform.WOOCOMMERCE);
    const credential = await createPlatformCredential("merchant_1", {
      platform: "SHOPIFY",
      credentialType: "SHOPIFY_CUSTOM_APP_TOKEN",
      name: "Shopify",
      credentials: { shopDomain: "demo.myshopify.com", accessToken: "shpat_attach_secret" }
    }, client, testVault);

    await assert.rejects(
      () => attachCredentialToConnection("merchant_1", wooConnection.id, credential.credential_id, client),
      (error: unknown) => error instanceof HttpError && error.message === "PLATFORM_CREDENTIAL_PLATFORM_MISMATCH"
    );

    const attached = await attachCredentialToConnection("merchant_1", shopifyConnection.id, credential.credential_id, client);
    const storedConnection = state.connections.find((row) => row.id === shopifyConnection.id);
    const attachedJson = JSON.stringify(attached);

    assert.equal(attached.credential_status, "configured_placeholder");
    assert.equal(storedConnection?.credentialsRef, `platform-credential:${credential.credential_id}`);
    assert.equal(storedConnection?.credentialsMeta.credential_id, credential.credential_id);
    assert.doesNotMatch(attachedJson, /shpat_attach_secret|secretRef|encryptedValue|credentialsRef/i);

    const detached = await detachCredentialFromConnection("merchant_1", shopifyConnection.id, client);
    assert.equal(detached.credential_status, "not_configured");
    assert.equal(storedConnection?.credentialsRef, null);
  });

  it("revokes credentials and blocks future attachment", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.CUSTOM);
    const credential = await createPlatformCredential("merchant_1", {
      platform: "CUSTOM",
      credentialType: "CUSTOM_API_KEY",
      name: "Custom API",
      credentials: { baseUrl: "https://api.example", apiKey: "custom_revoke_secret" }
    }, client, testVault);
    const revoked = await revokePlatformCredential("merchant_1", credential.credential_id, client);

    assert.equal(revoked.status, PlatformCredentialStatus.REVOKED);
    await assert.rejects(
      () => attachCredentialToConnection("merchant_1", connection.id, credential.credential_id, client),
      (error: unknown) => error instanceof HttpError && error.message === "PLATFORM_CREDENTIAL_REVOKED"
    );
  });

  it("lists credential metadata without secret storage fields", async () => {
    const { client } = createFakeClient();
    await createPlatformCredential("merchant_1", {
      platform: "WOOCOMMERCE",
      credentialType: "WOOCOMMERCE_REST_KEYS",
      name: "Woo",
      credentials: { siteUrl: "https://woo.example", consumerKey: "ck_list_secret", consumerSecret: "cs_list_secret" }
    }, client, testVault);
    const listed = await listPlatformCredentials("merchant_1", { page: 1, per_page: 20 }, client);
    const json = JSON.stringify(listed);

    assert.equal(listed.credentials.length, 1);
    assert.doesNotMatch(json, /ck_list_secret|cs_list_secret|secretRef|encryptedValue|consumerSecret/i);
  });

  it("fails closed outside dev/test when vault key is missing", () => {
    const previousNodeEnv = env.NODE_ENV;
    const previousAppEnv = env.APP_ENV;
    const previousVaultKey = env.SHIPMASTR_CREDENTIAL_VAULT_KEY;
    try {
      (env as any).NODE_ENV = "production";
      (env as any).APP_ENV = "production";
      (env as any).SHIPMASTR_CREDENTIAL_VAULT_KEY = undefined;
      assert.throws(
        () => createLocalPlatformCredentialVault().storeSecret({ apiKey: "production_secret" }),
        (error: unknown) => error instanceof HttpError && error.message === "PLATFORM_CREDENTIAL_VAULT_KEY_MISSING"
      );
    } finally {
      (env as any).NODE_ENV = previousNodeEnv;
      (env as any).APP_ENV = previousAppEnv;
      (env as any).SHIPMASTR_CREDENTIAL_VAULT_KEY = previousVaultKey;
    }
  });
});
