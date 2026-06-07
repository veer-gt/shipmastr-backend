import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  OrderStatus,
  PaymentMode,
  SellerApiKeyStatus,
  ShipmentStatus,
  WebhookEventOutboxStatus,
  WebhookSubscriptionStatus
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import {
  assertSellerApiScopes,
  authenticateSellerApiKey,
  createSellerApiKey,
  listSellerApiKeys,
  revokeSellerApiKey
} from "./shipping-api-keys.service.js";
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
  updateWebhookSubscription
} from "./shipping-webhooks.service.js";
import {
  enqueueWebhookEvent,
  listWebhookEvents,
  simulateWebhookDelivered,
  simulateWebhookFailed
} from "./shipping-webhook-events.service.js";
import { redactSellerApiPayload } from "./shipping-api-serializers.js";
import { getMerchantOperationsSummary } from "./shipping-merchant-operations.service.js";

const now = new Date("2026-06-07T15:00:00.000Z");

function createFakeClient() {
  const state = {
    apiKeys: [] as any[],
    subscriptions: [] as any[],
    outbox: [] as any[],
    orders: [] as any[],
    shipments: [] as any[],
    ndrCases: [] as any[],
    rtoCases: [] as any[],
    codLedgerEntries: [] as any[],
    weightCases: [] as any[],
    autopilotPreferences: [] as any[]
  };
  const id = (prefix: string, count: number) => `${prefix}_${count + 1}`;
  const byId = <T extends { id: string }>(rows: T[], rowId: string) => rows.find((row) => row.id === rowId);
  const statusMatches = (rowStatus: string, whereStatus: any) => whereStatus === undefined || rowStatus === whereStatus;
  const pageRows = <T>(rows: T[], args: any = {}) => {
    const sorted = args.orderBy?.createdAt === "desc"
      ? [...rows].sort((left: any, right: any) => right.createdAt.getTime() - left.createdAt.getTime())
      : rows;
    return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? sorted.length));
  };

  const client = {
    sellerApiKey: {
      create: async ({ data }: any) => {
        const row = { id: id("api_key", state.apiKeys.length), createdAt: now, updatedAt: now, lastUsedAt: null, revokedAt: null, ...data };
        state.apiKeys.push(row);
        return row;
      },
      findMany: async ({ where, orderBy }: any) => pageRows(state.apiKeys.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        statusMatches(row.status, where?.status)
      )), { orderBy }),
      findFirst: async ({ where }: any) => state.apiKeys.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null,
      findUnique: async ({ where }: any) => state.apiKeys.find((row) => (
        (where.id && row.id === where.id) ||
        (where.keyHash && row.keyHash === where.keyHash)
      )) ?? null,
      update: async ({ where, data }: any) => {
        const row = byId(state.apiKeys, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    webhookSubscription: {
      create: async ({ data }: any) => {
        const row = { id: id("webhook", state.subscriptions.length), createdAt: now, updatedAt: now, failureCount: 0, lastDeliveredAt: null, lastFailedAt: null, disabledAt: null, ...data };
        state.subscriptions.push(row);
        return row;
      },
      findMany: async ({ where, orderBy }: any = {}) => pageRows(state.subscriptions.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        statusMatches(row.status, where?.status)
      )), { orderBy }),
      findFirst: async ({ where }: any) => state.subscriptions.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null,
      update: async ({ where, data }: any) => {
        const row = byId(state.subscriptions, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    webhookEventOutbox: {
      create: async ({ data }: any) => {
        const row = { id: id("outbox", state.outbox.length), createdAt: now, updatedAt: now, attemptCount: 0, deliveredAt: null, failedAt: null, ...data };
        state.outbox.push(row);
        return row;
      },
      findMany: async (args: any = {}) => pageRows(state.outbox.filter((row) => (
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.eventType || row.eventType === args.where.eventType) &&
        statusMatches(row.status, args.where?.status)
      )), args),
      count: async ({ where }: any = {}) => state.outbox.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.eventType || row.eventType === where.eventType) &&
        statusMatches(row.status, where?.status)
      )).length,
      findFirst: async ({ where }: any) => state.outbox.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null,
      update: async ({ where, data }: any) => {
        const row = byId(state.outbox, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    order: {
      findMany: async ({ where }: any) => state.orders.filter((row) => !where?.merchantId || row.merchantId === where.merchantId)
    },
    shipment: {
      findMany: async ({ where }: any) => state.shipments.filter((row) => !where?.sellerId || row.sellerId === where.sellerId)
    },
    ndrCase: {
      findMany: async ({ where }: any) => state.ndrCases.filter((row) => !where?.merchantId || row.merchantId === where.merchantId)
    },
    rtoCase: {
      findMany: async ({ where }: any) => state.rtoCases.filter((row) => !where?.merchantId || row.merchantId === where.merchantId)
    },
    codLedgerEntry: {
      findMany: async ({ where }: any) => state.codLedgerEntries.filter((row) => !where?.merchantId || row.merchantId === where.merchantId)
    },
    weightDiscrepancyCase: {
      findMany: async ({ where }: any) => state.weightCases.filter((row) => !where?.merchantId || row.merchantId === where.merchantId)
    },
    autopilotPreference: {
      findUnique: async ({ where }: any) => state.autopilotPreferences.find((row) => row.merchantId === where.merchantId) ?? null
    }
  };

  return { client: client as any, state };
}

describe("Phase 12 seller API and webhook foundation", () => {
  it("creates API keys once, stores only hashes, enforces scopes, and blocks revoked keys", async () => {
    const { client, state } = createFakeClient();

    const created = await createSellerApiKey("seller_1", {
      name: "Storefront API",
      scopes: ["orders:write", "orders:read"]
    }, client);
    const rawKey = created.api_key!;
    const authenticated = await authenticateSellerApiKey(rawKey, client);
    const listed = await listSellerApiKeys("seller_1", client);
    const json = JSON.stringify(listed);

    assert.match(rawKey, /^sk_shipmastr_test_/);
    assert.equal(state.apiKeys.length, 1);
    assert.notEqual(state.apiKeys[0]?.keyHash, rawKey);
    assert.equal(state.apiKeys[0]?.keyPrefix, created.key_prefix);
    assert.equal(authenticated?.merchantId, "seller_1");
    assert.ok(state.apiKeys[0]?.lastUsedAt);
    assert.doesNotMatch(json, /keyHash/);
    assert.doesNotMatch(json, new RegExp(rawKey));
    assert.doesNotThrow(() => assertSellerApiScopes(authenticated!, ["orders:write"]));
    assert.throws(
      () => assertSellerApiScopes(authenticated!, ["shipments:write"]),
      (error) => error instanceof HttpError && error.message === "SELLER_API_SCOPE_MISSING"
    );

    await revokeSellerApiKey("seller_1", created.api_key_id, client);
    assert.equal(await authenticateSellerApiKey(rawKey, client), null);
    assert.equal(state.apiKeys[0]?.status, SellerApiKeyStatus.REVOKED);
  });

  it("validates webhook subscriptions and only reveals the secret at creation", async () => {
    const { client } = createFakeClient();

    const created = await createWebhookSubscription("seller_1", {
      url: "https://seller.example/webhooks/shipmastr",
      description: "Primary integration",
      events: ["order.created", "shipment.shipped"]
    }, client);
    const listed = await listWebhookSubscriptions("seller_1", client);
    const disabled = await updateWebhookSubscription("seller_1", created.subscription_id, {
      status: WebhookSubscriptionStatus.DISABLED
    }, client);
    const json = JSON.stringify({ listed, disabled });

    assert.match(created.webhook_secret!, /^whsec_shipmastr_test_/);
    assert.equal(listed.webhooks.length, 1);
    assert.equal(disabled.status, "DISABLED");
    assert.doesNotMatch(json, /secretHash|webhook_secret|whsec_shipmastr_test_/);
    await assert.rejects(
      () => createWebhookSubscription("seller_1", {
        url: "https://seller.example/webhooks/shipmastr",
        events: ["provider.internal"]
      }, client),
      (error) => error instanceof HttpError && error.message === "WEBHOOK_EVENT_UNSUPPORTED"
    );
    await assert.rejects(
      () => createWebhookSubscription("seller_1", {
        url: "http://seller.example/webhooks/shipmastr",
        events: ["order.created"]
      }, client),
      (error) => error instanceof HttpError && error.message === "WEBHOOK_URL_HTTPS_REQUIRED"
    );
  });

  it("enqueues public-safe webhook events and simulates delivery without external calls", async () => {
    const { client, state } = createFakeClient();
    await createWebhookSubscription("seller_1", {
      url: "https://seller.example/webhooks/shipmastr",
      events: ["order.created"]
    }, client);

    const queued = await enqueueWebhookEvent("seller_1", "order.created", {
      order_id: "order_1",
      buyer: {
        phone: "9876543210",
        address: { line1: "221 Market Street", city: "Delhi" }
      },
      providerResponseJson: { unsafe: true },
      courierOverride: "internal_courier"
    }, client);
    const skipped = await enqueueWebhookEvent("seller_1", "shipment.shipped", {
      shipment_id: "shipment_1"
    }, client);
    const delivered = await simulateWebhookDelivered("seller_1", queued.events[0]!.event_id, client);
    const failed = await simulateWebhookFailed("seller_1", skipped.events[0]!.event_id, client);
    const listed = await listWebhookEvents("seller_1", {}, client);
    const json = JSON.stringify({ queued, skipped, delivered, failed, listed });

    assert.equal(state.outbox.length, 2);
    assert.equal(queued.events[0]?.status, WebhookEventOutboxStatus.PENDING);
    assert.equal(skipped.events[0]?.status, WebhookEventOutboxStatus.SKIPPED);
    assert.equal(delivered.status, WebhookEventOutboxStatus.DELIVERED);
    assert.equal(failed.status, WebhookEventOutboxStatus.FAILED);
    assert.match(json, /ending 3210/);
    assert.doesNotMatch(json, /9876543210|221 Market Street|providerResponseJson|courierOverride|internal_courier|Bigship|bigship/i);
  });

  it("summarizes merchant operations from Phase 5 through Phase 11 records", async () => {
    const { client, state } = createFakeClient();
    state.orders.push(
      { merchantId: "seller_1", status: OrderStatus.READY_TO_SHIP, paymentMode: PaymentMode.COD },
      { merchantId: "seller_1", status: OrderStatus.NEEDS_ATTENTION, paymentMode: PaymentMode.PREPAID },
      { merchantId: "seller_2", status: OrderStatus.READY_TO_SHIP, paymentMode: PaymentMode.COD }
    );
    state.shipments.push(
      { sellerId: "seller_1", status: ShipmentStatus.in_transit },
      { sellerId: "seller_1", status: ShipmentStatus.delivered },
      { sellerId: "seller_1", status: ShipmentStatus.delivery_failed },
      { sellerId: "seller_1", status: ShipmentStatus.rto_initiated }
    );
    state.ndrCases.push({ merchantId: "seller_1", status: "open" }, { merchantId: "seller_1", status: "resolved" });
    state.rtoCases.push({ merchantId: "seller_1", status: "initiated", estimatedLossPaise: 1000 }, { merchantId: "seller_1", status: "closed", estimatedLossPaise: 2000 });
    state.codLedgerEntries.push(
      { merchantId: "seller_1", entryType: "expected_collection", amountPaise: 5000 },
      { merchantId: "seller_1", entryType: "collected", amountPaise: 4000 },
      { merchantId: "seller_1", entryType: "remittance_due", amountPaise: 3000 },
      { merchantId: "seller_1", entryType: "remitted", amountPaise: 2000 }
    );
    state.weightCases.push({ merchantId: "seller_1", status: "detected" }, { merchantId: "seller_1", status: "submitted" }, { merchantId: "seller_1", status: "closed" });
    state.autopilotPreferences.push({ merchantId: "seller_1", isEnabled: true });

    const summary = await getMerchantOperationsSummary("seller_1", client);

    assert.equal(summary.orders.total, 2);
    assert.equal(summary.orders.ready_to_ship, 1);
    assert.equal(summary.shipments.in_transit, 1);
    assert.equal(summary.shipments.delivered, 1);
    assert.equal(summary.shipments.failed, 1);
    assert.equal(summary.shipments.rto, 1);
    assert.equal(summary.ndr.open, 1);
    assert.equal(summary.rto.estimated_loss_paise, 3000);
    assert.equal(summary.cod.expected_collection_paise, 5000);
    assert.equal(summary.weight_disputes.open, 1);
    assert.equal(summary.autopilot.enabled, true);
  });

  it("redacts seller API payloads and mounts routes additively", () => {
    const routes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");
    const index = readFileSync("src/routes/index.ts", "utf8");
    const redacted = redactSellerApiPayload({
      buyer: {
        phone: "9876543210",
        address: { line1: "Unsafe full address", city: "Delhi" }
      },
      keyHash: "secret_hash",
      providerErrorJson: { detail: "raw" },
      internalNotes: "do not show"
    });
    const json = JSON.stringify(redacted);

    assert.match(index, /apiRouter\.use\("\/shipping\/seller-api", shippingSellerApiRouter\);/);
    assert.match(index, /apiRouter\.use\("\/shipping", requireJwtAuth, shippingNetworkRouter\);/);
    assert.match(routes, /shippingNetworkRouter\.post\("\/api-keys"/);
    assert.match(routes, /shippingNetworkRouter\.post\("\/webhooks"/);
    assert.match(routes, /shippingNetworkRouter\.get\("\/webhook-events"/);
    assert.match(routes, /shippingNetworkRouter\.get\("\/merchant-operations\/summary"/);
    assert.match(routes, /shippingSellerApiRouter\.post\("\/orders"/);
    assert.match(routes, /shippingSellerApiRouter\.post\("\/shipments\/:shipmentId\/ship-now"/);
    assert.doesNotMatch(json, /9876543210|Unsafe full address|keyHash|secret_hash|providerErrorJson|internalNotes/i);
    assert.match(json, /ending 3210/);
  });
});
