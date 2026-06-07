import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  PlatformConnectionStatus,
  PlatformOrderImportStatus,
  PlatformTrackingSyncStatus,
  ShopifyInstallMode,
  ShopifyWebhookStatus,
  StorePlatform
} from "@prisma/client";
import { HttpError } from "../../../../lib/httpError.js";
import {
  createShopifyConnectionFoundation,
  disableShopifyConnection,
  listShopifyConnections,
  updateShopifyConnectionMetadata
} from "../shopify-connection.service.js";
import {
  createShopifyFulfillmentSyncFoundation,
  simulateShopifyFulfillmentSyncFailure,
  simulateShopifyFulfillmentSyncSuccess
} from "../shopify-fulfillment-sync.service.js";
import {
  importShopifyOrderWebhookFoundation,
  previewShopifyOrderWebhook
} from "../shopify-order-ingestion.service.js";
import { validateShopifyWebhookFoundation } from "../shopify-webhook-validation.js";

const now = new Date("2026-06-07T19:00:00.000Z");

function pageRows<T>(rows: T[], args: any = {}) {
  const sorted = args.orderBy?.createdAt === "desc"
    ? [...rows].sort((left: any, right: any) => right.createdAt.getTime() - left.createdAt.getTime())
    : rows;
  return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? sorted.length));
}

function matchesConnection(row: any, where: any = {}) {
  return (!where.id || row.id === where.id) &&
    (!where.merchantId || row.merchantId === where.merchantId) &&
    (!where.platform || row.platform === where.platform) &&
    (!where.status || row.status === where.status);
}

function matchesState(row: any, where: any = {}) {
  const connectionId = where.connectionId;
  if (connectionId?.in) return connectionId.in.includes(row.connectionId);
  return !connectionId || row.connectionId === connectionId;
}

function createFakeClient() {
  const state = {
    connections: [] as any[],
    shopifyStates: [] as any[],
    imports: [] as any[],
    syncs: [] as any[],
    shipments: [] as any[]
  };
  const id = (prefix: string, count: number) => `${prefix}_${count + 1}`;
  const byId = <T extends { id: string }>(rows: T[], rowId: string) => rows.find((row) => row.id === rowId);

  const client = {
    platformConnection: {
      create: async ({ data }: any) => {
        const row = {
          id: id("platform_connection", state.connections.length),
          createdAt: now,
          updatedAt: now,
          lastOrderImportAt: null,
          lastTrackingSyncAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          disabledAt: null,
          ...data
        };
        state.connections.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.connections.find((row) => matchesConnection(row, where)) ?? null,
      findMany: async (args: any = {}) => pageRows(state.connections.filter((row) => matchesConnection(row, args.where)), args),
      count: async ({ where }: any = {}) => state.connections.filter((row) => matchesConnection(row, where)).length,
      update: async ({ where, data }: any) => {
        const row = byId(state.connections, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    shopifyConnectionState: {
      create: async ({ data }: any) => {
        const row = { id: id("shopify_state", state.shopifyStates.length), createdAt: now, updatedAt: now, ...data };
        state.shopifyStates.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => state.shopifyStates.find((row) => row.connectionId === where.connectionId) ?? null,
      findFirst: async ({ where }: any) => state.shopifyStates.find((row) => matchesState(row, where)) ?? null,
      findMany: async (args: any = {}) => pageRows(state.shopifyStates.filter((row) => matchesState(row, args.where)), args),
      update: async ({ where, data }: any) => {
        const row = state.shopifyStates.find((item) => item.connectionId === where.connectionId);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    platformOrderImport: {
      create: async ({ data }: any) => {
        const row = {
          id: id("platform_import", state.imports.length),
          createdAt: now,
          updatedAt: now,
          normalizedOrderId: null,
          ...data
        };
        state.imports.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.imports.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.platform || row.platform === where.platform)
      )) ?? null,
      findMany: async (args: any = {}) => pageRows(state.imports.filter((row) => (
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.connectionId || row.connectionId === args.where.connectionId) &&
        (!args.where?.platform || row.platform === args.where.platform) &&
        (!args.where?.status || row.status === args.where.status)
      )), args),
      count: async ({ where }: any = {}) => state.imports.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.connectionId || row.connectionId === where.connectionId) &&
        (!where?.platform || row.platform === where.platform) &&
        (!where?.status || row.status === where.status)
      )).length
    },
    platformTrackingSync: {
      create: async ({ data }: any) => {
        const row = {
          id: id("platform_sync", state.syncs.length),
          createdAt: now,
          updatedAt: now,
          lastAttemptAt: null,
          syncedAt: null,
          errorMessage: null,
          ...data
        };
        state.syncs.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.syncs.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.platform || row.platform === where.platform)
      )) ?? null,
      findMany: async (args: any = {}) => pageRows(state.syncs.filter((row) => (
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.connectionId || row.connectionId === args.where.connectionId) &&
        (!args.where?.platform || row.platform === args.where.platform) &&
        (!args.where?.status || row.status === args.where.status)
      )), args),
      count: async ({ where }: any = {}) => state.syncs.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.connectionId || row.connectionId === where.connectionId) &&
        (!where?.platform || row.platform === where.platform) &&
        (!where?.status || row.status === where.status)
      )).length,
      update: async ({ where, data }: any) => {
        const row = byId(state.syncs, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    shipment: {
      findFirst: async ({ where }: any) => state.shipments.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.sellerId || row.sellerId === where.sellerId)
      )) ?? null
    }
  };

  return { client: client as any, state };
}

const shopifyCodOrder = {
  id: 1001,
  name: "#1001",
  email: "buyer@example.com",
  created_at: "2026-06-07T10:00:00.000Z",
  total_price: "1299.00",
  currency: "INR",
  financial_status: "pending",
  payment_gateway_names: ["Cash on Delivery"],
  tags: "COD, repeat",
  shipping_address: {
    name: "Asha Buyer",
    phone: "9876543210",
    address1: "221 Market Street",
    city: "Delhi",
    province: "Delhi",
    zip: "110001",
    country_code: "IN"
  },
  line_items: [{ name: "Kurta", sku: "SKU-1", quantity: 2, price: "649.50", grams: 250, requires_shipping: true }]
};

const shopifyPrepaidOrder = {
  id: 1002,
  name: "#1002",
  email: "prepaid@example.com",
  created_at: "2026-06-07T11:00:00.000Z",
  total_price: "799.00",
  currency: "INR",
  financial_status: "paid",
  payment_gateway_names: ["card"],
  shipping_address: {
    name: "Prepaid Buyer",
    phone: "9876501234",
    address1: "15 Garden Road",
    city: "Mumbai",
    province: "Maharashtra",
    zip: "400001",
    country_code: "IN"
  },
  line_items: [{ name: "Wallet", sku: "WALLET", quantity: 1, price: "799.00", grams: 300, requires_shipping: true }]
};

function shopifyHeaders(body: unknown, secret = "test_webhook_secret") {
  const payload = JSON.stringify(body);
  return {
    "X-Shopify-Hmac-Sha256": createHmac("sha256", secret).update(payload).digest("base64"),
    "X-Shopify-Topic": "orders/create",
    "X-Shopify-Shop-Domain": "demo-store.myshopify.com",
    "X-Shopify-Webhook-Id": "webhook_1",
    "X-Shopify-Triggered-At": "2026-06-07T19:00:00.000Z"
  };
}

describe("Phase 15 Shopify native integration foundation", () => {
  it("creates Shopify connection metadata and rejects raw token-like fields", async () => {
    const { client, state } = createFakeClient();

    await assert.rejects(
      () => createShopifyConnectionFoundation("merchant_1", {
        storeName: "Demo",
        shopDomain: "demo-store.myshopify.com",
        storeUrl: "https://demo-store.myshopify.com",
        shopifyAccessToken: "shpat_secret_should_not_store"
      } as any, client),
      (error) => error instanceof HttpError && error.message === "SHOPIFY_RAW_TOKEN_REJECTED"
    );

    const connection = await createShopifyConnectionFoundation("merchant_1", {
      storeName: "Demo Store",
      shopDomain: "https://demo-store.myshopify.com/admin",
      storeUrl: "https://demo-store.myshopify.com",
      apiVersion: "2025-10",
      installMode: ShopifyInstallMode.CUSTOM_APP,
      credentialsRef: "vault://shopify/demo"
    }, client);
    const list = await listShopifyConnections("merchant_1", { page: 1, per_page: 20 }, client);
    const json = JSON.stringify({ connection, list });

    assert.equal(connection.platform, StorePlatform.SHOPIFY);
    assert.equal(connection.shopify?.shop_domain, "demo-store.myshopify.com");
    assert.equal(connection.credential_status, "configured_placeholder");
    assert.equal(list.connections.length, 1);
    assert.equal(state.connections[0]?.credentialsRef, "vault://shopify/demo");
    assert.doesNotMatch(json, /vault:\/\/shopify|shpat_secret_should_not_store|credentialsRef/i);
  });

  it("validates Shopify domain and URL inputs", async () => {
    const { client } = createFakeClient();

    await assert.rejects(
      () => createShopifyConnectionFoundation("merchant_1", {
        shopDomain: "localhost",
        storeUrl: "https://localhost"
      }, client),
      (error) => error instanceof HttpError && error.message === "SHOPIFY_SHOP_DOMAIN_INVALID"
    );
    await assert.rejects(
      () => createShopifyConnectionFoundation("merchant_1", {
        shopDomain: "demo-store.myshopify.com",
        storeUrl: "http://demo-store.myshopify.com"
      }, client),
      (error) => error instanceof HttpError && error.message === "SHOPIFY_STORE_URL_INVALID"
    );
  });

  it("updates and disables Shopify connection metadata without exposing credentials", async () => {
    const { client, state } = createFakeClient();
    const connection = await createShopifyConnectionFoundation("merchant_1", {
      shopDomain: "demo-store.myshopify.com",
      storeUrl: "https://demo-store.myshopify.com"
    }, client);
    const updated = await updateShopifyConnectionMetadata("merchant_1", connection.connection_id, {
      storeName: "Updated Demo",
      apiVersion: "2026-01",
      webhookStatus: ShopifyWebhookStatus.SIMULATED
    }, client);
    const disabled = await disableShopifyConnection("merchant_1", connection.connection_id, client);

    assert.equal(updated.store_name, "Updated Demo");
    assert.equal(updated.shopify?.api_version, "2026-01");
    assert.equal(updated.shopify?.webhook_status, ShopifyWebhookStatus.SIMULATED);
    assert.equal(disabled.status, PlatformConnectionStatus.DISABLED);
    assert.equal(state.shopifyStates[0]?.webhookStatus, ShopifyWebhookStatus.DISABLED);
  });

  it("previews Shopify COD and prepaid webhook payloads without creating imports or orders", async () => {
    const { client, state } = createFakeClient();
    const connection = await createShopifyConnectionFoundation("merchant_1", {
      shopDomain: "demo-store.myshopify.com",
      storeUrl: "https://demo-store.myshopify.com"
    }, client);
    const codPreview = await previewShopifyOrderWebhook("merchant_1", connection.connection_id, {
      payload: shopifyCodOrder,
      headers: shopifyHeaders(shopifyCodOrder)
    }, client);
    const prepaidPreview = await previewShopifyOrderWebhook("merchant_1", connection.connection_id, {
      payload: shopifyPrepaidOrder
    }, client);
    const json = JSON.stringify({ codPreview, prepaidPreview });

    assert.equal(codPreview.normalized_order.payment_mode, "COD");
    assert.equal(codPreview.normalized_order.cod_amount_paise, 129900);
    assert.equal(prepaidPreview.normalized_order.payment_mode, "PREPAID");
    assert.equal(prepaidPreview.normalized_order.cod_amount_paise, 0);
    assert.equal(codPreview.will_create_shipmastr_order, false);
    assert.equal(codPreview.will_create_shipment, false);
    assert.equal(state.imports.length, 0);
    assert.match(codPreview.normalized_order.buyer.phone || "", /ending 3210/);
    assert.doesNotMatch(json, /9876543210|221 Market Street|providerName|courierOverride|credentialsRef/i);
  });

  it("returns seller-friendly Shopify warnings for missing and already-handled orders", async () => {
    const { client } = createFakeClient();
    const connection = await createShopifyConnectionFoundation("merchant_1", {
      shopDomain: "demo-store.myshopify.com",
      storeUrl: "https://demo-store.myshopify.com"
    }, client);
    const preview = await previewShopifyOrderWebhook("merchant_1", connection.connection_id, {
      payload: {
        id: 1003,
        name: "#1003",
        total_price: "100.00",
        cancelled_at: "2026-06-07T12:00:00.000Z",
        fulfillment_status: "partial",
        test: true,
        shipping_address: { address1: "Short", city: "Delhi", province: "Delhi" },
        line_items: [{ name: "Poster", quantity: 1, price: "100.00", requires_shipping: true }]
      }
    }, client);
    const codes = preview.mapping_warnings.map((warning: any) => warning.code);

    assert.ok(codes.includes("MISSING_PHONE"));
    assert.ok(codes.includes("MISSING_POSTAL_CODE"));
    assert.ok(codes.includes("MISSING_ITEM_WEIGHT"));
    assert.ok(codes.includes("ORDER_CANCELLED"));
    assert.ok(codes.includes("ORDER_PARTIALLY_FULFILLED"));
    assert.ok(codes.includes("SHOPIFY_TEST_ORDER"));
  });

  it("imports Shopify webhook payloads into PlatformOrderImport only", async () => {
    const { client, state } = createFakeClient();
    const connection = await createShopifyConnectionFoundation("merchant_1", {
      shopDomain: "demo-store.myshopify.com",
      storeUrl: "https://demo-store.myshopify.com"
    }, client);
    const imported = await importShopifyOrderWebhookFoundation("merchant_1", connection.connection_id, {
      payload: shopifyCodOrder,
      headers: shopifyHeaders(shopifyCodOrder)
    }, client);
    const json = JSON.stringify(imported);

    assert.equal(state.imports.length, 1);
    assert.equal(state.imports[0]?.status, PlatformOrderImportStatus.MAPPED);
    assert.equal(imported.import.external_order_id, "1001");
    assert.equal(imported.order_creation.status, "deferred");
    assert.ok(state.connections[0]?.lastOrderImportAt);
    assert.equal(state.shopifyStates[0]?.lastOrderWebhookId, "webhook_1");
    assert.doesNotMatch(json, /9876543210|221 Market Street|rawPayloadHash|providerName|courierOverride/i);
  });

  it("creates and simulates Shopify fulfillment sync records without external API calls", async () => {
    const { client, state } = createFakeClient();
    state.shipments.push({
      id: "shipment_1",
      sellerId: "merchant_1",
      externalOrderId: "1001",
      awbNumber: "TESTAWB-1",
      trackingPublicUrl: "/track/trk_shopify",
      trackingUrl: "https://track.example/TESTAWB-1"
    });
    const connection = await createShopifyConnectionFoundation("merchant_1", {
      shopDomain: "demo-store.myshopify.com",
      storeUrl: "https://demo-store.myshopify.com"
    }, client);
    const sync = await createShopifyFulfillmentSyncFoundation("merchant_1", connection.connection_id, {
      shipmentId: "shipment_1",
      trackingCompany: "Shipmastr",
      notifyCustomer: true
    }, client);
    const synced = await simulateShopifyFulfillmentSyncSuccess("merchant_1", sync.sync_id, client);
    const failed = await simulateShopifyFulfillmentSyncFailure("merchant_1", sync.sync_id, "Foundation-only simulation.", client);
    const json = JSON.stringify({ sync, synced, failed });

    assert.equal(sync.status, PlatformTrackingSyncStatus.PENDING);
    assert.equal(sync.tracking_number, "TESTAWB-1");
    assert.equal(sync.tracking_company, "Shipmastr");
    assert.equal(sync.external_delivery, "simulation_only");
    assert.equal(synced.status, PlatformTrackingSyncStatus.SYNCED);
    assert.equal(failed.status, PlatformTrackingSyncStatus.FAILED);
    assert.equal(state.syncs.length, 1);
    assert.ok(state.shopifyStates[0]?.lastFulfillmentSyncAttemptAt);
    assert.doesNotMatch(json, /providerName|providerShipmentId|courierOverride|credentialsRef/i);
  });

  it("validates Shopify webhook headers without exposing HMAC or secrets", () => {
    const missing = validateShopifyWebhookFoundation({ headers: {} });
    const body = { id: 1001 };
    const validHeaders = shopifyHeaders(body);
    const valid = validateShopifyWebhookFoundation({
      headers: validHeaders,
      body,
      secret: "test_webhook_secret"
    });
    const json = JSON.stringify({ missing, valid });

    assert.equal(missing.status, "INVALID");
    assert.ok(missing.missing_headers.includes("x-shopify-hmac-sha256"));
    assert.equal(valid.status, "VALID");
    assert.equal(valid.hmac_configured, true);
    assert.equal(json.includes("test_webhook_secret"), false);
    assert.equal(json.includes(validHeaders["X-Shopify-Hmac-Sha256"]), false);
  });
});
