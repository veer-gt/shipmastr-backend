import type { StorePlatform } from "@prisma/client";
import type { NormalizedPlatformOrder } from "../platform-types.js";

export type ReadableStorePlatform = Extract<StorePlatform, "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO">;

export type PlatformReadOrderFetchRequest = {
  merchantId: string;
  connectionId: string;
  platform: ReadableStorePlatform;
  since?: Date | null;
  limit?: number | null;
  cursor?: string | null;
  mode: "READ_ONLY_FETCH";
};

export type PlatformFetchedOrderPreview = {
  platform: ReadableStorePlatform;
  externalOrderId: string;
  externalOrderName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
  currency?: string | null;
  totalAmount?: number | null;
  codDetected?: boolean;
  buyerPreview?: {
    name?: string | null;
    phoneMasked?: string | null;
    emailMasked?: string | null;
    city?: string | null;
    state?: string | null;
    pincode?: string | null;
    country?: string | null;
  };
  lineItemPreview?: Array<{
    name?: string | null;
    quantity?: number | null;
    sku?: string | null;
    weightGrams?: number | null;
  }>;
  mappingWarnings: string[];
  safePayloadHash: string;
};

export type PlatformReadOrderFetchResult = {
  platform: ReadableStorePlatform;
  connectionId: string;
  fetchedCount: number;
  nextCursor?: string | null;
  hasMore: boolean;
  orders: PlatformFetchedOrderPreview[];
  rawOrders: Record<string, unknown>[];
  warnings: string[];
  requestedLimit: number;
  effectiveLimit: number;
  rateLimitWarnings: string[];
  retryAfterSeconds?: number | null;
  safeDetails: Record<string, unknown>;
};

export type PlatformReadHttpRequest = {
  method: "GET";
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
};

export type PlatformReadHttpResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string | undefined>;
};

export type PlatformReadHttpClient = (request: PlatformReadHttpRequest) => Promise<PlatformReadHttpResponse>;

export type PlatformOrderReadClientContext = {
  platform: ReadableStorePlatform;
  connectionId: string;
  storeUrl: string;
  storeName?: string | null;
  safeMetadata?: Record<string, unknown> | null;
  credentialType?: string | null;
  credentialSecret?: unknown;
  realReadsEnabled: boolean;
  httpClient?: PlatformReadHttpClient;
};

export type PlatformRawOrderFetchResult = {
  platform: ReadableStorePlatform;
  rawOrders: Record<string, unknown>[];
  nextCursor?: string | null;
  hasMore: boolean;
  requestedLimit: number;
  effectiveLimit: number;
  warnings: string[];
  rateLimitWarnings: string[];
  retryAfterSeconds?: number | null;
  safeDetails: Record<string, unknown>;
};

export type PlatformOrderReadClient = {
  buildReadOrdersRequest(context: PlatformOrderReadClientContext, request: PlatformReadOrderFetchRequest): PlatformReadHttpRequest;
  fetchOrdersReadOnly(context: PlatformOrderReadClientContext, request: PlatformReadOrderFetchRequest): Promise<PlatformRawOrderFetchResult>;
};

export type PlatformNormalizedFetchedOrder = {
  normalized: NormalizedPlatformOrder;
  preview: PlatformFetchedOrderPreview;
};
