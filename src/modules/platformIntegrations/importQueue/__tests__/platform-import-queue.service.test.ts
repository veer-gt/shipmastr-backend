import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlatformConnectionStatus,
  PlatformImportItemStatus,
  PlatformImportJobMode,
  PlatformImportJobStatus,
  PlatformImportSource,
  PlatformOrderImportStatus,
  StorePlatform
} from "@prisma/client";
import { HttpError } from "../../../../lib/httpError.js";
import {
  cancelPlatformImportJob,
  createPlatformImportJob,
  getPlatformImportJob,
  getPlatformImportJobSummary,
  retryPlatformImportItem,
  runPlatformImportJobFoundation
} from "../platform-import-queue.service.js";

const now = new Date("2026-06-08T05:00:00.000Z");

function pageRows<T>(rows: T[], args: any = {}) {
  const sorted = args.orderBy?.createdAt === "desc"
    ? [...rows].sort((left: any, right: any) => right.createdAt.getTime() - left.createdAt.getTime())
    : rows;
  return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? sorted.length));
}

function createFakeClient() {
  const state = {
    connections: [] as any[],
    jobs: [] as any[],
    items: [] as any[],
    imports: [] as any[],
    healthChecks: [] as any[]
  };
  const id = (prefix: string, count: number) => `${prefix}_${count + 1}`;
  const byId = <T extends { id: string }>(rows: T[], rowId: string) => rows.find((row) => row.id === rowId);

  const client = {
    platformConnection: {
      findFirst: async ({ where }: any) => state.connections.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null,
      update: async ({ where, data }: any) => {
        const row = byId(state.connections, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    platformConnectionHealthCheck: {
      findFirst: async ({ where }: any) => state.healthChecks.find((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.connectionId || row.connectionId === where.connectionId)
      )) ?? null
    },
    platformImportJob: {
      create: async ({ data }: any) => {
        const row = {
          id: id("platform_import_job", state.jobs.length),
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          mappedItems: 0,
          importedItems: 0,
          skippedItems: 0,
          duplicateItems: 0,
          failedItems: 0,
          warningCount: 0,
          ...data
        };
        state.jobs.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.jobs.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null,
      findMany: async (args: any = {}) => pageRows(state.jobs.filter((row) => (
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.platform || row.platform === args.where.platform) &&
        (!args.where?.status || row.status === args.where.status) &&
        (!args.where?.mode || row.mode === args.where.mode) &&
        (!args.where?.connectionId || row.connectionId === args.where.connectionId)
      )), args),
      count: async ({ where }: any = {}) => state.jobs.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.platform || row.platform === where.platform) &&
        (!where?.status || row.status === where.status) &&
        (!where?.mode || row.mode === where.mode) &&
        (!where?.connectionId || row.connectionId === where.connectionId)
      )).length,
      update: async ({ where, data }: any) => {
        const row = byId(state.jobs, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    platformImportItem: {
      create: async ({ data }: any) => {
        const row = {
          id: id("platform_import_item", state.items.length),
          createdAt: now,
          updatedAt: now,
          attemptCount: 0,
          lastAttemptAt: null,
          nextAttemptAt: null,
          orderImportId: null,
          normalizedOrderId: null,
          errorCode: null,
          errorMessage: null,
          mappingWarnings: [],
          safePayloadPreview: null,
          ...data
        };
        state.items.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.items.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null,
      findMany: async (args: any = {}) => pageRows(state.items.filter((row) => (
        (!args.where?.jobId || row.jobId === args.where.jobId) &&
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.status || row.status === args.where.status)
      )), args),
      update: async ({ where, data }: any) => {
        const row = byId(state.items, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    platformOrderImport: {
      create: async ({ data }: any) => {
        const row = {
          id: id("platform_order_import", state.imports.length),
          createdAt: now,
          updatedAt: now,
          normalizedOrderId: null,
          ...data
        };
        state.imports.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.imports.find((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.connectionId || row.connectionId === where.connectionId) &&
        (!where?.platform || row.platform === where.platform) &&
        (!where?.externalOrderId || row.externalOrderId === where.externalOrderId)
      )) ?? null
    }
  };

  return { client: client as any, state };
}

function addConnection(state: ReturnType<typeof createFakeClient>["state"], platform: StorePlatform, status = PlatformConnectionStatus.ACTIVE) {
  const row = {
    id: `connection_${state.connections.length + 1}`,
    merchantId: "merchant_1",
    platform,
    storeName: `${platform} Store`,
    storeUrl: platform === StorePlatform.SHOPIFY ? "https://demo.myshopify.com" : "https://store.example",
    status,
    syncDirection: "IMPORT_ONLY",
    credentialsRef: "platform-credential:test",
    credentialsMeta: null,
    lastOrderImportAt: null,
    lastTrackingSyncAt: null,
    disabledAt: null,
    createdAt: now,
    updatedAt: now
  };
  state.connections.push(row);
  return row;
}

const shopifyOrder = {
  id: 1001,
  name: "#1001",
  total_price: "1299.00",
  currency: "INR",
  financial_status: "pending",
  payment_gateway_names: ["Cash on Delivery"],
  shipping_address: {
    name: "Asha Buyer",
    phone: "9876543210",
    address1: "221 Market Street",
    city: "Delhi",
    province: "Delhi",
    zip: "110001",
    country_code: "IN"
  },
  line_items: [{ name: "Kurta", sku: "SKU-1", quantity: 1, price: "1299.00", grams: 250, requires_shipping: true }]
};

const wooOrder = {
  id: 2001,
  number: "WC-2001",
  currency: "INR",
  total: "499.50",
  payment_method: "cod",
  payment_method_title: "Cash on delivery",
  billing: { first_name: "Ravi", last_name: "Buyer", phone: "9876501234", email: "ravi@example.com" },
  shipping: { first_name: "Ravi", last_name: "Buyer", address_1: "Shipping address", city: "Mumbai", state: "MH", postcode: "400001", country: "IN" },
  line_items: [{ name: "Wallet", quantity: 1, total: "499.50", meta_data: [{ key: "weight", value: "0.2" }] }]
};

const magentoOrder = {
  entity_id: 3001,
  increment_id: "MG-3001",
  grand_total: 999,
  order_currency_code: "INR",
  payment: { method: "cashondelivery" },
  billing_address: { firstname: "Maya", lastname: "Buyer", telephone: "9876500000", street: ["Billing lane"], city: "Bengaluru", region: "Karnataka", postcode: "560001", country_id: "IN" },
  extension_attributes: {
    shipping_assignments: [{
      shipping: { address: { firstname: "Maya", lastname: "Buyer", telephone: "9876500000", street: ["MG Road"], city: "Bengaluru", region: "Karnataka", postcode: "560001", country_id: "IN" } },
      items: [{ name: "Shoes", sku: "SHOE", qty_ordered: 1, price: 999, weight: 0.7 }]
    }]
  }
};

describe("Phase 20 platform order import queue foundation", () => {
  it("creates dry-run jobs for supported connections without creating Shipmastr orders or platform imports", async () => {
    for (const [platform, order] of [
      [StorePlatform.SHOPIFY, shopifyOrder],
      [StorePlatform.WOOCOMMERCE, wooOrder],
      [StorePlatform.MAGENTO, magentoOrder]
    ] as const) {
      const { client, state } = createFakeClient();
      const connection = addConnection(state, platform);
      const created = await createPlatformImportJob("merchant_1", {
        connectionId: connection.id,
        mode: PlatformImportJobMode.DRY_RUN,
        source: PlatformImportSource.MANUAL_PAYLOAD,
        orders: [order]
      }, client);
      const ran = await runPlatformImportJobFoundation("merchant_1", created.job.job_id, client);
      const json = JSON.stringify(ran);

      assert.equal(created.items[0]?.status, PlatformImportItemStatus.MAPPED);
      assert.ok(([
        PlatformImportJobStatus.COMPLETED,
        PlatformImportJobStatus.COMPLETED_WITH_WARNINGS
      ] as string[]).includes(String(ran.job.status)));
      assert.equal(state.imports.length, 0);
      assert.doesNotMatch(json, /9876543210|9876501234|9876500000|221 Market Street|Shipping address|MG Road|secretRef|encryptedValue|Bigship|providerName/i);
    }
  });

  it("rejects missing connections and unsupported custom mapping jobs", async () => {
    const { client, state } = createFakeClient();
    await assert.rejects(
      () => createPlatformImportJob("merchant_1", {
        connectionId: "missing",
        mode: PlatformImportJobMode.DRY_RUN,
        source: PlatformImportSource.MANUAL_PAYLOAD,
        orders: [shopifyOrder]
      }, client),
      (error: unknown) => error instanceof HttpError && error.message === "PLATFORM_CONNECTION_NOT_FOUND"
    );

    const custom = addConnection(state, StorePlatform.CUSTOM);
    await assert.rejects(
      () => createPlatformImportJob("merchant_1", {
        connectionId: custom.id,
        mode: PlatformImportJobMode.DRY_RUN,
        source: PlatformImportSource.MANUAL_PAYLOAD,
        orders: [shopifyOrder]
      }, client),
      (error: unknown) => error instanceof HttpError && error.message === "PLATFORM_IMPORT_UNSUPPORTED_PLATFORM"
    );
  });

  it("creates PlatformOrderImport records in import-foundation mode only after manual run", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.SHOPIFY);
    const created = await createPlatformImportJob("merchant_1", {
      connectionId: connection.id,
      mode: PlatformImportJobMode.IMPORT_FOUNDATION,
      source: PlatformImportSource.MANUAL_PAYLOAD,
      orders: [shopifyOrder]
    }, client);

    assert.equal(state.imports.length, 0);
    const ran = await runPlatformImportJobFoundation("merchant_1", created.job.job_id, client);

    assert.equal(state.imports.length, 1);
    assert.equal(state.imports[0]?.status, PlatformOrderImportStatus.MAPPED);
    assert.equal(ran.job.status, PlatformImportJobStatus.COMPLETED);
    assert.equal(ran.items[0]?.status, PlatformImportItemStatus.IMPORTED);
  });

  it("marks duplicate external orders, duplicate payloads, and missing order IDs safely", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.SHOPIFY);
    state.imports.push({
      id: "existing_import",
      merchantId: "merchant_1",
      connectionId: connection.id,
      platform: StorePlatform.SHOPIFY,
      externalOrderId: "1001",
      externalOrderName: "#1001",
      status: PlatformOrderImportStatus.MAPPED,
      createdAt: now,
      updatedAt: now
    });

    const duplicatePayload = { ...shopifyOrder, id: 1002, name: "#1002" };
    const created = await createPlatformImportJob("merchant_1", {
      connectionId: connection.id,
      mode: PlatformImportJobMode.DRY_RUN,
      source: PlatformImportSource.MANUAL_PAYLOAD,
      orders: [
        shopifyOrder,
        duplicatePayload,
        duplicatePayload,
        { total_price: "1.00", shipping_address: {}, line_items: [] }
      ]
    }, client);
    const statuses = created.items.map((item) => item.status);
    const json = JSON.stringify(created);

    assert.deepEqual(statuses, [
      PlatformImportItemStatus.DUPLICATE,
      PlatformImportItemStatus.MAPPED,
      PlatformImportItemStatus.DUPLICATE,
      PlatformImportItemStatus.FAILED
    ]);
    assert.doesNotMatch(json, /9876543210|221 Market Street|secretRef|encryptedValue|rawHeaders|rawResponse/i);
  });

  it("records retry backoff and cancels queued jobs", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.SHOPIFY);
    const created = await createPlatformImportJob("merchant_1", {
      connectionId: connection.id,
      mode: PlatformImportJobMode.DRY_RUN,
      source: PlatformImportSource.MANUAL_PAYLOAD,
      orders: [{ total_price: "1.00", shipping_address: {}, line_items: [] }]
    }, client);
    const failedItem = created.items[0]!;
    const retried = await retryPlatformImportItem("merchant_1", failedItem.item_id, client);
    const cancelledJob = await createPlatformImportJob("merchant_1", {
      connectionId: connection.id,
      mode: PlatformImportJobMode.DRY_RUN,
      source: PlatformImportSource.MANUAL_PAYLOAD,
      orders: [shopifyOrder]
    }, client);
    const cancelled = await cancelPlatformImportJob("merchant_1", cancelledJob.job.job_id, client);

    assert.equal(retried.attempt_count, 1);
    assert.ok(retried.next_attempt_at);
    assert.equal(cancelled.status, PlatformImportJobStatus.CANCELLED);
  });

  it("returns job detail and summary with safe public fields only", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.WOOCOMMERCE);
    const created = await createPlatformImportJob("merchant_1", {
      connectionId: connection.id,
      mode: PlatformImportJobMode.DRY_RUN,
      source: PlatformImportSource.WEBHOOK_PAYLOAD,
      orders: [wooOrder]
    }, client);
    await runPlatformImportJobFoundation("merchant_1", created.job.job_id, client);
    const detail = await getPlatformImportJob("merchant_1", created.job.job_id, client);
    const summary = await getPlatformImportJobSummary("merchant_1", created.job.job_id, client);
    const json = JSON.stringify({ detail, summary });

    assert.equal(summary.summary.totalItems, 1);
    assert.equal(detail.items.length, 1);
    assert.doesNotMatch(json, /9876501234|Shipping address|consumerSecret|secretRef|encryptedValue|providerPayload|courierOverride|Bigship/i);
  });

  it("creates read-only fetch placeholders without calling external APIs", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.CUSTOM);
    const created = await createPlatformImportJob("merchant_1", {
      connectionId: connection.id,
      mode: PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER,
      source: PlatformImportSource.POLLING_PLACEHOLDER,
      orders: []
    }, client);
    const ran = await runPlatformImportJobFoundation("merchant_1", created.job.job_id, client);

    assert.equal(ran.job.status, PlatformImportJobStatus.COMPLETED_WITH_WARNINGS);
    assert.match(String((ran.job.safe_summary as Record<string, unknown> | null)?.message), /placeholder/i);
  });
});
