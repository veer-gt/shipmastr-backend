import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlatformConnectionStatus,
  PlatformCredentialStatus,
  PlatformSyncDirection,
  StorePlatform
} from "@prisma/client";
import type { PlatformCredentialVault } from "../../platformIntegrations/credentials/platform-credentials.crypto.js";
import {
  getCredentialVaultReadiness,
  getConnectionCredentialStatus,
  revokeConnectionCredential,
  rotateConnectionCredential,
  testCredentialVaultProvider,
  testConnectionCredentialReadiness,
  upsertConnectionCredential
} from "../credential-vault.service.js";
import { env } from "../../../config/env.js";

const now = new Date("2026-06-08T12:00:00.000Z");

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

function createFakeClient() {
  const state = {
    connections: [] as any[],
    credentials: [] as any[],
    secrets: [] as any[]
  };
  const client = {
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
    },
    platformCredential: {
      create: async ({ data }: any) => {
        const row = { id: id("cred", state.credentials.length), createdAt: now, updatedAt: now, ...data };
        state.credentials.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.credentials.find((row) => (
        row.id === where.id && row.merchantId === where.merchantId
      )) ?? null,
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
      findUnique: async ({ where }: any) => state.secrets.find((row) => row.credentialId === where.credentialId) ?? null,
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
    }
  };
  return { client: client as any, state };
}

function addConnection(
  state: ReturnType<typeof createFakeClient>["state"],
  platform: StorePlatform = StorePlatform.SHOPIFY,
  merchantId = "merchant_1"
) {
  const row = {
    id: id("conn", state.connections.length),
    merchantId,
    platform,
    storeName: `${platform} store`,
    storeUrl: "https://store.example/",
    status: PlatformConnectionStatus.ACTIVE,
    syncDirection: PlatformSyncDirection.IMPORT_ONLY,
    credentialsRef: null,
    credentialsMeta: null,
    createdAt: now,
    updatedAt: now
  };
  state.connections.push(row);
  return row;
}

describe("Phase 28 credential vault/KMS hardening foundation", () => {
  it("returns safe not-ready status for a connection without credentials", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state);
    const status = await getConnectionCredentialStatus("merchant_1", connection.id, client);

    assert.equal(status.status, "NOT_READY");
    assert.equal(status.ready, false);
    assert.equal(status.credential, null);
    assert.doesNotMatch(JSON.stringify(status), /secretRef|encryptedValue|secret_fingerprint|fingerprint|accessToken/i);
  });

  it("stores encrypted connection credentials and returns readiness without secret material", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.SHOPIFY);
    const readiness = await upsertConnectionCredential("merchant_1", connection.id, {
      name: "Shopify production read credential",
      credentials: {
        shopDomain: "demo.myshopify.com",
        apiVersion: "2025-10",
        accessToken: "shpat_phase28_secret"
      }
    }, client, testVault);
    const json = JSON.stringify(readiness);

    assert.equal(readiness.status, "READY");
    assert.equal(readiness.ready, true);
    assert.equal(state.connections[0]?.credentialsRef, `platform-credential:${state.credentials[0]?.id}`);
    assert.notEqual(state.secrets[0]?.encryptedValue, "shpat_phase28_secret");
    assert.doesNotMatch(state.secrets[0]?.encryptedValue, /shpat_phase28_secret/);
    assert.doesNotMatch(json, /shpat_phase28_secret|secretRef|encryptedValue|secret_fingerprint|fingerprint|accessToken/i);
  });

  it("rotates an attached credential and keeps public status hash-free", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.MAGENTO);
    await upsertConnectionCredential("merchant_1", connection.id, {
      credentials: { baseUrl: "https://magento.example", integrationToken: "old_magento_phase28_secret" }
    }, client, testVault);
    const oldFingerprint = state.credentials[0]?.secretFingerprint;
    const oldEncrypted = state.secrets[0]?.encryptedValue;
    const rotated = await rotateConnectionCredential("merchant_1", connection.id, {
      credentials: { baseUrl: "https://magento.example", integrationToken: "new_magento_phase28_secret" }
    }, client, testVault);

    assert.equal(rotated.status, "READY");
    assert.notEqual(state.credentials[0]?.secretFingerprint, oldFingerprint);
    assert.notEqual(state.secrets[0]?.encryptedValue, oldEncrypted);
    assert.equal(state.credentials[0]?.status, PlatformCredentialStatus.ROTATED);
    assert.doesNotMatch(JSON.stringify(rotated), /old_magento_phase28_secret|new_magento_phase28_secret|secretFingerprint|fingerprint|encryptedValue/i);
  });

  it("revokes attached credentials and readiness test never exposes plaintext", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.WOOCOMMERCE);
    await upsertConnectionCredential("merchant_1", connection.id, {
      credentials: {
        siteUrl: "https://woo.example",
        consumerKey: "ck_phase28_secret",
        consumerSecret: "cs_phase28_secret"
      }
    }, client, testVault);
    const tested = await testConnectionCredentialReadiness("merchant_1", connection.id, client, testVault);
    const revoked = await revokeConnectionCredential("merchant_1", connection.id, client, testVault);

    assert.equal(tested.status, "READY");
    assert.equal(revoked.status, "REVOKED");
    assert.equal(revoked.ready, false);
    assert.doesNotMatch(JSON.stringify({ tested, revoked }), /ck_phase28_secret|cs_phase28_secret|secretRef|encryptedValue|fingerprint/i);
  });

  it("enforces merchant scope for credential readiness", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.CUSTOM, "merchant_2");

    await assert.rejects(
      () => getConnectionCredentialStatus("merchant_1", connection.id, client),
      /PLATFORM_CONNECTION_NOT_FOUND/
    );
  });
});

describe("Phase 33 live KMS credential vault readiness", () => {
  it("keeps LOCAL_MOCK usable for development but blocked for live pilot by default", () => {
    const readiness = getCredentialVaultReadiness({
      NODE_ENV: "test",
      APP_ENV: "test",
      CREDENTIAL_VAULT_PROVIDER: "LOCAL_MOCK",
      CREDENTIAL_VAULT_REQUIRE_LIVE_FOR_PILOT: "true"
    });
    const json = JSON.stringify(readiness);

    assert.equal(readiness.status, "MOCK_ONLY");
    assert.equal(readiness.ready, false);
    assert.equal(readiness.runtime.local_mock, true);
    assert.equal(readiness.runtime.pilot_ready, false);
    assert.match(json, /LOCAL_MOCK/);
    assert.doesNotMatch(json, /encryptedValue|secretRef|credentialHash|secretHash|accessToken|consumerSecret/i);
  });

  it("uses ENV_ENCRYPTION_KEY provider without exposing plaintext or encrypted values", () => {
    const previousProvider = env.CREDENTIAL_VAULT_PROVIDER;
    const previousKey = env.CREDENTIAL_VAULT_ENCRYPTION_KEY;
    try {
      (env as any).CREDENTIAL_VAULT_PROVIDER = "ENV_ENCRYPTION_KEY";
      (env as any).CREDENTIAL_VAULT_ENCRYPTION_KEY = "phase33-env-encryption-key";

      const result = testCredentialVaultProvider({
        NODE_ENV: "test",
        APP_ENV: "test",
        CREDENTIAL_VAULT_PROVIDER: "ENV_ENCRYPTION_KEY",
        CREDENTIAL_VAULT_ENCRYPTION_KEY: "phase33-env-encryption-key",
        CREDENTIAL_VAULT_REQUIRE_LIVE_FOR_PILOT: "true"
      });
      const json = JSON.stringify(result);

      assert.equal(result.status, "READY");
      assert.equal(result.ready, true);
      assert.equal(result.runtime.provider, "ENV_ENCRYPTION_KEY");
      assert.equal(result.safe_details.provider_round_trip, true);
      assert.doesNotMatch(json, /phase33-env-encryption-key|safe-sentinel|encryptedValue|secretRef|credentialHash|secretHash/i);
    } finally {
      (env as any).CREDENTIAL_VAULT_PROVIDER = previousProvider;
      (env as any).CREDENTIAL_VAULT_ENCRYPTION_KEY = previousKey;
    }
  });

  it("fails the KMS interface safely when required configuration is missing", () => {
    const result = testCredentialVaultProvider({
      NODE_ENV: "test",
      APP_ENV: "test",
      CREDENTIAL_VAULT_PROVIDER: "KMS_INTERFACE",
      CREDENTIAL_VAULT_REQUIRE_LIVE_FOR_PILOT: "true"
    });
    const json = JSON.stringify(result);

    assert.equal(result.status, "NOT_CONFIGURED");
    assert.equal(result.ready, false);
    assert.equal(result.runtime.provider, "KMS_INTERFACE");
    assert.equal(result.runtime.kms_key_configured, false);
    assert.doesNotMatch(json, /encryptedValue|secretRef|credentialHash|secretHash|accessToken|consumerSecret/i);
  });

  it("reports KMS interface readiness with safe booleans only when configured", () => {
    const readiness = getCredentialVaultReadiness({
      NODE_ENV: "test",
      APP_ENV: "test",
      CREDENTIAL_VAULT_PROVIDER: "KMS_INTERFACE",
      CREDENTIAL_VAULT_KMS_KEY_ID: "kms-key-alias",
      CREDENTIAL_VAULT_ENCRYPTION_KEY: "phase33-kms-interface-key",
      CREDENTIAL_VAULT_REQUIRE_LIVE_FOR_PILOT: "true"
    });
    const json = JSON.stringify(readiness);

    assert.equal(readiness.status, "READY");
    assert.equal(readiness.ready, true);
    assert.equal(readiness.runtime.production_kms_ready, true);
    assert.equal(readiness.runtime.pilot_ready, true);
    assert.doesNotMatch(json, /phase33-kms-interface-key|kms-key-alias:[A-Za-z0-9]|encryptedValue|secretRef|credentialHash|secretHash/i);
  });
});
