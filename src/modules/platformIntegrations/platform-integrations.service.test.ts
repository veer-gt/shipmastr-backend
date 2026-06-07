import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlatformConnectionStatus,
  PlatformOrderImportStatus,
  PlatformTrackingSyncStatus,
  StorePlatform
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import {
  createConnection,
  createTrackingSyncFoundation,
  importPlatformOrderFoundation,
  mapPlatformOrder,
  previewPlatformOrderImport,
  simulateTrackingSyncFailure,
  simulateTrackingSyncSuccess
} from "./platform-integrations.service.js";

const now = new Date("2026-06-07T17:00:00.000Z");

function pageRows<T>(rows: T[], args: any = {}) {
  const sorted = args.orderBy?.createdAt === "desc"
    ? [...rows].sort((left: any, right: any) => right.createdAt.getTime() - left.createdAt.getTime())
    : rows;
  return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? sorted.length));
}

function createFakeClient() {
  const state = {
    connections: [] as any[],
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
      findFirst: async ({ where }: any) => state.connections.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null,
      findMany: async (args: any = {}) => pageRows(state.connections.filter((row) => (
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.platform || row.platform === args.where.platform) &&
        (!args.where?.status || row.status === args.where.status)
      )), args),
      count: async ({ where }: any = {}) => state.connections.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.platform || row.platform === where.platform) &&
        (!where?.status || row.status === where.status)
      )).length,
      update: async ({ where, data }: any) => {
        const row = byId(state.connections, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    platformOrderImport: {
      create: async ({ data }: any) => {
        const row = { id: id("platform_import", state.imports.length), createdAt: now, updatedAt: now, normalizedOrderId: null, ...data };
        state.imports.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.imports.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null,
      findMany: async (args: any = {}) => pageRows(state.imports.filter((row) => (
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.platform || row.platform === args.where.platform) &&
        (!args.where?.status || row.status === args.where.status)
      )), args),
      count: async ({ where }: any = {}) => state.imports.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.platform || row.platform === where.platform) &&
        (!where?.status || row.status === where.status)
      )).length
    },
    platformTrackingSync: {
      create: async ({ data }: any) => {
        const row = { id: id("platform_sync", state.syncs.length), createdAt: now, updatedAt: now, lastAttemptAt: null, syncedAt: null, errorMessage: null, ...data };
        state.syncs.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.syncs.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null,
      findMany: async (args: any = {}) => pageRows(state.syncs.filter((row) => (
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.platform || row.platform === args.where.platform) &&
        (!args.where?.status || row.status === args.where.status)
      )), args),
      count: async ({ where }: any = {}) => state.syncs.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
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

const wooCodOrder = {
  id: 2001,
  number: "WC-2001",
  currency: "INR",
  total: "499.50",
  payment_method: "cod",
  payment_method_title: "Cash on delivery",
  date_created: "2026-06-07T11:00:00.000Z",
  billing: { first_name: "Ravi", last_name: "Buyer", phone: "9876501234", email: "ravi@example.com", address_1: "Billing address", city: "Mumbai", state: "MH", postcode: "400001", country: "IN" },
  shipping: { first_name: "Ravi", last_name: "Buyer", address_1: "Shipping address", city: "Mumbai", state: "MH", postcode: "400001", country: "IN" },
  line_items: [{ name: "Wallet", sku: "WALLET", quantity: 1, total: "499.50", meta_data: [{ key: "weight", value: "0.2" }] }]
};

const magentoCodOrder = {
  entity_id: 3001,
  increment_id: "MG-3001",
  customer_email: "buyer@example.com",
  grand_total: 999,
  order_currency_code: "INR",
  payment: { method: "cashondelivery" },
  created_at: "2026-06-07T12:00:00.000Z",
  billing_address: { firstname: "Maya", lastname: "Buyer", telephone: "9876500000", street: ["Billing lane"], city: "Bengaluru", region: "Karnataka", postcode: "560001", country_id: "IN" },
  extension_attributes: {
    shipping_assignments: [{
      shipping: { address: { firstname: "Maya", lastname: "Buyer", telephone: "9876500000", street: ["MG Road"], city: "Bengaluru", region: "Karnataka", postcode: "560001", country_id: "IN" } },
      items: [{ name: "Shoes", sku: "SHOE", qty_ordered: 1, price: 999, weight: 0.7 }]
    }]
  }
};

describe("Phase 14 platform adapter foundation", () => {
  it("maps Shopify, WooCommerce, and Magento COD orders without courier exposure", async () => {
    const shopify = await mapPlatformOrder(StorePlatform.SHOPIFY, shopifyCodOrder);
    const woo = await mapPlatformOrder(StorePlatform.WOOCOMMERCE, wooCodOrder);
    const magento = await mapPlatformOrder(StorePlatform.MAGENTO, magentoCodOrder);
    const json = JSON.stringify({ shopify, woo, magento });

    assert.equal(shopify.paymentMode, "COD");
    assert.equal(shopify.codAmountPaise, 129900);
    assert.equal(shopify.deadWeightGrams, 500);
    assert.equal(woo.paymentMode, "COD");
    assert.equal(woo.codAmountPaise, 49950);
    assert.equal(woo.deadWeightGrams, 200);
    assert.equal(magento.paymentMode, "COD");
    assert.equal(magento.deadWeightGrams, 700);
    assert.doesNotMatch(json, /Bigship|providerName|providerShipmentId|courierOverride/i);
  });

  it("adds warnings for missing platform phone, postal code, and weights", async () => {
    const mapped = await mapPlatformOrder(StorePlatform.SHOPIFY, {
      id: 1002,
      name: "#1002",
      total_price: "100.00",
      shipping_address: { address1: "Short", city: "Delhi", province: "Delhi" },
      line_items: [{ name: "Poster", quantity: 1, price: "100.00", requires_shipping: true }]
    });
    const codes = mapped.mappingWarnings.map((warning) => warning.code);

    assert.ok(codes.includes("MISSING_PHONE"));
    assert.ok(codes.includes("MISSING_POSTAL_CODE"));
    assert.ok(codes.includes("MISSING_ITEM_WEIGHT"));
  });

  it("sanitizes credentials and keeps preview public-safe without creating imports", async () => {
    const { client, state } = createFakeClient();
    const connection = await createConnection("merchant_1", {
      platform: StorePlatform.SHOPIFY,
      storeName: "Demo Store",
      storeUrl: "https://demo-store.example",
      credentialsMeta: {
        accessToken: "shpat_secret_should_not_store",
        installMode: "manual"
      }
    }, client);
    const preview = await previewPlatformOrderImport("merchant_1", connection.connection_id, {
      payload: shopifyCodOrder
    }, client);
    const json = JSON.stringify({ connection, preview });

    assert.equal(state.connections[0]?.credentialsMeta.installMode, "manual");
    assert.equal(state.connections[0]?.credentialsMeta.accessToken, undefined);
    assert.equal(state.imports.length, 0);
    assert.match(preview.normalized_order.buyer.phone || "", /ending 3210/);
    assert.doesNotMatch(json, /shpat_secret_should_not_store|9876543210|221 Market Street|credentialsRef|credential.*secret|Bigship/i);
  });

  it("records mapped platform imports and rejects unsupported platform mapping", async () => {
    const { client, state } = createFakeClient();
    const connection = await createConnection("merchant_1", {
      platform: StorePlatform.WOOCOMMERCE,
      storeUrl: "https://woo.example"
    }, client);
    const imported = await importPlatformOrderFoundation("merchant_1", connection.connection_id, {
      payload: wooCodOrder
    }, client);
    const customConnection = await createConnection("merchant_1", {
      platform: StorePlatform.CUSTOM,
      storeUrl: "https://custom.example"
    }, client);

    assert.equal(state.imports.length, 1);
    assert.equal(state.imports[0]?.status, PlatformOrderImportStatus.MAPPED);
    assert.equal(imported.import.external_order_id, "2001");
    assert.equal(state.connections[0]?.lastOrderImportAt instanceof Date, true);
    await assert.rejects(
      () => previewPlatformOrderImport("merchant_1", customConnection.connection_id, { payload: { id: "x" } }, client),
      (error) => error instanceof HttpError && error.message === "PLATFORM_ORDER_MAPPING_UNSUPPORTED"
    );
  });

  it("rejects unsafe store URLs and simulates tracking sync without external calls", async () => {
    const { client, state } = createFakeClient();
    state.shipments.push({
      id: "shipment_1",
      sellerId: "merchant_1",
      externalOrderId: "ORDER-1",
      awbNumber: "TESTAWB-1",
      trackingPublicUrl: "/track/trk_test",
      trackingUrl: "https://track.example/TESTAWB-1"
    });

    await assert.rejects(
      () => createConnection("merchant_1", {
        platform: StorePlatform.SHOPIFY,
        storeUrl: "ftp://unsafe.example"
      }, client),
      (error) => error instanceof HttpError && error.message === "PLATFORM_STORE_URL_INVALID"
    );

    const connection = await createConnection("merchant_1", {
      platform: StorePlatform.MAGENTO,
      storeUrl: "https://magento.example"
    }, client);
    const sync = await createTrackingSyncFoundation("merchant_1", connection.connection_id, {
      shipmentId: "shipment_1"
    }, client);
    const synced = await simulateTrackingSyncSuccess("merchant_1", sync.sync_id, client);
    const failed = await simulateTrackingSyncFailure("merchant_1", sync.sync_id, "Foundation simulation failed.", client);

    assert.equal(sync.status, PlatformTrackingSyncStatus.PENDING);
    assert.equal(sync.tracking_number, "TESTAWB-1");
    assert.equal(synced.status, PlatformTrackingSyncStatus.SYNCED);
    assert.equal(failed.status, PlatformTrackingSyncStatus.FAILED);
    assert.equal(state.syncs.length, 1);
    assert.ok(state.connections[0]?.lastTrackingSyncAt);
  });
});
