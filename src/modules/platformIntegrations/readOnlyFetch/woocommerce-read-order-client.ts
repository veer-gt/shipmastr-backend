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

function siteUrl(context: PlatformOrderReadClientContext) {
  return String(secretRecord(context).siteUrl || context.safeMetadata?.site_url || context.storeUrl || "").replace(/\/$/, "");
}

function apiVersion(context: PlatformOrderReadClientContext) {
  return String(secretRecord(context).apiVersion || context.safeMetadata?.api_version || "wc/v3").replace(/^\/+|\/+$/g, "");
}

function consumerKey(context: PlatformOrderReadClientContext) {
  return String(secretRecord(context).consumerKey || "");
}

function consumerSecret(context: PlatformOrderReadClientContext) {
  return String(secretRecord(context).consumerSecret || "");
}

function cursorPage(value: string | null | undefined) {
  const page = Number(value || 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function hasMoreFromHeaders(headers: Record<string, string | undefined> | undefined, currentPage: number) {
  const totalPages = Number(headers?.["x-wp-totalpages"]);
  return Number.isFinite(totalPages) && totalPages > currentPage;
}

export function buildWooCommerceReadOrdersRequest(context: PlatformOrderReadClientContext, request: PlatformReadOrderFetchRequest) {
  const base = siteUrl(context);
  const key = consumerKey(context);
  const secret = consumerSecret(context);
  if (!base || !key || !secret) throw new HttpError(409, PLATFORM_READ_ERRORS.CONNECTION_NOT_READY);
  const url = new URL(`${base}/wp-json/${apiVersion(context)}/orders`);
  const page = cursorPage(request.cursor);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(effectiveLimit(request.limit)));
  url.searchParams.set("orderby", "modified");
  url.searchParams.set("order", "desc");
  if (request.since) url.searchParams.set("modified_after", request.since.toISOString());
  return {
    method: "GET" as const,
    url: url.toString(),
    headers: {
      "Authorization": `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
      "Accept": "application/json"
    },
    timeoutMs: PLATFORM_READ_TIMEOUT_MS
  };
}

export function createWooCommerceReadOrderClient(): PlatformOrderReadClient {
  return {
    buildReadOrdersRequest(context, request) {
      return buildWooCommerceReadOrdersRequest(context, request);
    },

    async fetchOrdersReadOnly(context, request) {
      const requestedLimit = Math.max(1, Math.floor(Number(request.limit || DEFAULT_LIMIT)));
      const limit = effectiveLimit(request.limit);
      const page = cursorPage(request.cursor);
      if (!context.realReadsEnabled) {
        return {
          platform: StorePlatform.WOOCOMMERCE,
          rawOrders: [],
          nextCursor: null,
          hasMore: false,
          requestedLimit,
          effectiveLimit: limit,
          warnings: ["Read-only WooCommerce order fetch is running in mock-safe mode. Real reads are disabled in this environment."],
          rateLimitWarnings: [],
          retryAfterSeconds: null,
          safeDetails: {
            mockMode: true,
            readOnly: true,
            platform: StorePlatform.WOOCOMMERCE,
            requestedLimit,
            effectiveLimit: limit,
            page
          }
        };
      }
      const requestConfig = buildWooCommerceReadOrdersRequest(context, request);
      const http = context.httpClient ?? defaultPlatformReadHttpClient;
      const response = await http(requestConfig);
      if (response.status === 429) {
        return {
          platform: StorePlatform.WOOCOMMERCE,
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
            platform: StorePlatform.WOOCOMMERCE,
            requestedLimit,
            effectiveLimit: limit,
            page
          }
        };
      }
      if (response.status < 200 || response.status >= 300) {
        throw new HttpError(502, PLATFORM_READ_ERRORS.REQUEST_FAILED);
      }
      const orders = Array.isArray(response.body)
        ? response.body.filter((order): order is Record<string, unknown> => Boolean(order && typeof order === "object" && !Array.isArray(order)))
        : [];
      const hasMore = hasMoreFromHeaders(response.headers, page);
      return {
        platform: StorePlatform.WOOCOMMERCE,
        rawOrders: orders,
        nextCursor: hasMore ? String(page + 1) : null,
        hasMore,
        requestedLimit,
        effectiveLimit: limit,
        warnings: hasMore ? ["More orders are available. Run the next fetch page to continue."] : [],
        rateLimitWarnings: [],
        retryAfterSeconds: null,
        safeDetails: {
          mockMode: false,
          readOnly: true,
          platform: StorePlatform.WOOCOMMERCE,
          requestedLimit,
          effectiveLimit: limit,
          page,
          hasMore
        }
      };
    }
  };
}
