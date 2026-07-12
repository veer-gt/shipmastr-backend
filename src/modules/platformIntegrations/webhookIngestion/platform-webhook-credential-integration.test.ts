import crypto from "node:crypto";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { StorePlatform } from "@prisma/client";
import {
  configurePlatformWebhookCredential,
  rotatePlatformWebhookCredential
} from "../../credentialVault/platform-webhook-credential.service.js";
import { createPlatformWebhookCredentialVault } from "../../credentialVault/platform-webhook-credential.crypto.js";
import { ingestPlatformWebhookEvent } from "./platform-webhook.service.js";

const originalKey = process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY = originalKey;
});

function makeClient(platform: StorePlatform) {
  const connection = {
    id: `connection_${platform.toLowerCase()}`,
    merchantId: "merchant_fixture",
    platform,
    status: "ACTIVE"
  } as any;
  const state: { credential: any; events: any[] } = { credential: null, events: [] };
  const client = {
    platformConnection: {
      findFirst: async ({ where }: any) => where.id === connection.id && where.merchantId === connection.merchantId ? connection : null
    },
    platformWebhookCredential: {
      findUnique: async () => state.credential,
      upsert: async ({ create, update }: any) => {
        state.credential = state.credential ? { ...state.credential, ...update } : { id: `credential_${platform}`, ...create };
        return state.credential;
      },
      update: async ({ data }: any) => {
        state.credential = { ...state.credential, ...data };
        return state.credential;
      }
    },
    platformWebhookEvent: {
      findFirst: async ({ where }: any) => state.events.find((event) => event.merchantId === where.merchantId && event.dedupeKey === where.dedupeKey) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `event_${state.events.length + 1}`, ...data };
        state.events.push(row);
        return row;
      }
    }
  };
  return { client: client as any, connection, state };
}

function signedHeaders(platform: StorePlatform, secret: string, body: string, id: string) {
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64");
  if (platform === StorePlatform.SHOPIFY) return {
    "x-shopify-hmac-sha256": signature,
    "x-shopify-topic": "orders/create",
    "x-shopify-shop-domain": "fixture.myshopify.com",
    "x-shopify-webhook-id": id,
    "x-shopify-triggered-at": "2026-07-12T00:00:00.000Z"
  };
  if (platform === StorePlatform.WOOCOMMERCE) return {
    "x-wc-webhook-source": "https://fixture.example",
    "x-wc-webhook-topic": "order.created",
    "x-wc-webhook-resource": "order",
    "x-wc-webhook-event": "created",
    "x-wc-webhook-signature": signature,
    "x-wc-webhook-id": id,
    "x-wc-webhook-delivery-id": id
  };
  return {
    "x-magento-topic": "sales_order",
    "x-magento-event": "sales_order_place_after",
    "x-magento-webhook-id": id,
    "x-magento-signature": signature
  };
}

function payload(platform: StorePlatform) {
  return platform === StorePlatform.MAGENTO
    ? { entity_id: "fixture_magento_order", increment_id: "100001" }
    : { id: "fixture_order", number: "100001" };
}

describe("H2A tenant-scoped provider verification", () => {
  for (const platform of [StorePlatform.SHOPIFY, StorePlatform.WOOCOMMERCE, StorePlatform.MAGENTO]) {
    it(`${platform} resolves current and previous secrets without a global fallback`, async () => {
      const { client, connection, state } = makeClient(platform);
      const key = crypto.randomBytes(32);
      process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY = key.toString("hex");
      const vault = createPlatformWebhookCredentialVault({}, key);
      const current = "fixture-current-webhook-secret";
      const previous = "fixture-previous-webhook-secret";
      await configurePlatformWebhookCredential("merchant_fixture", connection.id, { platform, secret: current }, client, vault);
      const body = JSON.stringify(payload(platform));
      const first = await ingestPlatformWebhookEvent("merchant_fixture", {
        platform,
        connectionId: connection.id,
        headers: signedHeaders(platform, current, body, `${platform}-current`),
        payload: payload(platform),
        rawBody: Buffer.from(body)
      }, client);
      assert.equal(first.event.status, "VERIFIED");

      await rotatePlatformWebhookCredential("merchant_fixture", connection.id, {
        replacementSecret: previous,
        gracePeriodSeconds: 3600
      }, client, vault);
      const oldBody = JSON.stringify({ ...payload(platform), id: "fixture_order_previous" });
      const duringGrace = await ingestPlatformWebhookEvent("merchant_fixture", {
        platform,
        connectionId: connection.id,
        headers: signedHeaders(platform, current, oldBody, `${platform}-previous`),
        payload: JSON.parse(oldBody),
        rawBody: Buffer.from(oldBody)
      }, client);
      assert.equal(duringGrace.event.status, "VERIFIED");

      state.credential.previousValidUntil = new Date(Date.now() - 1);
      const expiredBody = JSON.stringify({ ...payload(platform), id: "fixture_order_expired" });
      const expired = await ingestPlatformWebhookEvent("merchant_fixture", {
        platform,
        connectionId: connection.id,
        headers: signedHeaders(platform, current, expiredBody, `${platform}-expired`),
        payload: JSON.parse(expiredBody),
        rawBody: Buffer.from(expiredBody)
      }, client);
      assert.equal(expired.event.status, "REJECTED");
    });
  }

  it("returns NOT_CONFIGURED without a global secret and minimizes rejected data", async () => {
    const { client, connection } = makeClient(StorePlatform.SHOPIFY);
    process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    const body = JSON.stringify({ id: "fixture_rejected_order", customer: { email: "buyer@example.test" } });
    const result = await ingestPlatformWebhookEvent("merchant_fixture", {
      platform: StorePlatform.SHOPIFY,
      connectionId: connection.id,
      headers: signedHeaders(StorePlatform.SHOPIFY, "global-secret-that-must-not-be-used", body, "SHOPIFY-missing"),
      payload: JSON.parse(body),
      rawBody: Buffer.from(body)
    }, client);
    assert.equal(result.event.status, "REJECTED");
    assert.match(JSON.stringify(result.event.errors), /WEBHOOK_SIGNATURE_NOT_CONFIGURED/);
    assert.doesNotMatch(JSON.stringify(result), /buyer@example.test|fixture_rejected_order/i);
  });
});
