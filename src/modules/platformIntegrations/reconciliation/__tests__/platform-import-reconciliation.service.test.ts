import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlatformImportItemStatus,
  PlatformImportJobMode,
  PlatformImportJobStatus,
  PlatformImportSource,
  StorePlatform
} from "@prisma/client";
import {
  getPlatformImportReconciliationItem,
  getPlatformImportReconciliationSummary,
  listPlatformImportReconciliationItems,
  reconciliationStatusForImportItem
} from "../platform-import-reconciliation.service.js";

const baseDate = new Date("2026-06-08T05:00:00.000Z");

function datePlus(minutes: number) {
  return new Date(baseDate.getTime() + minutes * 60_000);
}

function pageRows<T extends { createdAt?: Date; updatedAt?: Date }>(rows: T[], args: any = {}) {
  const orderBy = args.orderBy || {};
  const key = orderBy.updatedAt ? "updatedAt" : "createdAt";
  const direction = orderBy[key] || "asc";
  const sorted = [...rows].sort((left: any, right: any) => {
    const leftValue = left[key]?.getTime?.() ?? 0;
    const rightValue = right[key]?.getTime?.() ?? 0;
    return direction === "desc" ? rightValue - leftValue : leftValue - rightValue;
  });
  return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? sorted.length));
}

function createFakeClient() {
  const state = {
    connections: [] as any[],
    jobs: [] as any[],
    items: [] as any[],
    conversions: [] as any[],
    orders: [] as any[],
    shipments: [] as any[]
  };

  const client = {
    platformConnection: {
      findMany: async ({ where }: any = {}) => state.connections.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId)
      ))
    },
    platformImportJob: {
      findMany: async (args: any = {}) => pageRows(state.jobs.filter((row) => (
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.id || row.id === args.where.id) &&
        (!args.where?.platform || row.platform === args.where.platform) &&
        (!args.where?.connectionId || row.connectionId === args.where.connectionId)
      )), args)
    },
    platformImportItem: {
      findMany: async (args: any = {}) => pageRows(state.items.filter((row) => (
        (!args.where?.merchantId || row.merchantId === args.where.merchantId) &&
        (!args.where?.jobId || row.jobId === args.where.jobId) &&
        (!args.where?.platform || row.platform === args.where.platform) &&
        (!args.where?.connectionId || row.connectionId === args.where.connectionId)
      )), args),
      findFirst: async ({ where }: any) => state.items.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null
    },
    platformImportConversion: {
      findMany: async ({ where }: any = {}) => state.conversions.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.importItemId?.in || where.importItemId.in.includes(row.importItemId))
      )),
      findFirst: async ({ where }: any = {}) => state.conversions.find((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.importItemId || row.importItemId === where.importItemId)
      )) ?? null
    }
  };

  return { client: client as any, state };
}

function addConnection(state: ReturnType<typeof createFakeClient>["state"], platform: StorePlatform, id: string) {
  const row = {
    id,
    merchantId: "merchant_1",
    platform,
    storeName: `${platform} Store`,
    storeUrl: "https://store.example",
    createdAt: baseDate,
    updatedAt: baseDate
  };
  state.connections.push(row);
  return row;
}

function addJob(state: ReturnType<typeof createFakeClient>["state"], attrs: Partial<any>) {
  const row = {
    id: attrs.id || `job_${state.jobs.length + 1}`,
    merchantId: "merchant_1",
    connectionId: attrs.connectionId || "connection_shopify",
    platform: attrs.platform || StorePlatform.SHOPIFY,
    mode: attrs.mode || PlatformImportJobMode.DRY_RUN,
    source: attrs.source || PlatformImportSource.MANUAL_PAYLOAD,
    status: attrs.status || PlatformImportJobStatus.COMPLETED,
    totalItems: attrs.totalItems ?? 0,
    mappedItems: attrs.mappedItems ?? 0,
    importedItems: attrs.importedItems ?? 0,
    skippedItems: attrs.skippedItems ?? 0,
    duplicateItems: attrs.duplicateItems ?? 0,
    failedItems: attrs.failedItems ?? 0,
    warningCount: attrs.warningCount ?? 0,
    safeSummary: attrs.safeSummary ?? null,
    createdAt: attrs.createdAt || baseDate,
    updatedAt: attrs.updatedAt || baseDate
  };
  state.jobs.push(row);
  return row;
}

function safePreview(attrs: Partial<Record<string, unknown>> = {}) {
  return {
    external_order_id: attrs.external_order_id || "1001",
    external_order_name: attrs.external_order_name || "#1001",
    payment_mode: attrs.payment_mode || "COD",
    currency: "INR",
    order_amount_paise: 129900,
    item_count: 1,
    buyerPreview: {
      name: "Asha Buyer",
      phone: "9876543210",
      phoneMasked: "ending 3210",
      email: "buyer@example.com",
      emailMasked: "b***@example.com"
    },
    destination: {
      city: "Delhi",
      state: "Delhi",
      postal_code: "110001",
      country: "IN",
      addressLine1: "221 Market Street"
    },
    lineItemPreview: [
      { name: "Kurta", sku: "SKU-1", quantity: 1, weightGrams: 250 }
    ],
    rawPayload: { accessToken: "shpat_secret" },
    rawHeaders: { Authorization: "Bearer secret" },
    ...attrs
  };
}

function addItem(state: ReturnType<typeof createFakeClient>["state"], attrs: Partial<any>) {
  const row = {
    id: attrs.id || `item_${state.items.length + 1}`,
    jobId: attrs.jobId || "job_shopify",
    connectionId: attrs.connectionId || "connection_shopify",
    merchantId: "merchant_1",
    platform: attrs.platform || StorePlatform.SHOPIFY,
    externalOrderId: attrs.externalOrderId ?? "1001",
    externalOrderName: attrs.externalOrderName ?? "#1001",
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
    createdAt: attrs.createdAt || baseDate,
    updatedAt: attrs.updatedAt || baseDate
  };
  state.items.push(row);
  return row;
}

function seedReconciliationData() {
  const { client, state } = createFakeClient();
  addConnection(state, StorePlatform.SHOPIFY, "connection_shopify");
  addConnection(state, StorePlatform.WOOCOMMERCE, "connection_woo");
  addConnection(state, StorePlatform.MAGENTO, "connection_magento");
  addJob(state, {
    id: "job_shopify",
    platform: StorePlatform.SHOPIFY,
    connectionId: "connection_shopify",
    mode: PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER,
    totalItems: 4,
    safeSummary: { fetched_count: 4, effective_limit: 25, has_more: false }
  });
  addJob(state, {
    id: "job_woo",
    platform: StorePlatform.WOOCOMMERCE,
    connectionId: "connection_woo",
    totalItems: 1,
    createdAt: datePlus(10),
    updatedAt: datePlus(10)
  });
  addItem(state, { id: "item_ready", externalOrderId: "1001", externalOrderName: "#1001", createdAt: datePlus(1), updatedAt: datePlus(1) });
  addItem(state, {
    id: "item_warning",
    externalOrderId: "1002",
    externalOrderName: "#1002",
    mappingWarnings: ["Phone number missing"],
    createdAt: datePlus(2),
    updatedAt: datePlus(2)
  });
  addItem(state, {
    id: "item_duplicate",
    externalOrderId: "1003",
    externalOrderName: "#1003",
    status: PlatformImportItemStatus.DUPLICATE,
    errorCode: "PLATFORM_IMPORT_DUPLICATE_ORDER",
    errorMessage: "This platform order was already imported.",
    createdAt: datePlus(3),
    updatedAt: datePlus(3)
  });
  addItem(state, {
    id: "item_failed",
    externalOrderId: "1004",
    externalOrderName: "#1004",
    status: PlatformImportItemStatus.FAILED,
    errorCode: "PLATFORM_ORDER_ID_MISSING",
    errorMessage: "The platform order is missing an order ID.",
    attemptCount: 1,
    nextAttemptAt: datePlus(60),
    createdAt: datePlus(4),
    updatedAt: datePlus(4)
  });
  addItem(state, {
    id: "item_woo_ready",
    jobId: "job_woo",
    connectionId: "connection_woo",
    platform: StorePlatform.WOOCOMMERCE,
    externalOrderId: "WC-1",
    externalOrderName: "WC-1",
    createdAt: datePlus(12),
    updatedAt: datePlus(12)
  });
  return { client, state };
}

describe("Phase 22 platform import reconciliation foundation", () => {
  it("returns safe summary totals and groups by platform and connection", async () => {
    const { client } = seedReconciliationData();
    const summary = await getPlatformImportReconciliationSummary("merchant_1", {}, client);
    const json = JSON.stringify(summary);

    assert.equal(summary.total_jobs, 2);
    assert.equal(summary.total_items, 5);
    assert.equal(summary.fetched_items, 4);
    assert.equal(summary.ready_items, 2);
    assert.equal(summary.duplicate_items, 1);
    assert.equal(summary.warning_items, 1);
    assert.equal(summary.failed_items, 1);
    assert.equal(summary.retriable_items, 1);
    assert.equal(summary.by_platform.find((row: any) => row.platform === StorePlatform.SHOPIFY)?.total_items, 4);
    assert.equal(summary.by_connection.find((row: any) => row.connection_id === "connection_woo")?.ready_items, 1);
    assert.doesNotMatch(json, /9876543210|221 Market Street|shpat_secret|Authorization|rawPayload|rawHeaders|payloadHash|Bigship|providerName/i);
  });

  it("respects platform, job, status, warning, error, date, and safe search filters", async () => {
    const { client } = seedReconciliationData();
    const warningItems = await listPlatformImportReconciliationItems("merchant_1", {
      platform: StorePlatform.SHOPIFY,
      status: "WARNING",
      hasWarnings: true,
      page: 1,
      limit: 10,
      sort: "created_at_asc"
    }, client);
    const wooItems = await listPlatformImportReconciliationItems("merchant_1", {
      jobId: "job_woo",
      search: "WC-1",
      dateFrom: datePlus(11).toISOString(),
      dateTo: datePlus(13).toISOString(),
      page: 1,
      limit: 10,
      sort: "created_at_asc"
    }, client);
    const failedItems = await listPlatformImportReconciliationItems("merchant_1", {
      hasErrors: true,
      page: 1,
      limit: 10,
      sort: "created_at_asc"
    }, client);

    assert.equal(warningItems.items.length, 1);
    assert.equal(warningItems.items[0]?.item_id, "item_warning");
    assert.equal(wooItems.items.length, 1);
    assert.equal(wooItems.items[0]?.platform, StorePlatform.WOOCOMMERCE);
    assert.equal(failedItems.items.length, 2);
    assert.ok(failedItems.items.some((item: any) => item.reconciliation_status === "FAILED"));
    assert.ok(failedItems.items.some((item: any) => item.reconciliation_status === "DUPLICATE"));
  });

  it("paginates and serializes reconciliation item lists without unsafe fields", async () => {
    const { client } = seedReconciliationData();
    const page = await listPlatformImportReconciliationItems("merchant_1", {
      page: 1,
      limit: 2,
      sort: "updated_at_desc"
    }, client);
    const json = JSON.stringify(page);

    assert.equal(page.items.length, 2);
    assert.equal(page.total, 5);
    assert.equal(page.has_more, true);
    assert.equal(page.items[0]?.item_id, "item_woo_ready");
    assert.doesNotMatch(json, /payload_hash|rawPayload|rawHeaders|Authorization|shpat_secret|9876543210|221 Market Street|buyer@example.com|providerPayload|Bigship/i);
  });

  it("returns safe item detail with warnings, errors, line item preview, and next actions", async () => {
    const { client } = seedReconciliationData();
    const warning = await getPlatformImportReconciliationItem("merchant_1", "item_warning", client);
    const failed = await getPlatformImportReconciliationItem("merchant_1", "item_failed", client);
    const json = JSON.stringify({ warning, failed });

    assert.equal(warning.reconciliation_status, "WARNING");
    assert.equal(warning.order_preview.line_items?.[0]?.name, "Kurta");
    assert.deepEqual(failed.safe_next_actions, ["REVIEW", "RETRY"]);
    assert.match(failed.errors.join(" "), /missing an order ID/i);
    assert.doesNotMatch(json, /rawPayload|rawHeaders|Authorization|shpat_secret|9876543210|221 Market Street|buyer@example.com|providerName|Bigship/i);
  });

  it("calculates reconciliation status deterministically", () => {
    assert.equal(reconciliationStatusForImportItem(addItem(createFakeClient().state, {
      status: PlatformImportItemStatus.DUPLICATE
    }) as any), "DUPLICATE");
    assert.equal(reconciliationStatusForImportItem(addItem(createFakeClient().state, {
      status: PlatformImportItemStatus.FAILED
    }) as any), "FAILED");
    assert.equal(reconciliationStatusForImportItem(addItem(createFakeClient().state, {
      mappingWarnings: ["Postal code missing"]
    }) as any), "WARNING");
    assert.equal(reconciliationStatusForImportItem(addItem(createFakeClient().state, {
      status: PlatformImportItemStatus.MAPPED
    }) as any), "READY");
    assert.equal(reconciliationStatusForImportItem(addItem(createFakeClient().state, {
      status: PlatformImportItemStatus.PENDING
    }) as any), "NEEDS_REVIEW");
  });

  it("does not create orders, shipments, platform writes, or background work", async () => {
    const { client, state } = seedReconciliationData();
    await getPlatformImportReconciliationSummary("merchant_1", {}, client);
    await listPlatformImportReconciliationItems("merchant_1", { page: 1, limit: 20, sort: "updated_at_desc" }, client);
    await getPlatformImportReconciliationItem("merchant_1", "item_ready", client);

    assert.equal(state.orders.length, 0);
    assert.equal(state.shipments.length, 0);
  });
});
