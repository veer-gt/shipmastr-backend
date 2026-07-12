import crypto from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StorePlatform } from "@prisma/client";
import {
  configurePlatformWebhookCredential,
  getPlatformWebhookCredentialStatus,
  resolvePlatformWebhookCredentialCandidates,
  revokePlatformWebhookCredential,
  rotatePlatformWebhookCredential
} from "./platform-webhook-credential.service.js";
import { createPlatformWebhookCredentialVault, PLATFORM_WEBHOOK_SIGNATURE_PURPOSE } from "./platform-webhook-credential.crypto.js";

function makeClient() {
  const connection = {
    id: "connection_a",
    merchantId: "merchant_a",
    platform: StorePlatform.SHOPIFY,
    status: "ACTIVE"
  } as any;
  const state: { row: any } = { row: null };
  const client = {
    platformConnection: {
      findFirst: async ({ where }: any) => where.merchantId === connection.merchantId && where.id === connection.id ? connection : null
    },
    platformWebhookCredential: {
      findUnique: async () => state.row,
      upsert: async ({ create, update }: any) => {
        state.row = state.row ? { ...state.row, ...update, updatedAt: new Date() } : {
          id: "credential_a",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create
        };
        return state.row;
      },
      update: async ({ data }: any) => {
        if (!state.row) throw new Error("credential missing");
        state.row = { ...state.row, ...data, updatedAt: new Date() };
        return state.row;
      }
    }
  };
  return { client: client as any, state, connection };
}

describe("H2A platform webhook credential service", () => {
  it("configures, resolves, rotates with grace, expires previous, and revokes", async () => {
    const { client, state } = makeClient();
    const vault = createPlatformWebhookCredentialVault({}, crypto.randomBytes(32));
    const configured = await configurePlatformWebhookCredential("merchant_a", "connection_a", {
      platform: "SHOPIFY",
      secret: "fixture-webhook-secret-current"
    }, client, vault);
    assert.equal(configured.configured, true);
    assert.equal(configured.revoked, false);
    assert.doesNotMatch(JSON.stringify(configured), /fixture-webhook-secret-current/);
    assert.doesNotMatch(JSON.stringify(state.row), /fixture-webhook-secret-current/);

    const first = await resolvePlatformWebhookCredentialCandidates({
      merchantId: "merchant_a",
      connectionId: "connection_a",
      platform: "SHOPIFY",
      purpose: PLATFORM_WEBHOOK_SIGNATURE_PURPOSE
    }, client, vault);
    assert.deepEqual(first, { current: "fixture-webhook-secret-current", previous: null });

    const rotated = await rotatePlatformWebhookCredential("merchant_a", "connection_a", {
      replacementSecret: "fixture-webhook-secret-replacement",
      gracePeriodSeconds: 3600
    }, client, vault);
    assert.equal(rotated.configured, true);
    const duringGrace = await resolvePlatformWebhookCredentialCandidates({
      merchantId: "merchant_a",
      connectionId: "connection_a",
      platform: "SHOPIFY",
      purpose: PLATFORM_WEBHOOK_SIGNATURE_PURPOSE
    }, client, vault);
    assert.deepEqual(duringGrace, { current: "fixture-webhook-secret-replacement", previous: "fixture-webhook-secret-current" });

    state.row.previousValidUntil = new Date(Date.now() - 1);
    const afterGrace = await resolvePlatformWebhookCredentialCandidates({
      merchantId: "merchant_a",
      connectionId: "connection_a",
      platform: "SHOPIFY",
      purpose: PLATFORM_WEBHOOK_SIGNATURE_PURPOSE
    }, client, vault);
    assert.deepEqual(afterGrace, { current: "fixture-webhook-secret-replacement", previous: null });

    const revoked = await revokePlatformWebhookCredential("merchant_a", "connection_a", client);
    assert.equal(revoked.revoked, true);
    assert.equal((await resolvePlatformWebhookCredentialCandidates({
      merchantId: "merchant_a",
      connectionId: "connection_a",
      platform: "SHOPIFY",
      purpose: PLATFORM_WEBHOOK_SIGNATURE_PURPOSE
    }, client, vault)).current, null);
  });

  it("enforces merchant ownership and platform binding", async () => {
    const { client } = makeClient();
    const vault = createPlatformWebhookCredentialVault({}, crypto.randomBytes(32));
    await assert.rejects(() => getPlatformWebhookCredentialStatus("merchant_b", "connection_a", client), /PLATFORM_CONNECTION_NOT_FOUND/);
    await assert.rejects(() => configurePlatformWebhookCredential("merchant_a", "connection_a", {
      platform: "MAGENTO",
      secret: "fixture-webhook-secret-current"
    }, client, vault), /PLATFORM_WEBHOOK_CREDENTIAL_PLATFORM_MISMATCH/);
    const isolated = await resolvePlatformWebhookCredentialCandidates({
      merchantId: "merchant_b",
      connectionId: "connection_a",
      platform: "SHOPIFY",
      purpose: PLATFORM_WEBHOOK_SIGNATURE_PURPOSE
    }, client, vault);
    assert.deepEqual(isolated, { current: null, previous: null });
  });
});
