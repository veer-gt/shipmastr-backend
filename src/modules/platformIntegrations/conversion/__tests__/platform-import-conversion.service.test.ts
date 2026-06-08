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
} from "../platform-import-conversion.service.js";
import { evaluatePlatformImportConversionEligibility } from "../platform-import-conversion.rules.js";

const now = new Date("2026-06-08T07:00:00.000Z");

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
      label: "Main warehouse",
      contactName: "Ops",
      phone: "9876543210",
      addressLine1: "Warehouse 1",
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
    destination: {
      city: "Delhi",
      state: "Delhi",
      postal_code: "110001",
      country: "IN"
    },
    rawPayload: { accessToken: "shpat_secret" },
    rawHeaders: { Authorization: "Bearer secret" },
    ...overrides
  };
}

function addJob(state: ReturnType<typeof createFakeClient>["state"], attrs: Partial<any> = {}) {
  const row = {
    id: attrs.id || "job_1",
    connectionId: attrs.connectionId || "connection_1",
    merchantId: attrs.merchantId || "merchant_1",
    platform: attrs.platform || StorePlatform.SHOPIFY,
    mode: attrs.mode || PlatformImportJobMode.DRY_RUN,
    source: attrs.source || PlatformImportSource.MANUAL_PAYLOAD,
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

describe("Phase 23 platform import conversion rule engine", () => {
  it("marks ready and warning items eligible while blocking failed and duplicate items", () => {
    const ready = addItem({ items: [] } as any, { id: "ready" });
    assert.equal(evaluatePlatformImportConversionEligibility(ready).eligible, true);

    const warning = addItem({ items: [] } as any, {
      id: "warning",
      mappingWarnings: ["Phone number missing"]
    });
    const warningEligibility = evaluatePlatformImportConversionEligibility(warning);
    assert.equal(warningEligibility.eligible, true);
    assert.equal(warningEligibility.queue, "NEEDS_ATTENTION");

    const failed = addItem({ items: [] } as any, {
      id: "failed",
      status: PlatformImportItemStatus.FAILED,
      errorCode: "PLATFORM_ORDER_ID_MISSING"
    });
    assert.equal(evaluatePlatformImportConversionEligibility(failed).eligible, false);
    assert.ok(evaluatePlatformImportConversionEligibility(failed).reasonCodes.includes("ITEM_FAILED"));

    const duplicate = addItem({ items: [] } as any, {
      id: "duplicate",
      status: PlatformImportItemStatus.DUPLICATE
    });
    assert.equal(evaluatePlatformImportConversionEligibility(duplicate).eligible, false);
    assert.ok(evaluatePlatformImportConversionEligibility(duplicate).reasonCodes.includes("ITEM_DUPLICATE"));
  });

  it("blocks missing external order id, pincode, country, line items, and already converted items", () => {
    const missing = addItem({ items: [] } as any, {
      id: "missing",
      externalOrderId: null,
      safePayloadPreview: safePreview({
        external_order_id: null,
        item_count: 0,
        destination: { city: "Delhi" }
      })
    });
    const result = evaluatePlatformImportConversionEligibility(missing);
    assert.equal(result.eligible, false);
    assert.ok(result.reasonCodes.includes("MISSING_EXTERNAL_ORDER_ID"));
    assert.ok(result.reasonCodes.includes("MISSING_SHIPPING_PINCODE"));
    assert.ok(result.reasonCodes.includes("MISSING_COUNTRY"));
    assert.ok(result.reasonCodes.includes("MISSING_LINE_ITEMS"));

    const converted = addItem({ items: [] } as any, { normalizedOrderId: "order_1" });
    assert.ok(evaluatePlatformImportConversionEligibility(converted).reasonCodes.includes("ALREADY_CONVERTED"));
  });

  it("converts an eligible item into a Shipmastr order and safe conversion record", async () => {
    const { client, state } = createFakeClient();
    addJob(state);
    const item = addItem(state, { id: "item_ready", externalOrderId: "1001" });

    const result = await convertPlatformImportItem("merchant_1", item.id, {}, client);
    const json = JSON.stringify(result);

    assert.equal(result.status, "NEEDS_ATTENTION");
    assert.equal(result.order_id, "order_1");
    assert.equal(result.shipment_id, null);
    assert.equal(state.orders.length, 1);
    assert.equal(state.orders[0]?.status, OrderStatus.NEEDS_ATTENTION);
    assert.equal(state.orders[0]?.paymentMode, PaymentMode.COD);
    assert.equal(state.orders[0]?.externalOrderId, "platform-import:connection_1:1001");
    assert.equal(state.items[0]?.normalizedOrderId, "order_1");
    assert.equal(state.imports[0]?.status, PlatformOrderImportStatus.IMPORTED);
    assert.equal(state.conversions[0]?.orderId, "order_1");
    assert.doesNotMatch(json, /shpat_secret|Authorization|rawPayload|rawHeaders|credentialHash|secretHash|Bigship|providerName/i);
  });

  it("does not create a shipment candidate when requested data still needs attention", async () => {
    const { client, state } = createFakeClient();
    addJob(state);
    const item = addItem(state, { id: "item_candidate" });
    const result = await convertPlatformImportItem("merchant_1", item.id, { createShipmentCandidate: true }, client);

    assert.equal(result.shipment_id, null);
    assert.equal(state.shipments.length, 0);
    assert.ok(result.reason_codes.includes("SHIPMENT_CANDIDATE_NOT_READY"));
  });

  it("returns already-converted safely without duplicating orders", async () => {
    const { client, state } = createFakeClient();
    addJob(state);
    const item = addItem(state, { id: "item_ready" });
    await convertPlatformImportItem("merchant_1", item.id, {}, client);
    const again = await convertPlatformImportItem("merchant_1", item.id, {}, client);

    assert.equal(again.status, "ALREADY_CONVERTED");
    assert.equal(state.orders.length, 1);
    assert.equal(state.conversions.length, 1);
  });

  it("bulk conversion converts eligible items and reports blocked items independently", async () => {
    const { client, state } = createFakeClient();
    addJob(state);
    addItem(state, { id: "item_ready_1", externalOrderId: "1001" });
    addItem(state, { id: "item_failed", externalOrderId: "1002", status: PlatformImportItemStatus.FAILED, errorCode: "FAILED" });
    addItem(state, { id: "item_duplicate", externalOrderId: "1003", status: PlatformImportItemStatus.DUPLICATE });

    const result = await bulkConvertPlatformImportItems("merchant_1", {
      itemIds: ["item_ready_1", "item_failed", "item_duplicate"],
      limit: 50
    }, client);

    assert.equal(result.requested_count, 3);
    assert.equal(result.needs_attention_count, 1);
    assert.equal(result.blocked_count, 2);
    assert.equal(state.orders.length, 1);
  });

  it("returns safe conversion status metadata", async () => {
    const { client, state } = createFakeClient();
    addJob(state);
    const item = addItem(state, { id: "item_status" });
    await convertPlatformImportItem("merchant_1", item.id, {}, client);

    const status = await getPlatformImportItemConversionStatus("merchant_1", item.id, client);
    const json = JSON.stringify(status);

    assert.equal(status.conversion.order_id, "order_1");
    assert.doesNotMatch(json, /rawPayload|rawHeaders|accessToken|consumerSecret|integrationToken|Bigship|providerName/i);
  });
});
