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

function baseUrl(context: PlatformOrderReadClientContext) {
  return String(secretRecord(context).baseUrl || context.safeMetadata?.base_url || context.storeUrl || "").replace(/\/$/, "");
}

function storeViewCode(context: PlatformOrderReadClientContext) {
  return String(secretRecord(context).storeViewCode || context.safeMetadata?.store_view_code || "default").replace(/^\/+|\/+$/g, "") || "default";
}

function integrationToken(context: PlatformOrderReadClientContext) {
  return String(secretRecord(context).integrationToken || "");
}

function cursorPage(value: string | null | undefined) {
  const page = Number(value || 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

export function buildMagentoReadOrdersRequest(context: PlatformOrderReadClientContext, request: PlatformReadOrderFetchRequest) {
  const base = baseUrl(context);
  const token = integrationToken(context);
  if (!base || !token) throw new HttpError(409, PLATFORM_READ_ERRORS.CONNECTION_NOT_READY);
  const page = cursorPage(request.cursor);
  const url = new URL(`${base}/rest/${storeViewCode(context)}/V1/orders`);
  url.searchParams.set("searchCriteria[currentPage]", String(page));
  url.searchParams.set("searchCriteria[pageSize]", String(effectiveLimit(request.limit)));
  url.searchParams.set("searchCriteria[sortOrders][0][field]", "updated_at");
  url.searchParams.set("searchCriteria[sortOrders][0][direction]", "DESC");
  if (request.since) {
    url.searchParams.set("searchCriteria[filterGroups][0][filters][0][field]", "updated_at");
    url.searchParams.set("searchCriteria[filterGroups][0][filters][0][value]", request.since.toISOString());
    url.searchParams.set("searchCriteria[filterGroups][0][filters][0][conditionType]", "from");
  }
  return {
    method: "GET" as const,
    url: url.toString(),
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json"
    },
    timeoutMs: PLATFORM_READ_TIMEOUT_MS
  };
}

export function createMagentoReadOrderClient(): PlatformOrderReadClient {
  return {
    buildReadOrdersRequest(context, request) {
      return buildMagentoReadOrdersRequest(context, request);
    },

    async fetchOrdersReadOnly(context, request) {
      const requestedLimit = Math.max(1, Math.floor(Number(request.limit || DEFAULT_LIMIT)));
      const limit = effectiveLimit(request.limit);
      const page = cursorPage(request.cursor);
      if (!context.realReadsEnabled) {
        return {
          platform: StorePlatform.MAGENTO,
          rawOrders: [],
          nextCursor: null,
          hasMore: false,
          requestedLimit,
          effectiveLimit: limit,
          warnings: ["Read-only Magento order fetch is running in mock-safe mode. Real reads are disabled in this environment."],
          rateLimitWarnings: [],
          retryAfterSeconds: null,
          safeDetails: {
            mockMode: true,
            readOnly: true,
            platform: StorePlatform.MAGENTO,
            requestedLimit,
            effectiveLimit: limit,
            page
          }
        };
      }
      const requestConfig = buildMagentoReadOrdersRequest(context, request);
      const http = context.httpClient ?? defaultPlatformReadHttpClient;
      const response = await http(requestConfig);
      if (response.status === 429) {
        return {
          platform: StorePlatform.MAGENTO,
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
            platform: StorePlatform.MAGENTO,
            requestedLimit,
            effectiveLimit: limit,
            page
          }
        };
      }
      if (response.status < 200 || response.status >= 300) {
        throw new HttpError(502, PLATFORM_READ_ERRORS.REQUEST_FAILED);
      }
      const body = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
      const orders = Array.isArray(body.items) ? body.items.filter((order): order is Record<string, unknown> => Boolean(order && typeof order === "object" && !Array.isArray(order))) : [];
      const total = Number(body.total_count || 0);
      const hasMore = total > page * limit;
      return {
        platform: StorePlatform.MAGENTO,
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
          platform: StorePlatform.MAGENTO,
          requestedLimit,
          effectiveLimit: limit,
          page,
          hasMore
        }
      };
    }
  };
}
