import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OrderStatus,
  PaymentMode,
  PlatformImportItemStatus,
  PlatformImportJobMode,
  PlatformImportJobStatus,
  PlatformImportSource,
  PlatformOrderImportStatus,
  StorePlatform
} from "@prisma/client";
import {
  bulkConvertPlatformImportItems,
  convertPlatformImportItem,
  getPlatformImportItemConversionStatus
} from "../conversion/platform-import-conversion.service.js";
import { serializePlatformImportItem } from "../importQueue/platform-import-queue.serializers.js";
import {
  buildReconciliationItemView,
  serializeReconciliationItem,
  serializeReconciliationItemDetail
} from "../reconciliation/platform-import-reconciliation.serializer.js";

const now = new Date("2026-06-08T14:00:00.000Z");

function pageRows<T extends { updatedAt?: Date }>(rows: T[], args: any = {}) {
  const sorted = args.orderBy?.updatedAt === "desc"
    ? [...rows].sort((left: any, right: any) => right.updatedAt.getTime() - left.updatedAt.getTime())
    : rows;
  return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? sorted.length));
}

function createFakeClient() {
  const state = {
    pickups: [{
      id: "pickup_1",
      sellerId: "merchant_1",
      label: "Default pickup",
      contactName: "Ops",
      phone: "9876543210",
      addressLine1: "Warehouse",
      addressLine2: null,
      city: "Delhi",
      state: "Delhi",
      pincode: "110001",
      country: "IN",
      status: "active",
      metadata: { isDefault: true },
      createdAt: now,
      updatedAt: now
    }],
    jobs: [] as any[],
    items: [] as any[],
    conversions: [] as any[],
    orders: [] as any[],
    shipments: [] as any[],
    imports: [] as any[]
  };
  const byId = <T extends { id: string }>(rows: T[], id: string) => rows.find((row) => row.id === id);
  const client = {
    pickupLocation: {
      findMany: async ({ where }: any = {}) => state.pickups.filter((pickup) => (
        (!where?.sellerId || pickup.sellerId === where.sellerId) &&
        (!where?.status || pickup.status === where.status)
      ))
    },
    platformImportJob: {
      findFirst: async ({ where }: any) => state.jobs.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null
    },
    platformImportItem: {
      findFirst: async ({ where }: any) => state.items.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null,
      findMany: async (args: any = {}) => pageRows(state.items.filter((row) => (
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.id?.in || args.where.id.in.includes(row.id)) &&
        (!args.where?.connectionId || row.connectionId === args.where.connectionId) &&
        (!args.where?.platform || row.platform === args.where.platform) &&
        (!args.where?.externalOrderId || row.externalOrderId === args.where.externalOrderId) &&
        (!args.where?.jobId || row.jobId === args.where.jobId)
      )), args),
      update: async ({ where, data }: any) => {
        const row = byId(state.items, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    platformImportConversion: {
      findFirst: async ({ where }: any) => state.conversions.find((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.importItemId || row.importItemId === where.importItemId) &&
        (!where?.importItemId?.in || where.importItemId.in.includes(row.importItemId)) &&
        (!where?.status?.in || where.status.in.includes(row.status))
      )) ?? null,
      findMany: async ({ where }: any = {}) => state.conversions.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.importItemId?.in || where.importItemId.in.includes(row.importItemId))
      )),
      create: async ({ data }: any) => {
        const row = {
          id: `conversion_${state.conversions.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.conversions.push(row);
        return row;
      }
    },
    order: {
      findUnique: async ({ where }: any) => {
        if (where?.merchantId_externalOrderId) {
          return state.orders.find((order) => (
            order.merchantId === where.merchantId_externalOrderId.merchantId &&
            order.externalOrderId === where.merchantId_externalOrderId.externalOrderId
          )) ?? null;
        }
        return null;
      },
      create: async ({ data }: any) => {
        const row = {
          id: `order_${state.orders.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.orders.push(row);
        return row;
      }
    },
    platformOrderImport: {
      findFirst: async ({ where }: any) => state.imports.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.connectionId || row.connectionId === where.connectionId) &&
        (!where?.platform || row.platform === where.platform) &&
        (!where?.externalOrderId || row.externalOrderId === where.externalOrderId)
      )) ?? null,
      create: async ({ data }: any) => {
        const row = {
          id: `import_${state.imports.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.imports.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = byId(state.imports, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    }
  };
  return { client: client as any, state };
}

function safePreview(overrides: Record<string, unknown> = {}) {
  return {
    platform: StorePlatform.SHOPIFY,
    external_order_id: "1001",
    external_order_name: "#1001",
    payment_mode: "COD",
    currency: "INR",
    order_amount_paise: 149900,
    item_count: 1,
    buyer_preview: {
      name: "Asha Buyer",
      phone_masked: "98******10",
      email_masked: "a***@example.com"
    },
    destination: {
      city: "Delhi",
      state: "Delhi",
      postal_code: "110001",
      country: "IN"
    },
    line_items: [{ name: "Cotton kurta", quantity: 1, sku: "SKU-1", weight_grams: 500 }],
    rawPayload: { accessToken: "shpat_secret", buyerPhone: "9876543210", address: "221 Market Street" },
    rawHeaders: { Authorization: "Bearer secret" },
    providerName: "Bigship",
    ...overrides
  };
}

function addJob(state: ReturnType<typeof createFakeClient>["state"], attrs: Partial<any> = {}) {
  const row = {
    id: attrs.id || "job_1",
    connectionId: attrs.connectionId || "connection_1",
    merchantId: attrs.merchantId || "merchant_1",
    platform: attrs.platform || StorePlatform.SHOPIFY,
    mode: attrs.mode || PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER,
    source: attrs.source || PlatformImportSource.POLLING_PLACEHOLDER,
    status: attrs.status || PlatformImportJobStatus.COMPLETED,
    createdAt: now,
    updatedAt: now,
    ...attrs
  };
  state.jobs.push(row);
  return row;
}

function addItem(state: ReturnType<typeof createFakeClient>["state"], attrs: Partial<any> = {}) {
  const row = {
    id: attrs.id || `item_${state.items.length + 1}`,
    jobId: attrs.jobId || "job_1",
    connectionId: attrs.connectionId || "connection_1",
    merchantId: attrs.merchantId || "merchant_1",
    platform: attrs.platform || StorePlatform.SHOPIFY,
    externalOrderId: attrs.externalOrderId !== undefined ? attrs.externalOrderId : "1001",
    externalOrderName: attrs.externalOrderName !== undefined ? attrs.externalOrderName : "#1001",
    payloadHash: attrs.payloadHash || `hash_${state.items.length + 1}`,
    status: attrs.status || PlatformImportItemStatus.MAPPED,
    orderImportId: attrs.orderImportId ?? null,
    normalizedOrderId: attrs.normalizedOrderId ?? null,
    attemptCount: attrs.attemptCount ?? 0,
    lastAttemptAt: attrs.lastAttemptAt ?? null,
    nextAttemptAt: attrs.nextAttemptAt ?? null,
    errorCode: attrs.errorCode ?? null,
    errorMessage: attrs.errorMessage ?? null,
    mappingWarnings: attrs.mappingWarnings ?? [],
    safePayloadPreview: attrs.safePayloadPreview ?? safePreview({
      external_order_id: attrs.externalOrderId ?? "1001",
      external_order_name: attrs.externalOrderName ?? "#1001"
    }),
    createdAt: now,
    updatedAt: now
  };
  state.items.push(row);
  return row;
}

describe("Phase 30 beta platform import-to-shipping audit", () => {
  it("converts a fetched platform item into a safe Shipmastr draft order without shipping side effects", async () => {
    const { client, state } = createFakeClient();
    addJob(state);
    const item = addItem(state, {
      id: "item_ready",
      externalOrderId: "1001",
      mappingWarnings: ["Phone number missing"]
    });

    const result = await convertPlatformImportItem("merchant_1", item.id, { createShipmentCandidate: true }, client);
    const json = JSON.stringify({ result, orders: state.orders, conversions: state.conversions });

    assert.equal(result.status, "NEEDS_ATTENTION");
    assert.equal(result.order_id, "order_1");
    assert.equal(result.shipment_id, null);
    assert.equal(state.orders.length, 1);
    assert.equal(state.shipments.length, 0);
    assert.equal(state.imports[0]?.status, PlatformOrderImportStatus.IMPORTED);
    assert.equal(state.orders[0]?.status, OrderStatus.NEEDS_ATTENTION);
    assert.equal(state.orders[0]?.paymentMode, PaymentMode.COD);
    assert.equal(state.items[0]?.normalizedOrderId, "order_1");
    assert.doesNotMatch(json, /shpat_secret|Authorization|rawPayload|rawHeaders|9876543210|221 Market Street|Bigship|providerName|courier/i);
  });

  it("keeps duplicate and already-converted items idempotent during beta bulk conversion", async () => {
    const { client, state } = createFakeClient();
    addJob(state);
    const ready = addItem(state, { id: "item_ready", externalOrderId: "1001" });
    addItem(state, { id: "item_duplicate", externalOrderId: "1002", status: PlatformImportItemStatus.DUPLICATE });

    await convertPlatformImportItem("merchant_1", ready.id, {}, client);
    const result = await bulkConvertPlatformImportItems("merchant_1", {
      itemIds: ["item_ready", "item_duplicate"],
      limit: 50
    }, client);

    assert.equal(result.requested_count, 2);
    assert.equal(result.already_converted_count, 1);
    assert.equal(result.blocked_count, 1);
    assert.equal(state.orders.length, 1);
    assert.equal(state.conversions.length, 1);
  });

  it("keeps import, reconciliation, and conversion public payloads free of unsafe internals", async () => {
    const { client, state } = createFakeClient();
    addJob(state);
    const item = addItem(state, { id: "item_safe" });
    await convertPlatformImportItem("merchant_1", item.id, {}, client);

    const serializedImport = serializePlatformImportItem(state.items[0]);
    const reconciliation = serializeReconciliationItem(buildReconciliationItemView(state.items[0], state.conversions[0]));
    const detail = serializeReconciliationItemDetail(buildReconciliationItemView(state.items[0], state.conversions[0]));
    const status = await getPlatformImportItemConversionStatus("merchant_1", item.id, client);
    const json = JSON.stringify({ serializedImport, reconciliation, detail, status });

    assert.match(json, /VIEW_ORDER|REVIEW_ATTENTION/);
    assert.doesNotMatch(json, /rawPayload|rawHeaders|Authorization|Bearer|shpat_secret|accessToken|credentialHash|secretHash|9876543210|221 Market Street|Bigship|providerName|courier/i);
  });
});
