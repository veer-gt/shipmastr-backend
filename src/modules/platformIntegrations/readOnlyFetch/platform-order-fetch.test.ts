import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformCredentialType,
  StorePlatform
} from "@prisma/client";
import { assertReadOnlyRequest } from "./platform-order-fetch.http.js";
import { buildMagentoReadOrdersRequest, createMagentoReadOrderClient } from "./magento-read-order-client.js";
import { fetchPlatformOrdersReadOnly } from "./platform-order-fetch.service.js";
import { buildShopifyReadOrdersRequest, createShopifyReadOrderClient } from "./shopify-read-order-client.js";
import { buildWooCommerceReadOrdersRequest, createWooCommerceReadOrderClient } from "./woocommerce-read-order-client.js";
import type {
  PlatformOrderReadClientContext,
  PlatformReadOrderFetchRequest,
  ReadableStorePlatform
} from "./platform-order-fetch.types.js";
import type { PlatformCredentialVault } from "../credentials/platform-credentials.crypto.js";

const baseRequest: PlatformReadOrderFetchRequest = {
  merchantId: "merchant_1",
  connectionId: "connection_1",
  platform: StorePlatform.SHOPIFY,
  since: new Date("2026-06-08T00:00:00.000Z"),
  limit: 99,
  cursor: null,
  mode: "READ_ONLY_FETCH"
};

function context(platform: ReadableStorePlatform): PlatformOrderReadClientContext {
  if (platform === StorePlatform.SHOPIFY) {
    return {
      platform,
      connectionId: "connection_1",
      storeUrl: "https://demo.myshopify.com",
      safeMetadata: { shop_domain: "demo.myshopify.com", api_version: "2025-10" },
      credentialType: "SHOPIFY_CUSTOM_APP_TOKEN",
      credentialSecret: { shopDomain: "demo.myshopify.com", apiVersion: "2025-10", accessToken: "shpat_read_secret" },
      realReadsEnabled: true
    };
  }
  if (platform === StorePlatform.WOOCOMMERCE) {
    return {
      platform,
      connectionId: "connection_1",
      storeUrl: "https://woo.example",
      safeMetadata: { site_url: "https://woo.example", api_version: "wc/v3" },
      credentialType: "WOOCOMMERCE_REST_KEYS",
      credentialSecret: { siteUrl: "https://woo.example", consumerKey: "ck_read_secret", consumerSecret: "cs_read_secret", apiVersion: "wc/v3" },
      realReadsEnabled: true
    };
  }
  return {
    platform,
    connectionId: "connection_1",
    storeUrl: "https://magento.example",
    safeMetadata: { base_url: "https://magento.example", store_view_code: "default" },
    credentialType: "MAGENTO_INTEGRATION_TOKEN",
    credentialSecret: { baseUrl: "https://magento.example", storeViewCode: "default", integrationToken: "magentotoken_read_secret" },
    realReadsEnabled: true
  };
}

const now = new Date("2026-06-08T00:00:00.000Z");

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

const fetchedShopifyOrder = {
  id: 9001,
  name: "#9001",
  created_at: "2026-06-08T02:00:00.000Z",
  updated_at: "2026-06-08T02:05:00.000Z",
  total_price: "1499.00",
  currency: "INR",
  financial_status: "pending",
  fulfillment_status: null,
  payment_gateway_names: ["Cash on Delivery"],
  email: "asha@example.com",
  shipping_address: {
    name: "Asha Buyer",
    phone: "9876543210",
    address1: "221 Market Street",
    city: "Delhi",
    province: "Delhi",
    zip: "110001",
    country_code: "IN"
  },
  line_items: [{ name: "Kurta", sku: "SKU-1", quantity: 1, price: "1499.00", grams: 250, requires_shipping: true }]
};

function createFetchClient() {
  const stored = testVault.storeSecret({ shopDomain: "demo.myshopify.com", apiVersion: "2025-10", accessToken: "shpat_read_secret" });
  const connection = {
    id: "connection_1",
    merchantId: "merchant_1",
    platform: StorePlatform.SHOPIFY,
    storeName: "Shopify Store",
    storeUrl: "https://demo.myshopify.com",
    status: "ACTIVE",
    syncDirection: "IMPORT_ONLY",
    credentialsRef: "platform-credential:credential_1",
    credentialsMeta: null,
    lastOrderImportAt: null,
    lastTrackingSyncAt: null,
    disabledAt: null,
    createdAt: now,
    updatedAt: now
  };
  return {
    platformConnection: {
      findFirst: async ({ where }: any) => (
        where.id === connection.id && where.merchantId === connection.merchantId ? connection : null
      )
    },
    platformCredential: {
      findFirst: async ({ where }: any) => (
        where.id === "credential_1" && where.merchantId === "merchant_1"
          ? {
            id: "credential_1",
            merchantId: "merchant_1",
            platform: PlatformCredentialProvider.SHOPIFY,
            credentialType: PlatformCredentialType.SHOPIFY_CUSTOM_APP_TOKEN,
            name: "Shopify read key",
            status: PlatformCredentialStatus.ACTIVE,
            secretRef: "platform-credential-secret:credential_1",
            secretFingerprint: "fingerprint",
            safeMetadata: { shop_domain: "demo.myshopify.com", api_version: "2025-10", tokenPrefix: "shpa..." },
            lastUsedAt: null,
            expiresAt: null,
            createdAt: now,
            updatedAt: now,
            rotatedAt: null,
            revokedAt: null
          }
          : null
      )
    },
    platformCredentialSecret: {
      findUnique: async ({ where }: any) => (
        where.credentialId === "credential_1"
          ? {
            id: "credential_secret_1",
            credentialId: "credential_1",
            encryptedValue: stored.encryptedValue,
            encryptionVersion: stored.encryptionVersion,
            createdAt: now,
            updatedAt: now
          }
          : null
      )
    }
  } as any;
}

describe("Phase 21 platform read-only order fetch foundation", () => {
  it("builds Shopify read-order requests only", () => {
    const request = buildShopifyReadOrdersRequest(context(StorePlatform.SHOPIFY), baseRequest);
    const url = new URL(request.url);
    assert.equal(request.method, "GET");
    assert.match(url.pathname, /\/admin\/api\/2025-10\/orders\.json$/);
    assert.equal(url.searchParams.get("limit"), "50");
    assert.equal(url.searchParams.get("updated_at_min"), "2026-06-08T00:00:00.000Z");
    assertReadOnlyRequest(request);
    assert.doesNotMatch(url.pathname, /fulfillment|tracking|webhook/i);
  });

  it("builds WooCommerce read-order requests only", () => {
    const request = buildWooCommerceReadOrdersRequest(context(StorePlatform.WOOCOMMERCE), {
      ...baseRequest,
      platform: StorePlatform.WOOCOMMERCE,
      cursor: "3"
    });
    const url = new URL(request.url);
    assert.equal(request.method, "GET");
    assert.match(url.pathname, /\/wp-json\/wc\/v3\/orders$/);
    assert.equal(url.searchParams.get("page"), "3");
    assert.equal(url.searchParams.get("per_page"), "50");
    assertReadOnlyRequest(request);
    assert.doesNotMatch(url.pathname, /fulfillment|tracking|webhook/i);
  });

  it("builds Magento read-order search requests only", () => {
    const request = buildMagentoReadOrdersRequest(context(StorePlatform.MAGENTO), {
      ...baseRequest,
      platform: StorePlatform.MAGENTO,
      cursor: "2"
    });
    const url = new URL(request.url);
    assert.equal(request.method, "GET");
    assert.match(url.pathname, /\/rest\/default\/V1\/orders$/);
    assert.equal(url.searchParams.get("searchCriteria[currentPage]"), "2");
    assert.equal(url.searchParams.get("searchCriteria[pageSize]"), "50");
    assertReadOnlyRequest(request);
    assert.doesNotMatch(url.pathname, /fulfillment|tracking|webhook/i);
  });

  it("does not call external APIs in mock-safe mode", async () => {
    let calls = 0;
    const result = await createShopifyReadOrderClient().fetchOrdersReadOnly({
      ...context(StorePlatform.SHOPIFY),
      realReadsEnabled: false,
      httpClient: async () => {
        calls += 1;
        throw new Error("should not call");
      }
    }, baseRequest);

    assert.equal(calls, 0);
    assert.equal(result.rawOrders.length, 0);
    assert.equal(result.safeDetails.mockMode, true);
    assert.match(result.warnings.join(" "), /Real reads are disabled/i);
  });

  it("sanitizes pagination and rate-limit metadata without exposing raw headers", async () => {
    const shopify = await createShopifyReadOrderClient().fetchOrdersReadOnly({
      ...context(StorePlatform.SHOPIFY),
      httpClient: async () => ({
        status: 429,
        body: { errors: "slow down" },
        headers: {
          "retry-after": "30",
          "x-shopify-shop-api-call-limit": "39/40"
        }
      })
    }, baseRequest);

    const woo = await createWooCommerceReadOrderClient().fetchOrdersReadOnly({
      ...context(StorePlatform.WOOCOMMERCE),
      httpClient: async () => ({
        status: 200,
        body: [{ id: 1, number: "1" }],
        headers: { "x-wp-totalpages": "2" }
      })
    }, { ...baseRequest, platform: StorePlatform.WOOCOMMERCE, limit: 1, cursor: "1" });

    const magento = await createMagentoReadOrderClient().fetchOrdersReadOnly({
      ...context(StorePlatform.MAGENTO),
      httpClient: async () => ({
        status: 200,
        body: { items: [{ entity_id: 1, increment_id: "1" }], total_count: 2 },
        headers: {}
      })
    }, { ...baseRequest, platform: StorePlatform.MAGENTO, limit: 1, cursor: "1" });

    assert.equal(shopify.retryAfterSeconds, 30);
    assert.equal(shopify.rateLimitWarnings[0], "Platform rate limit reached. Try again later.");
    assert.equal(woo.nextCursor, "2");
    assert.equal(magento.nextCursor, "2");
    const json = JSON.stringify({ shopify, woo, magento });
    assert.doesNotMatch(json, /x-shopify-shop-api-call-limit|Authorization|Bearer|shpat_read_secret|cs_read_secret|magentotoken_read_secret/i);
  });

  it("uses vaulted credentials internally and returns only safe fetched order previews", async () => {
    let readCalled = false;
    const result = await fetchPlatformOrdersReadOnly({
      merchantId: "merchant_1",
      connectionId: "connection_1",
      platform: StorePlatform.SHOPIFY,
      limit: 10,
      cursor: null,
      mode: "READ_ONLY_FETCH"
    }, {
      client: createFetchClient(),
      vault: testVault,
      readClients: {
        [StorePlatform.SHOPIFY]: {
          buildReadOrdersRequest() {
            throw new Error("not used");
          },
          async fetchOrdersReadOnly(context, request) {
            readCalled = true;
            assert.equal((context.credentialSecret as Record<string, unknown>).accessToken, "shpat_read_secret");
            return {
              platform: request.platform,
              rawOrders: [fetchedShopifyOrder],
              nextCursor: "cursor-2",
              hasMore: true,
              requestedLimit: 10,
              effectiveLimit: 10,
              warnings: [],
              rateLimitWarnings: [],
              retryAfterSeconds: null,
              safeDetails: { mockMode: false, readOnly: true, rawHeaders: { authorization: "Bearer secret" } }
            };
          }
        }
      },
      realReadsEnabled: false
    });
    const json = JSON.stringify({
      ...result,
      rawOrders: undefined
    });

    assert.equal(readCalled, true);
    assert.equal(result.orders.length, 1);
    assert.equal(result.orders[0]?.externalOrderId, "9001");
    assert.equal(result.orders[0]?.buyerPreview?.phoneMasked, "***3210");
    assert.equal(result.orders[0]?.buyerPreview?.emailMasked, "a***@example.com");
    assert.equal(result.orders[0]?.codDetected, true);
    assert.doesNotMatch(json, /shpat_read_secret|Bearer secret|9876543210|221 Market Street|rawHeaders|secretRef|encryptedValue|providerName|Bigship/i);
  });
});
