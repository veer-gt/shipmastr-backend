import { StorePlatform } from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { PLATFORM_READ_ERRORS } from "./platform-order-fetch.errors.js";
import { defaultPlatformReadHttpClient, PLATFORM_READ_TIMEOUT_MS, retryAfterSeconds } from "./platform-order-fetch.http.js";
import type {
  PlatformOrderReadClient,
  PlatformOrderReadClientContext,
  PlatformReadOrderFetchRequest
} from "./platform-order-fetch.types.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

function effectiveLimit(value: number | null | undefined) {
  const requested = Math.max(1, Math.floor(Number(value || DEFAULT_LIMIT)));
  return Math.min(requested, MAX_LIMIT);
}

function secretRecord(context: PlatformOrderReadClientContext) {
  return (context.credentialSecret && typeof context.credentialSecret === "object")
    ? context.credentialSecret as Record<string, unknown>
    : {};
}

function shopDomain(context: PlatformOrderReadClientContext) {
  const secret = secretRecord(context);
  return String(secret.shopDomain || context.safeMetadata?.shop_domain || context.storeUrl || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

function apiVersion(context: PlatformOrderReadClientContext) {
  const secret = secretRecord(context);
  return String(secret.apiVersion || context.safeMetadata?.api_version || "2025-10");
}

function accessToken(context: PlatformOrderReadClientContext) {
  return String(secretRecord(context).accessToken || "");
}

function pageInfoFromLinkHeader(value: string | undefined) {
  if (!value) return null;
  const next = value.split(",").find((part) => /rel="?next"?/i.test(part));
  const match = next?.match(/[?&]page_info=([^&>]+)/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function buildShopifyReadOrdersRequest(context: PlatformOrderReadClientContext, request: PlatformReadOrderFetchRequest) {
  const domain = shopDomain(context);
  const token = accessToken(context);
  if (!domain || !token) throw new HttpError(409, PLATFORM_READ_ERRORS.CONNECTION_NOT_READY);
  const url = new URL(`https://${domain}/admin/api/${apiVersion(context)}/orders.json`);
  url.searchParams.set("status", "any");
  url.searchParams.set("limit", String(effectiveLimit(request.limit)));
  if (request.since) url.searchParams.set("updated_at_min", request.since.toISOString());
  if (request.cursor) url.searchParams.set("page_info", request.cursor);
  return {
    method: "GET" as const,
    url: url.toString(),
    headers: {
      "X-Shopify-Access-Token": token,
      "Accept": "application/json"
    },
    timeoutMs: PLATFORM_READ_TIMEOUT_MS
  };
}

export function createShopifyReadOrderClient(): PlatformOrderReadClient {
  return {
    buildReadOrdersRequest(context, request) {
      return buildShopifyReadOrdersRequest(context, request);
    },

    async fetchOrdersReadOnly(context, request) {
      const requestedLimit = Math.max(1, Math.floor(Number(request.limit || DEFAULT_LIMIT)));
      const limit = effectiveLimit(request.limit);
      if (!context.realReadsEnabled) {
        return {
          platform: StorePlatform.SHOPIFY,
          rawOrders: [],
          nextCursor: null,
          hasMore: false,
          requestedLimit,
          effectiveLimit: limit,
          warnings: ["Read-only Shopify order fetch is running in mock-safe mode. Real reads are disabled in this environment."],
          rateLimitWarnings: [],
          retryAfterSeconds: null,
          safeDetails: {
            mockMode: true,
            readOnly: true,
            platform: StorePlatform.SHOPIFY,
            requestedLimit,
            effectiveLimit: limit
          }
        };
      }
      const requestConfig = buildShopifyReadOrdersRequest(context, request);
      const http = context.httpClient ?? defaultPlatformReadHttpClient;
      const response = await http(requestConfig);
      if (response.status === 429) {
        return {
          platform: StorePlatform.SHOPIFY,
          rawOrders: [],
          nextCursor: null,
          hasMore: false,
          requestedLimit,
          effectiveLimit: limit,
          warnings: ["Platform rate limit reached. Try again later."],
          rateLimitWarnings: ["Platform rate limit reached. Try again later."],
          retryAfterSeconds: retryAfterSeconds(response.headers),
          safeDetails: {
            mockMode: false,
            readOnly: true,
            platform: StorePlatform.SHOPIFY,
            requestedLimit,
            effectiveLimit: limit
          }
        };
      }
      if (response.status < 200 || response.status >= 300) {
        throw new HttpError(502, PLATFORM_READ_ERRORS.REQUEST_FAILED);
      }
      const body = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
      const orders = Array.isArray(body.orders) ? body.orders.filter((order): order is Record<string, unknown> => Boolean(order && typeof order === "object" && !Array.isArray(order))) : [];
      const nextCursor = pageInfoFromLinkHeader(response.headers?.link);
      return {
        platform: StorePlatform.SHOPIFY,
        rawOrders: orders,
        nextCursor,
        hasMore: Boolean(nextCursor),
        requestedLimit,
        effectiveLimit: limit,
        warnings: nextCursor ? ["More orders are available. Run the next fetch page to continue."] : [],
        rateLimitWarnings: [],
        retryAfterSeconds: null,
        safeDetails: {
          mockMode: false,
          readOnly: true,
          platform: StorePlatform.SHOPIFY,
          requestedLimit,
          effectiveLimit: limit,
          hasMore: Boolean(nextCursor)
        }
      };
    }
  };
}
