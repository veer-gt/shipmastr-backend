import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StorePlatform } from "@prisma/client";
import {
  getPlatformWebhookEvent,
  ingestPlatformWebhookEvent,
  listPlatformWebhookEvents,
  stagePlatformWebhookEventImport
} from "../platform-webhook.service.js";

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("not" in expected) return row[key] !== (expected as Record<string, unknown>).not;
    }
    return row[key] === expected;
  });
}

function makeClient() {
  const now = () => new Date("2026-06-08T09:00:00.000Z");
  const state = {
    connections: [
      {
        id: "conn_shopify",
        merchantId: "merchant_1",
        platform: StorePlatform.SHOPIFY,
        storeName: "Shopify demo",
        storeUrl: "https://demo.myshopify.com",
        status: "ACTIVE",
        syncDirection: "IMPORT_ONLY",
        credentialsRef: null,
        credentialsMeta: null,
        createdAt: now(),
        updatedAt: now()
      },
      {
        id: "conn_woo",
        merchantId: "merchant_1",
        platform: StorePlatform.WOOCOMMERCE,
        storeName: "Woo demo",
        storeUrl: "https://woo.example",
        status: "ACTIVE",
        syncDirection: "IMPORT_ONLY",
        credentialsRef: null,
        credentialsMeta: null,
        createdAt: now(),
        updatedAt: now()
      }
    ] as any[],
    events: [] as any[],
    jobs: [] as any[],
    items: [] as any[],
    orders: [] as any[],
    shipments: [] as any[]
  };
  const client = {
    platformConnection: {
      findFirst: async ({ where }: any) => state.connections.find((row) => matches(row, where)) ?? null
    },
    platformWebhookEvent: {
      create: async ({ data }: any) => {
        const row = {
          id: `webhook_event_${state.events.length + 1}`,
          ...data,
          receivedAt: data.receivedAt ?? now(),
          processedAt: data.processedAt ?? null,
          importJobId: data.importJobId ?? null,
          importItemId: data.importItemId ?? null,
          createdAt: now(),
          updatedAt: now()
        };
        state.events.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.events.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where = {}, skip = 0, take = 20 }: any) => state.events.filter((row) => matches(row, where)).slice(skip, skip + take),
      count: async ({ where = {} }: any) => state.events.filter((row) => matches(row, where)).length,
      update: async ({ where, data }: any) => {
        const row = state.events.find((event) => event.id === where.id);
        if (!row) throw new Error("event missing");
        Object.assign(row, data, { updatedAt: now() });
        return row;
      }
    },
    platformImportJob: {
      create: async ({ data }: any) => {
        const row = {
          id: `import_job_${state.jobs.length + 1}`,
          ...data,
          startedAt: data.startedAt ?? null,
          completedAt: data.completedAt ?? null,
          cancelledAt: data.cancelledAt ?? null,
          createdAt: now(),
          updatedAt: now()
        };
        state.jobs.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.jobs.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where = {} }: any) => state.jobs.filter((row) => matches(row, where)),
      count: async ({ where = {} }: any) => state.jobs.filter((row) => matches(row, where)).length,
      update: async ({ where, data }: any) => {
        const row = state.jobs.find((job) => job.id === where.id);
        if (!row) throw new Error("job missing");
        Object.assign(row, data, { updatedAt: now() });
        return row;
      }
    },
    platformImportItem: {
      create: async ({ data }: any) => {
        const row = {
          id: `import_item_${state.items.length + 1}`,
          attemptCount: 0,
          lastAttemptAt: null,
          nextAttemptAt: null,
          orderImportId: null,
          normalizedOrderId: null,
          errorCode: null,
          errorMessage: null,
          mappingWarnings: null,
          safePayloadPreview: null,
          ...data,
          createdAt: now(),
          updatedAt: now()
        };
        state.items.push(row);
        return row;
      },
      findMany: async ({ where = {} }: any) => state.items.filter((row) => matches(row, where)),
      update: async ({ where, data }: any) => {
        const row = state.items.find((item) => item.id === where.id);
        if (!row) throw new Error("item missing");
        Object.assign(row, data, { updatedAt: now() });
        return row;
      }
    },
    platformOrderImport: {
      findFirst: async () => null
    }
  };
  return { state, client: client as any };
}

const shopifyPayload = {
  id: "1001",
  name: "#1001",
  created_at: "2026-06-08T08:00:00.000Z",
  total_price: "1299.00",
  currency: "INR",
  financial_status: "paid",
  shipping_address: {
    name: "Buyer One",
    phone: "9876543210",
    address1: "221 Market Street",
    city: "Mumbai",
    province: "MH",
    zip: "400001",
    country_code: "IN"
  },
  line_items: [{ name: "T-shirt", sku: "TEE", quantity: 1, grams: 500, price: "1299.00" }]
};

function shopifyHeaders(secret: string, overrides: Record<string, string> = {}, payload: unknown = shopifyPayload) {
  const body = JSON.stringify(payload);
  return {
    "X-Shopify-Hmac-Sha256": createHmac("sha256", secret).update(body).digest("base64"),
    "X-Shopify-Topic": "orders/create",
    "X-Shopify-Shop-Domain": "demo.myshopify.com",
    "X-Shopify-Webhook-Id": "webhook_1",
    "X-Shopify-Triggered-At": "2026-06-08T08:00:00.000Z",
    ...overrides
  };
}

describe("platform webhook ingestion foundation", () => {
  it("creates valid webhook events and keeps public responses safe", async () => {
    const { state, client } = makeClient();
    const unsafePayload = {
      ...shopifyPayload,
      rawHeaders: { Authorization: "Bearer secret" },
      accessToken: "shpat_secret",
      providerName: "Bigship"
    };
    const result = await ingestPlatformWebhookEvent("merchant_1", {
      platform: StorePlatform.SHOPIFY,
      connectionId: "conn_shopify",
      headers: shopifyHeaders("test_secret", {}, unsafePayload),
      payload: unsafePayload
    }, client, { credentialCandidates: ["test_secret"] });

    assert.equal(result.event.status, "VERIFIED");
    assert.equal(result.event.topic, "SHOPIFY_ORDER_CREATED");
    assert.equal(state.events.length, 1);
    const json = JSON.stringify(result);
    assert.doesNotMatch(json, /shpat_secret|Authorization|rawHeaders|rawPayload|event_hash|dedupe|Bigship|providerName|9876543210|221 Market Street/i);
  });

  it("rejects invalid or unconfigured signatures safely", async () => {
    const { client } = makeClient();
    const invalid = await ingestPlatformWebhookEvent("merchant_1", {
      platform: StorePlatform.SHOPIFY,
      connectionId: "conn_shopify",
      headers: shopifyHeaders("wrong_secret"),
      payload: shopifyPayload
    }, client, { credentialCandidates: ["test_secret"] });
    assert.equal(invalid.event.status, "REJECTED");
    assert.equal(invalid.event.external_event_id, null);
    assert.match(JSON.stringify(invalid.event.errors), /WEBHOOK_SIGNATURE_INVALID/);
    assert.doesNotMatch(JSON.stringify(invalid), /Buyer One|Mumbai|9876543210|221 Market Street|T-shirt/i);

    const notConfiguredPayload = { ...shopifyPayload, id: "1002" };
    const notConfigured = await ingestPlatformWebhookEvent("merchant_1", {
      platform: StorePlatform.SHOPIFY,
      connectionId: "conn_shopify",
      headers: shopifyHeaders("test_secret", { "X-Shopify-Webhook-Id": "webhook_2" }, notConfiguredPayload),
      payload: notConfiguredPayload
    }, client);
    assert.equal(notConfigured.event.status, "REJECTED");
    assert.equal(notConfigured.event.external_event_id, null);
    assert.match(JSON.stringify(notConfigured.event.errors), /WEBHOOK_SIGNATURE_NOT_CONFIGURED/);
    assert.doesNotMatch(JSON.stringify(notConfigured), /Buyer One|Mumbai|9876543210|221 Market Street|T-shirt/i);
  });

  it("deduplicates repeated platform webhook deliveries", async () => {
    const { state, client } = makeClient();
    const first = await ingestPlatformWebhookEvent("merchant_1", {
      platform: StorePlatform.SHOPIFY,
      connectionId: "conn_shopify",
      headers: shopifyHeaders("test_secret"),
      payload: shopifyPayload
    }, client, { credentialCandidates: ["test_secret"] });
    const duplicate = await ingestPlatformWebhookEvent("merchant_1", {
      platform: StorePlatform.SHOPIFY,
      connectionId: "conn_shopify",
      headers: shopifyHeaders("test_secret"),
      payload: shopifyPayload
    }, client, { credentialCandidates: ["test_secret"] });

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.event.status, "DUPLICATE");
    assert.equal(state.events.length, 1);
  });

  it("stores unknown topics as ignored safely", async () => {
    const { client } = makeClient();
    const result = await ingestPlatformWebhookEvent("merchant_1", {
      platform: StorePlatform.SHOPIFY,
      connectionId: "conn_shopify",
      headers: shopifyHeaders("test_secret", { "X-Shopify-Topic": "products/create", "X-Shopify-Webhook-Id": "webhook_unknown" }),
      payload: shopifyPayload
    }, client, { credentialCandidates: ["test_secret"] });

    assert.equal(result.event.status, "IGNORED");
    assert.equal(result.event.topic, "UNKNOWN");
    assert.match(JSON.stringify(result.event.warnings), /not mapped/);
  });

  it("lists and fetches webhook events within merchant scope only", async () => {
    const { state, client } = makeClient();
    await ingestPlatformWebhookEvent("merchant_1", {
      platform: StorePlatform.SHOPIFY,
      connectionId: "conn_shopify",
      headers: shopifyHeaders("test_secret"),
      payload: shopifyPayload
    }, client, { credentialCandidates: ["test_secret"] });
    state.events.push({
      ...state.events[0],
      id: "webhook_event_other",
      merchantId: "merchant_2",
      dedupeKey: "other"
    });

    const list = await listPlatformWebhookEvents("merchant_1", { page: 1, per_page: 20 }, client);
    const detail = await getPlatformWebhookEvent("merchant_1", state.events[0]!.id, client);
    assert.equal(list.events.length, 1);
    assert.equal(detail.event_id, state.events[0]!.id);
    await assert.rejects(() => getPlatformWebhookEvent("merchant_1", "webhook_event_other", client), /PLATFORM_WEBHOOK_EVENT_NOT_FOUND/);
  });

  it("stages verified webhook events into safe import queue records only", async () => {
    const { state, client } = makeClient();
    const ingested = await ingestPlatformWebhookEvent("merchant_1", {
      platform: StorePlatform.SHOPIFY,
      connectionId: "conn_shopify",
      headers: shopifyHeaders("test_secret"),
      payload: shopifyPayload
    }, client, { credentialCandidates: ["test_secret"] });

    const staged = await stagePlatformWebhookEventImport("merchant_1", ingested.event.event_id, client);
    assert.equal(staged.event.status, "STAGED_FOR_IMPORT");
    assert.equal(staged.import_job?.source, "WEBHOOK_PAYLOAD");
    assert.equal(staged.import_items.length, 1);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.items.length, 1);
    assert.equal(state.orders.length, 0);
    assert.equal(state.shipments.length, 0);
    const json = JSON.stringify(staged);
    assert.doesNotMatch(json, /9876543210|221 Market Street|Authorization|shpat_secret|rawPayload|rawHeaders|providerName|Bigship/i);
  });

  it("does not stage rejected webhook events", async () => {
    const { client } = makeClient();
    const rejected = await ingestPlatformWebhookEvent("merchant_1", {
      platform: StorePlatform.SHOPIFY,
      connectionId: "conn_shopify",
      headers: shopifyHeaders("wrong_secret"),
      payload: shopifyPayload
    }, client, { credentialCandidates: ["test_secret"] });

    await assert.rejects(
      () => stagePlatformWebhookEventImport("merchant_1", rejected.event.event_id, client),
      /PLATFORM_WEBHOOK_EVENT_NOT_STAGEABLE/
    );
  });
});
