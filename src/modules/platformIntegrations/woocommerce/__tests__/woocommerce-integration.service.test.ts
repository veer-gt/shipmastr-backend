import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  PlatformConnectionStatus,
  PlatformOrderImportStatus,
  PlatformTrackingSyncStatus,
  StorePlatform,
  WooCommerceInstallMode,
  WooCommerceWebhookStatus
} from "@prisma/client";
import { HttpError } from "../../../../lib/httpError.js";
import {
  createWooCommerceConnectionFoundation,
  disableWooCommerceConnection,
  listWooCommerceConnections,
  updateWooCommerceConnectionMetadata
} from "../woocommerce-connection.service.js";
import {
  importWooCommerceOrderWebhookFoundation,
  previewWooCommerceOrderWebhook
} from "../woocommerce-order-ingestion.service.js";
import {
  createWooCommerceTrackingSyncFoundation,
  simulateWooCommerceTrackingSyncFailure,
  simulateWooCommerceTrackingSyncSuccess
} from "../woocommerce-tracking-sync.service.js";
import { validateWooCommerceWebhookFoundation } from "../woocommerce-webhook-validation.js";

const now = new Date("2026-06-08T21:00:00.000Z");

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
    wooStates: [] as any[],
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
    wooCommerceConnectionState: {
      create: async ({ data }: any) => {
        const row = { id: id("woo_state", state.wooStates.length), createdAt: now, updatedAt: now, ...data };
        state.wooStates.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => state.wooStates.find((row) => row.connectionId === where.connectionId) ?? null,
      findMany: async (args: any = {}) => pageRows(state.wooStates.filter((row) => matchesState(row, args.where)), args),
      update: async ({ where, data }: any) => {
        const row = state.wooStates.find((item) => item.connectionId === where.connectionId);
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

const wooCodOrder = {
  id: 2001,
  number: "WC-2001",
  currency: "INR",
  total: "499.50",
  payment_method: "cod",
  payment_method_title: "Cash on delivery",
  date_created: "2026-06-08T10:00:00.000Z",
  status: "processing",
  billing: {
    first_name: "Ravi",
    last_name: "Buyer",
    phone: "9876501234",
    email: "ravi@example.com",
    address_1: "Billing address",
    city: "Mumbai",
    state: "MH",
    postcode: "400001",
    country: "IN"
  },
  shipping: {
    first_name: "Ravi",
    last_name: "Buyer",
    address_1: "Shipping address",
    city: "Mumbai",
    state: "MH",
    postcode: "400001",
    country: "IN"
  },
  line_items: [{ name: "Wallet", sku: "WALLET", quantity: 1, total: "499.50", meta_data: [{ key: "weight", value: "0.2" }] }]
};

const wooPrepaidOrder = {
  id: 2002,
  number: "WC-2002",
  currency: "INR",
  total: "899.00",
  payment_method: "stripe",
  payment_method_title: "Card",
  date_created: "2026-06-08T11:00:00.000Z",
  status: "processing",
  billing: { first_name: "Asha", last_name: "Buyer", phone: "9876500000", email: "asha@example.com", address_1: "Billing lane", city: "Delhi", state: "DL", postcode: "110001", country: "IN" },
  shipping: { first_name: "Asha", last_name: "Buyer", address_1: "Shipping lane", city: "Delhi", state: "DL", postcode: "110001", country: "IN" },
  line_items: [{ name: "Bag", sku: "BAG", quantity: 1, total: "899.00", weight_grams: 450 }]
};

function wooHeaders(body: unknown, secret = "test_woo_secret") {
  const payload = JSON.stringify(body);
  return {
    "X-WC-Webhook-Source": "https://woo.example",
    "X-WC-Webhook-Topic": "order.created",
    "X-WC-Webhook-Resource": "order",
    "X-WC-Webhook-Event": "created",
    "X-WC-Webhook-Signature": createHmac("sha256", secret).update(payload).digest("base64"),
    "X-WC-Webhook-ID": "woo_webhook_1",
    "X-WC-Webhook-Delivery-ID": "woo_delivery_1"
  };
}

describe("Phase 16 WooCommerce native integration foundation", () => {
  it("creates WooCommerce connection metadata and rejects raw consumer key or secret fields", async () => {
    const { client, state } = createFakeClient();

    await assert.rejects(
      () => createWooCommerceConnectionFoundation("merchant_1", {
        storeName: "Demo",
        siteUrl: "https://woo.example",
        consumerSecret: "cs_secret_should_not_store"
      } as any, client),
      (error) => error instanceof HttpError && error.message === "WOOCOMMERCE_RAW_SECRET_REJECTED"
    );

    const connection = await createWooCommerceConnectionFoundation("merchant_1", {
      storeName: "Woo Store",
      siteUrl: "https://woo.example",
      apiVersion: "wc/v3",
      installMode: WooCommerceInstallMode.REST_KEY_PLACEHOLDER,
      credentialsRef: "vault://woocommerce/demo"
    }, client);
    const list = await listWooCommerceConnections("merchant_1", { page: 1, per_page: 20 }, client);
    const json = JSON.stringify({ connection, list });

    assert.equal(connection.platform, StorePlatform.WOOCOMMERCE);
    assert.equal(connection.woocommerce?.site_url, "https://woo.example/");
    assert.equal(connection.credential_status, "configured_placeholder");
    assert.equal(list.connections.length, 1);
    assert.equal(state.connections[0]?.credentialsRef, "vault://woocommerce/demo");
    assert.doesNotMatch(json, /vault:\/\/woocommerce|cs_secret_should_not_store|credentialsRef/i);
  });

  it("validates WooCommerce URL inputs and allows local development URLs", async () => {
    const { client } = createFakeClient();

    await assert.rejects(
      () => createWooCommerceConnectionFoundation("merchant_1", {
        siteUrl: "ftp://woo.example"
      }, client),
      (error) => error instanceof HttpError && error.message === "WOOCOMMERCE_SITE_URL_INVALID"
    );

    const local = await createWooCommerceConnectionFoundation("merchant_1", {
      siteUrl: "http://localhost:8080"
    }, client);
    assert.equal(local.woocommerce?.site_url, "http://localhost:8080/");
  });

  it("updates and disables WooCommerce connection metadata safely", async () => {
    const { client, state } = createFakeClient();
    const connection = await createWooCommerceConnectionFoundation("merchant_1", {
      siteUrl: "https://woo.example"
    }, client);
    const updated = await updateWooCommerceConnectionMetadata("merchant_1", connection.connection_id, {
      storeName: "Updated Woo",
      apiVersion: "wc/v3",
      webhookStatus: WooCommerceWebhookStatus.SIMULATED
    }, client);
    const disabled = await disableWooCommerceConnection("merchant_1", connection.connection_id, client);

    assert.equal(updated.store_name, "Updated Woo");
    assert.equal(updated.woocommerce?.api_version, "wc/v3");
    assert.equal(updated.woocommerce?.webhook_status, WooCommerceWebhookStatus.SIMULATED);
    assert.equal(disabled.status, PlatformConnectionStatus.DISABLED);
    assert.equal(state.wooStates[0]?.webhookStatus, WooCommerceWebhookStatus.DISABLED);
  });

  it("previews WooCommerce COD and prepaid webhook payloads without creating imports or orders", async () => {
    const { client, state } = createFakeClient();
    const connection = await createWooCommerceConnectionFoundation("merchant_1", {
      siteUrl: "https://woo.example"
    }, client);
    const codPreview = await previewWooCommerceOrderWebhook("merchant_1", connection.connection_id, {
      payload: wooCodOrder,
      headers: wooHeaders(wooCodOrder)
    }, client);
    const prepaidPreview = await previewWooCommerceOrderWebhook("merchant_1", connection.connection_id, {
      payload: wooPrepaidOrder
    }, client);
    const json = JSON.stringify({ codPreview, prepaidPreview });

    assert.equal(codPreview.normalized_order.payment_mode, "COD");
    assert.equal(codPreview.normalized_order.cod_amount_paise, 49950);
    assert.equal(prepaidPreview.normalized_order.payment_mode, "PREPAID");
    assert.equal(prepaidPreview.normalized_order.cod_amount_paise, 0);
    assert.equal(codPreview.will_create_shipmastr_order, false);
    assert.equal(codPreview.will_create_shipment, false);
    assert.equal(state.imports.length, 0);
    assert.match(codPreview.normalized_order.buyer.phone || "", /ending 1234/);
    assert.doesNotMatch(json, /9876501234|Shipping address|providerName|courierOverride|credentialsRef/i);
  });

  it("returns WooCommerce warnings for missing shipping data, weights, virtual items, and cancelled orders", async () => {
    const { client } = createFakeClient();
    const connection = await createWooCommerceConnectionFoundation("merchant_1", {
      siteUrl: "https://woo.example"
    }, client);
    const preview = await previewWooCommerceOrderWebhook("merchant_1", connection.connection_id, {
      payload: {
        id: 2003,
        number: "WC-2003",
        total: "100.00",
        status: "refunded",
        created_via: "test-runner",
        billing: { first_name: "Test", last_name: "Buyer", email: "test@example.com" },
        shipping: {},
        line_items: [{ name: "Download", quantity: 1, total: "100.00", virtual: true, requires_shipping: false }]
      }
    }, client);
    const codes = preview.mapping_warnings.map((warning: any) => warning.code);

    assert.ok(codes.includes("MISSING_PHONE"));
    assert.ok(codes.includes("MISSING_POSTAL_CODE"));
    assert.ok(codes.includes("MISSING_SHIPPING_ADDRESS"));
    assert.ok(codes.includes("MISSING_ITEM_WEIGHT"));
    assert.ok(codes.includes("VIRTUAL_NON_SHIPPABLE_ITEM"));
    assert.ok(codes.includes("ORDER_CANCELLED_OR_REFUNDED"));
    assert.ok(codes.includes("WOOCOMMERCE_TEST_OR_DRAFT_ORDER"));
  });

  it("imports WooCommerce webhook payloads into PlatformOrderImport only", async () => {
    const { client, state } = createFakeClient();
    const connection = await createWooCommerceConnectionFoundation("merchant_1", {
      siteUrl: "https://woo.example"
    }, client);
    const imported = await importWooCommerceOrderWebhookFoundation("merchant_1", connection.connection_id, {
      payload: wooCodOrder,
      headers: wooHeaders(wooCodOrder)
    }, client);
    const json = JSON.stringify(imported);

    assert.equal(state.imports.length, 1);
    assert.equal(state.imports[0]?.status, PlatformOrderImportStatus.MAPPED);
    assert.equal(imported.import.external_order_id, "2001");
    assert.equal(imported.order_creation.status, "deferred");
    assert.ok(state.connections[0]?.lastOrderImportAt);
    assert.equal(state.wooStates[0]?.lastOrderWebhookId, "woo_webhook_1");
    assert.doesNotMatch(json, /9876501234|Shipping address|rawPayloadHash|providerName|courierOverride/i);
  });

  it("creates and simulates WooCommerce tracking sync records without external API calls", async () => {
    const { client, state } = createFakeClient();
    state.shipments.push({
      id: "shipment_1",
      sellerId: "merchant_1",
      externalOrderId: "2001",
      awbNumber: "TESTAWB-WOO",
      trackingPublicUrl: "/track/trk_woo",
      trackingUrl: "https://track.example/TESTAWB-WOO"
    });
    const connection = await createWooCommerceConnectionFoundation("merchant_1", {
      siteUrl: "https://woo.example"
    }, client);
    const sync = await createWooCommerceTrackingSyncFoundation("merchant_1", connection.connection_id, {
      shipmentId: "shipment_1",
      trackingProvider: "Shipmastr",
      notifyCustomer: true,
      customerNote: "Tracking will be available on Shipmastr."
    }, client);
    const synced = await simulateWooCommerceTrackingSyncSuccess("merchant_1", sync.sync_id, client);
    const failed = await simulateWooCommerceTrackingSyncFailure("merchant_1", sync.sync_id, "Foundation-only simulation.", client);
    const json = JSON.stringify({ sync, synced, failed });

    assert.equal(sync.status, PlatformTrackingSyncStatus.PENDING);
    assert.equal(sync.tracking_number, "TESTAWB-WOO");
    assert.equal(sync.tracking_provider, "Shipmastr");
    assert.equal(sync.external_delivery, "simulation_only");
    assert.equal(synced.status, PlatformTrackingSyncStatus.SYNCED);
    assert.equal(failed.status, PlatformTrackingSyncStatus.FAILED);
    assert.equal(state.syncs.length, 1);
    assert.ok(state.wooStates[0]?.lastTrackingSyncAttemptAt);
    assert.doesNotMatch(json, /providerName|providerShipmentId|courierOverride|credentialsRef/i);
  });

  it("validates WooCommerce webhook headers without exposing signatures or secrets", () => {
    const missing = validateWooCommerceWebhookFoundation({ headers: {} });
    const body = { id: 2001 };
    const validHeaders = wooHeaders(body);
    const valid = validateWooCommerceWebhookFoundation({
      headers: validHeaders,
      body,
      secret: "test_woo_secret"
    });
    const json = JSON.stringify({ missing, valid });

    assert.equal(missing.status, "INVALID");
    assert.ok(missing.missing_headers.includes("x-wc-webhook-signature"));
    assert.equal(valid.status, "VALID");
    assert.equal(valid.signature_configured, true);
    assert.equal(json.includes("test_woo_secret"), false);
    assert.equal(json.includes(validHeaders["X-WC-Webhook-Signature"]), false);
  });
});
