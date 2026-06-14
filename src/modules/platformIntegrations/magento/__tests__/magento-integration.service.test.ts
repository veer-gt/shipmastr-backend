import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  MagentoInstallMode,
  MagentoWebhookStatus,
  PlatformConnectionStatus,
  PlatformOrderImportStatus,
  PlatformTrackingSyncStatus,
  StorePlatform
} from "@prisma/client";
import { HttpError } from "../../../../lib/httpError.js";
import {
  createMagentoConnectionFoundation,
  disableMagentoConnection,
  listMagentoConnections,
  updateMagentoConnectionMetadata
} from "../magento-connection.service.js";
import {
  importMagentoOrderWebhookFoundation,
  previewMagentoOrderWebhook
} from "../magento-order-ingestion.service.js";
import {
  createMagentoShippingSyncFoundation,
  simulateMagentoShippingSyncFailure,
  simulateMagentoShippingSyncSuccess
} from "../magento-shipping-sync.service.js";
import { validateMagentoWebhookFoundation } from "../magento-webhook-validation.js";

const now = new Date("2026-06-08T23:00:00.000Z");

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
    magentoStates: [] as any[],
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
    magentoConnectionState: {
      create: async ({ data }: any) => {
        const row = { id: id("magento_state", state.magentoStates.length), createdAt: now, updatedAt: now, ...data };
        state.magentoStates.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => state.magentoStates.find((row) => row.connectionId === where.connectionId) ?? null,
      findMany: async (args: any = {}) => pageRows(state.magentoStates.filter((row) => matchesState(row, args.where)), args),
      update: async ({ where, data }: any) => {
        const row = state.magentoStates.find((item) => item.connectionId === where.connectionId);
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

const magentoCodOrder = {
  entity_id: 3001,
  increment_id: "000300001",
  customer_email: "buyer@example.com",
  created_at: "2026-06-08T10:00:00.000Z",
  grand_total: "1299.00",
  order_currency_code: "INR",
  status: "processing",
  store_name: "Default Store",
  store_code: "default",
  payment: { method: "cashondelivery" },
  billing_address: {
    firstname: "Ravi",
    lastname: "Buyer",
    telephone: "9876501234",
    email: "buyer@example.com",
    street: ["Billing address"],
    city: "Mumbai",
    region: "Maharashtra",
    postcode: "400001",
    country_id: "IN"
  },
  extension_attributes: {
    shipping_assignments: [{
      shipping: {
        address: {
          firstname: "Ravi",
          lastname: "Buyer",
          telephone: "9876501234",
          street: ["Shipping address"],
          city: "Mumbai",
          region: "Maharashtra",
          postcode: "400001",
          country_id: "IN"
        }
      },
      items: [{ name: "Wallet", sku: "WALLET", qty_ordered: 1, price: "1299.00", weight: 0.7, product_type: "simple" }]
    }]
  },
  items: []
};

const magentoPrepaidOrder = {
  ...magentoCodOrder,
  entity_id: 3002,
  increment_id: "000300002",
  grand_total: "899.00",
  payment: { method: "checkmo" },
  extension_attributes: {
    shipping_assignments: [{
      shipping: {
        address: {
          firstname: "Asha",
          lastname: "Buyer",
          telephone: "9876500000",
          street: ["Shipping lane"],
          city: "Delhi",
          region_code: "DL",
          postcode: "110001",
          country_id: "IN"
        }
      },
      items: [{ name: "Bag", sku: "BAG", qty_ordered: 1, price: "899.00", weight: 450, product_type: "simple" }]
    }]
  }
};

function magentoHeaders(body: unknown, secret = "test_magento_secret") {
  const payload = JSON.stringify(body);
  return {
    "X-Magento-Topic": "sales_order_place_after",
    "X-Magento-Event": "order.created",
    "X-Magento-Store": "default",
    "X-Magento-Webhook-Id": "magento_webhook_1",
    "X-Magento-Signature": createHmac("sha256", secret).update(payload).digest("base64")
  };
}

describe("Phase 17 Magento native integration foundation", () => {
  it("creates Magento connection metadata and rejects raw token or password fields", async () => {
    const { client, state } = createFakeClient();

    await assert.rejects(
      () => createMagentoConnectionFoundation("merchant_1", {
        storeName: "Demo",
        baseUrl: "https://magento.example",
        integrationToken: "magentotoken_secret_should_not_store"
      } as any, client),
      (error) => error instanceof HttpError && error.message === "MAGENTO_RAW_SECRET_REJECTED"
    );

    const connection = await createMagentoConnectionFoundation("merchant_1", {
      storeName: "Magento Store",
      baseUrl: "https://magento.example",
      storeViewCode: "default",
      websiteCode: "base",
      apiVersion: "2.4.7",
      installMode: MagentoInstallMode.INTEGRATION_TOKEN_PLACEHOLDER,
      credentialsRef: "vault://magento/demo"
    }, client);
    const list = await listMagentoConnections("merchant_1", { page: 1, per_page: 20 }, client);
    const json = JSON.stringify(connection);

    assert.equal(list.connections.length, 1);
    assert.equal(connection.magento?.base_url, "https://magento.example/");
    assert.equal(connection.magento?.store_view_code, "default");
    assert.equal(connection.credential_status, "configured_placeholder");
    assert.equal(state.connections[0]?.credentialsRef, "vault://magento/demo");
    assert.doesNotMatch(json, /vault:\/\/magento|magentotoken_secret_should_not_store|credentialsRef/i);
  });

  it("validates Magento URL and metadata inputs", async () => {
    const { client } = createFakeClient();

    await assert.rejects(
      () => createMagentoConnectionFoundation("merchant_1", {
        storeName: "Invalid",
        baseUrl: "ftp://magento.example"
      }, client),
      (error) => error instanceof HttpError && error.message === "MAGENTO_BASE_URL_INVALID"
    );

    const local = await createMagentoConnectionFoundation("merchant_1", {
      storeName: "Local",
      baseUrl: "http://localhost:8080",
      storeViewCode: "dev_store"
    }, client);
    assert.equal(local.magento?.base_url, "http://localhost:8080/");
    assert.equal(local.magento?.store_view_code, "dev_store");
  });

  it("updates and disables Magento connection metadata safely", async () => {
    const { client, state } = createFakeClient();
    const connection = await createMagentoConnectionFoundation("merchant_1", {
      baseUrl: "https://magento.example",
      storeViewCode: "default"
    }, client);
    const updated = await updateMagentoConnectionMetadata("merchant_1", connection.connection_id, {
      storeName: "Updated Magento",
      storeViewCode: "english",
      websiteCode: "main",
      apiVersion: "2.4.7",
      webhookStatus: MagentoWebhookStatus.SIMULATED
    }, client);
    const disabled = await disableMagentoConnection("merchant_1", connection.connection_id, client);

    assert.equal(updated.store_name, "Updated Magento");
    assert.equal(updated.magento?.api_version, "2.4.7");
    assert.equal(updated.magento?.website_code, "main");
    assert.equal(disabled.status, PlatformConnectionStatus.DISABLED);
    assert.equal(state.magentoStates[0]?.webhookStatus, MagentoWebhookStatus.DISABLED);
  });

  it("previews Magento COD and prepaid webhook payloads without creating imports or orders", async () => {
    const { client, state } = createFakeClient();
    const connection = await createMagentoConnectionFoundation("merchant_1", {
      baseUrl: "https://magento.example"
    }, client);
    const codPreview = await previewMagentoOrderWebhook("merchant_1", connection.connection_id, {
      payload: magentoCodOrder,
      headers: magentoHeaders(magentoCodOrder)
    }, client);
    const prepaidPreview = await previewMagentoOrderWebhook("merchant_1", connection.connection_id, {
      payload: magentoPrepaidOrder
    }, client);
    const json = JSON.stringify(codPreview);

    assert.equal(codPreview.normalized_order?.payment_mode, "COD");
    assert.equal(codPreview.normalized_order?.cod_amount_paise, 129900);
    assert.equal(prepaidPreview.normalized_order?.payment_mode, "PREPAID");
    assert.equal(prepaidPreview.normalized_order?.cod_amount_paise, 0);
    assert.equal(codPreview.will_create_shipmastr_order, false);
    assert.equal(codPreview.will_create_shipment, false);
    assert.equal(state.imports.length, 0);
    assert.doesNotMatch(json, /9876501234|Shipping address|providerName|courierOverride|credentialsRef/i);
  });

  it("returns Magento warnings for missing shipping data, weights, virtual items, and closed orders", async () => {
    const { client } = createFakeClient();
    const connection = await createMagentoConnectionFoundation("merchant_1", {
      baseUrl: "https://magento.example"
    }, client);
    const preview = await previewMagentoOrderWebhook("merchant_1", connection.connection_id, {
      payload: {
        entity_id: 3003,
        increment_id: "000300003",
        grand_total: "100.00",
        status: "closed",
        payment: { method: "checkmo" },
        billing_address: { firstname: "No", lastname: "Ship", city: "Delhi", country_id: "IN" },
        extension_attributes: { shipping_assignments: [] },
        items: [
          { name: "Ebook", sku: "DIGI", qty_ordered: 1, product_type: "downloadable" },
          { name: "Mystery box", sku: "MYSTERY", qty_ordered: 1, product_type: "simple" }
        ]
      }
    }, client);
    const codes = preview.mapping_warnings.map((warning: any) => warning.code);

    assert.ok(codes.includes("MISSING_SHIPPING_ASSIGNMENT"));
    assert.ok(codes.includes("MISSING_PHONE"));
    assert.ok(codes.includes("MISSING_POSTAL_CODE"));
    assert.ok(codes.includes("MISSING_ITEM_WEIGHT"));
    assert.ok(codes.includes("VIRTUAL_NON_SHIPPABLE_ITEM"));
    assert.ok(codes.includes("ORDER_CANCELLED_OR_CLOSED"));
    assert.ok(codes.includes("STORE_VIEW_UNMAPPED"));
  });

  it("imports Magento webhook payloads into PlatformOrderImport only", async () => {
    const { client, state } = createFakeClient();
    const connection = await createMagentoConnectionFoundation("merchant_1", {
      baseUrl: "https://magento.example"
    }, client);
    const imported = await importMagentoOrderWebhookFoundation("merchant_1", connection.connection_id, {
      payload: magentoCodOrder,
      headers: magentoHeaders(magentoCodOrder)
    }, client);
    const json = JSON.stringify(imported);

    assert.equal(imported.import?.platform, StorePlatform.MAGENTO);
    assert.equal(imported.import?.status, PlatformOrderImportStatus.MAPPED);
    assert.equal(state.imports.length, 1);
    assert.equal(state.imports[0]?.status, PlatformOrderImportStatus.MAPPED);
    assert.ok(state.connections[0]?.lastOrderImportAt);
    assert.equal(state.magentoStates[0]?.lastOrderWebhookId, "magento_webhook_1");
    assert.doesNotMatch(json, /9876501234|Shipping address|rawPayloadHash|providerName|courierOverride/i);
  });

  it("creates and simulates Magento shipping sync records without external API calls", async () => {
    const { client, state } = createFakeClient();
    state.shipments.push({
      id: "shipment_1",
      sellerId: "merchant_1",
      externalOrderId: "3001",
      awbNumber: "AWB123",
      trackingPublicUrl: "/track/trk_magento",
      trackingUrl: null
    });
    const connection = await createMagentoConnectionFoundation("merchant_1", {
      baseUrl: "https://magento.example"
    }, client);
    const sync = await createMagentoShippingSyncFoundation("merchant_1", connection.connection_id, {
      shipmentId: "shipment_1",
      incrementId: "000300001",
      carrierTitle: "Shipmastr",
      notifyCustomer: true
    }, client);
    const synced = await simulateMagentoShippingSyncSuccess("merchant_1", sync.sync_id, client);
    const failed = await simulateMagentoShippingSyncFailure("merchant_1", sync.sync_id, "Foundation-only simulation.", client);
    const json = JSON.stringify(sync);

    assert.equal(sync.status, PlatformTrackingSyncStatus.PENDING);
    assert.equal(sync.carrier_title, "Shipmastr");
    assert.equal(sync.external_delivery, "simulation_only");
    assert.equal(synced.status, PlatformTrackingSyncStatus.SYNCED);
    assert.equal(failed.status, PlatformTrackingSyncStatus.FAILED);
    assert.equal(state.syncs.length, 1);
    assert.ok(state.magentoStates[0]?.lastShippingSyncAttemptAt);
    assert.doesNotMatch(json, /providerName|providerShipmentId|courierOverride|credentialsRef/i);
  });

  it("validates Magento webhook headers without exposing signatures or secrets", () => {
    const missing = validateMagentoWebhookFoundation({ headers: {} });
    const body = { entity_id: 3001 };
    const validHeaders = magentoHeaders(body);
    const valid = validateMagentoWebhookFoundation({
      headers: validHeaders,
      body,
      secret: "test_magento_secret"
    });
    const json = JSON.stringify(valid);

    assert.equal(missing.status, "INVALID");
    assert.ok(missing.missing_headers.includes("x-magento-signature"));
    assert.equal(valid.status, "VALID");
    assert.equal(valid.webhook_id, "magento_webhook_1");
    assert.equal(json.includes(validHeaders["X-Magento-Signature"]), false);
    assert.equal(json.includes("test_magento_secret"), false);
  });
});
