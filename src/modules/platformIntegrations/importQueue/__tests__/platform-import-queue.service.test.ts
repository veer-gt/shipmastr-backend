import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlatformConnectionStatus,
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformCredentialType,
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
import type { PlatformCredentialVault } from "../../credentials/platform-credentials.crypto.js";
import type { PlatformOrderReadClient } from "../../readOnlyFetch/platform-order-fetch.types.js";

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
    credentials: [] as any[],
    credentialSecrets: [] as any[],
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
    platformCredential: {
      findFirst: async ({ where }: any) => state.credentials.find((row) => (
        (!where?.id || row.id === where.id) &&
        (!where?.merchantId || row.merchantId === where.merchantId)
      )) ?? null
    },
    platformCredentialSecret: {
      findUnique: async ({ where }: any) => state.credentialSecrets.find((row) => row.credentialId === where.credentialId) ?? null
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
    credentialsRef: null,
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

const testVault: PlatformCredentialVault = {
  storeSecret(secret: unknown) {
    return {
      encryptedValue: `test-vault:${Buffer.from(JSON.stringify(secret)).toString("base64")}`,
      encryptionVersion: "test-vault"
    };
  },

  readSecretForInternalUse(stored) {
    return JSON.parse(Buffer.from(stored.encryptedValue.replace(/^test-vault:/, ""), "base64").toString("utf8"));
  },

  rotateSecret(secret: unknown) {
    return this.storeSecret(secret);
  },

  revokeSecret() {
    return undefined;
  },

  fingerprintSecret(secret: unknown) {
    return `fingerprint-${Buffer.from(JSON.stringify(secret)).toString("hex").slice(0, 8)}`;
  },

  maskSecret(secret: string) {
    return `${String(secret).slice(0, 4)}...`;
  }
};

function credentialProviderFor(platform: StorePlatform) {
  return platform as unknown as PlatformCredentialProvider;
}

function credentialTypeFor(platform: StorePlatform) {
  if (platform === StorePlatform.SHOPIFY) return PlatformCredentialType.SHOPIFY_CUSTOM_APP_TOKEN;
  if (platform === StorePlatform.WOOCOMMERCE) return PlatformCredentialType.WOOCOMMERCE_REST_KEYS;
  if (platform === StorePlatform.MAGENTO) return PlatformCredentialType.MAGENTO_INTEGRATION_TOKEN;
  return PlatformCredentialType.CUSTOM_API_KEY;
}

function secretForPlatform(platform: StorePlatform) {
  if (platform === StorePlatform.SHOPIFY) {
    return { shopDomain: "demo.myshopify.com", apiVersion: "2025-10", accessToken: "shpat_test_secret" };
  }
  if (platform === StorePlatform.WOOCOMMERCE) {
    return { siteUrl: "https://store.example", consumerKey: "ck_test_secret", consumerSecret: "cs_test_secret", apiVersion: "wc/v3" };
  }
  return { baseUrl: "https://store.example", storeViewCode: "default", integrationToken: "magento_test_secret" };
}

function attachCredential(state: ReturnType<typeof createFakeClient>["state"], connection: any, platform = connection.platform) {
  const credential = {
    id: `credential_${state.credentials.length + 1}`,
    merchantId: connection.merchantId,
    platform: credentialProviderFor(platform),
    credentialType: credentialTypeFor(platform),
    name: `${platform} credential`,
    status: PlatformCredentialStatus.ACTIVE,
    secretRef: `platform-credential-secret:${state.credentials.length + 1}`,
    secretFingerprint: "fingerprint",
    safeMetadata: {
      shop_domain: "demo.myshopify.com",
      site_url: "https://store.example",
      base_url: "https://store.example",
      api_version: platform === StorePlatform.SHOPIFY ? "2025-10" : "wc/v3",
      store_view_code: "default"
    },
    lastUsedAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    rotatedAt: null,
    revokedAt: null
  };
  const stored = testVault.storeSecret(secretForPlatform(platform));
  state.credentials.push(credential);
  state.credentialSecrets.push({
    id: `credential_secret_${state.credentialSecrets.length + 1}`,
    credentialId: credential.id,
    encryptedValue: stored.encryptedValue,
    encryptionVersion: stored.encryptionVersion,
    createdAt: now,
    updatedAt: now
  });
  connection.credentialsRef = `platform-credential:${credential.id}`;
  connection.credentialsMeta = credential.safeMetadata;
  return credential;
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

function readClientReturning(rawOrders: Record<string, unknown>[]): PlatformOrderReadClient {
  return {
    buildReadOrdersRequest() {
      throw new Error("request builder is not needed for injected queue tests");
    },

    async fetchOrdersReadOnly(_context, request) {
      return {
        platform: request.platform,
        rawOrders,
        nextCursor: rawOrders.length ? "next-page" : null,
        hasMore: rawOrders.length > 0,
        requestedLimit: Number(request.limit || 25),
        effectiveLimit: Math.min(Number(request.limit || 25), 50),
        warnings: rawOrders.length ? ["More orders are available. Run the next fetch page to continue."] : [],
        rateLimitWarnings: [],
        retryAfterSeconds: null,
        safeDetails: {
          mockMode: false,
          readOnly: true,
          source: "test-client"
        }
      };
    }
  };
}

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

  it("routes read-only fetch jobs through the platform fetch foundation and creates safe import items", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.SHOPIFY);
    attachCredential(state, connection);
    const created = await createPlatformImportJob("merchant_1", {
      connectionId: connection.id,
      mode: PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER,
      source: PlatformImportSource.POLLING_PLACEHOLDER,
      readOptions: {
        since: "2026-06-08T00:00:00.000Z",
        limit: 99,
        cursor: "first-page"
      },
      orders: []
    }, client);
    assert.equal((state.jobs[0]?.safeSummary as Record<string, any>)?.read_options?.limit, 99);
    const ran = await runPlatformImportJobFoundation("merchant_1", created.job.job_id, client, {
      vault: testVault,
      readClients: {
        [StorePlatform.SHOPIFY]: readClientReturning([shopifyOrder])
      },
      realReadsEnabled: false
    });
    const json = JSON.stringify(ran);
    const summary = ran.job.safe_summary as Record<string, unknown>;

    assert.equal(ran.job.status, PlatformImportJobStatus.COMPLETED_WITH_WARNINGS);
    assert.equal(ran.items.length, 1);
    assert.equal(ran.items[0]?.status, PlatformImportItemStatus.MAPPED);
    assert.equal(state.imports.length, 0);
    assert.equal(summary.fetched_count, 1);
    assert.equal(summary.effective_limit, 50);
    assert.equal(summary.has_more, true);
    assert.equal(summary.next_cursor, "next-page");
    assert.doesNotMatch(json, /9876543210|221 Market Street|shpat_test_secret|secretRef|encryptedValue|rawHeaders|rawResponse|Bigship|providerName/i);
  });

  it("keeps read-only fetch unavailable until a scoped active credential is attached", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.SHOPIFY);
    const created = await createPlatformImportJob("merchant_1", {
      connectionId: connection.id,
      mode: PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER,
      source: PlatformImportSource.POLLING_PLACEHOLDER,
      orders: []
    }, client);
    const ran = await runPlatformImportJobFoundation("merchant_1", created.job.job_id, client, {
      vault: testVault,
      readClients: {
        [StorePlatform.SHOPIFY]: readClientReturning([shopifyOrder])
      },
      realReadsEnabled: false
    });

    assert.equal(ran.job.status, PlatformImportJobStatus.FAILED);
    assert.match(JSON.stringify(ran.job.safe_summary), /Connection is not ready for read-only fetch/i);
    assert.equal(ran.items.length, 0);
  });

  it("deduplicates fetched read-only orders by prior imports and same-job payload hash", async () => {
    const { client, state } = createFakeClient();
    const connection = addConnection(state, StorePlatform.SHOPIFY);
    attachCredential(state, connection);
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
    const nextOrder = { ...shopifyOrder, id: 1002, name: "#1002" };
    const created = await createPlatformImportJob("merchant_1", {
      connectionId: connection.id,
      mode: PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER,
      source: PlatformImportSource.POLLING_PLACEHOLDER,
      orders: []
    }, client);
    const ran = await runPlatformImportJobFoundation("merchant_1", created.job.job_id, client, {
      vault: testVault,
      readClients: {
        [StorePlatform.SHOPIFY]: readClientReturning([shopifyOrder, nextOrder, nextOrder])
      },
      realReadsEnabled: false
    });

    assert.deepEqual(ran.items.map((item) => item.status), [
      PlatformImportItemStatus.DUPLICATE,
      PlatformImportItemStatus.MAPPED,
      PlatformImportItemStatus.DUPLICATE
    ]);
    assert.equal(state.imports.length, 1);
  });
});
