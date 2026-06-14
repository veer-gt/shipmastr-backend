import { BigshipConfigError, BigshipProviderError } from "./bigship.errors.js";
import type {
  BigshipCancelOrderRequest,
  BigshipCancelOrderResponse,
  BigshipCourierRateRequest,
  BigshipCourierRateResponse,
  BigshipDomesticB2COrderRequest,
  BigshipDomesticB2COrderResponse,
  BigshipGetLabelRequest,
  BigshipGetLabelResponse,
  BigshipLoginRequest,
  BigshipLoginResponse,
  BigshipPlaceOrderRequest,
  BigshipPlaceOrderResponse,
  BigshipSaveWarehouseRequest,
  BigshipSaveWarehouseResponse,
  BigshipTrackingRequest,
  BigshipTrackingResponse
} from "./bigship.types.js";

export type BigshipMode = "mock" | "sandbox" | "live";

export type BigshipClientConfig = {
  mode?: BigshipMode;
  baseUrl?: string;
  username?: string | undefined;
  password?: string | undefined;
  accessKey?: string | undefined;
  apiKey?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  enableRealCalls?: boolean;
  enabled?: boolean;
  mockMode?: boolean;
  timeoutMs?: number;
};

export type BigshipFetchInit = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type BigshipFetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type BigshipFetch = (url: string, init: BigshipFetchInit) => Promise<BigshipFetchResponse>;

const DEFAULT_BASE_URL = "https://api.bigship.direct/";
const DEFAULT_TIMEOUT_MS = 15_000;

const BIGSHIP_ENDPOINTS = {
  // TODO: Confirm endpoint paths against official provider docs before live mode is enabled.
  login: "/api/login",
  saveWarehouse: "/api/warehouse/save",
  createDomesticB2COrder: "/api/orders/domestic-b2c",
  rates: "/api/rates",
  placeOrder: "/api/orders/place",
  label: "/api/orders/label",
  tracking: "/api/track",
  cancel: "/api/orders/cancel"
} as const;

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function boolFromEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return fallback;
}

function modeFromEnv(value: string | undefined): BigshipMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "live") return normalized;
  return "mock";
}

function intFromEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultFetch(): BigshipFetch {
  return async (url, init) => {
    if (typeof fetch !== "function") {
      throw new BigshipConfigError("Courier provider HTTP runtime is unavailable.");
    }

    return fetch(url, init as RequestInit);
  };
}

export function bigshipClientConfigFromEnv(source: NodeJS.ProcessEnv = process.env): BigshipClientConfig {
  const mode = modeFromEnv(source.BIGSHIP_MODE);
  const enableRealCalls = boolFromEnv(
    source.BIGSHIP_ENABLE_REAL_CALLS,
    boolFromEnv(source.BIGSHIP_ENABLED, false)
  );

  return {
    mode,
    baseUrl: source.BIGSHIP_BASE_URL ?? DEFAULT_BASE_URL,
    username: source.BIGSHIP_USERNAME ?? source.BIGSHIP_CLIENT_ID,
    password: source.BIGSHIP_PASSWORD ?? source.BIGSHIP_CLIENT_SECRET,
    accessKey: source.BIGSHIP_ACCESS_KEY ?? source.BIGSHIP_API_KEY,
    apiKey: source.BIGSHIP_API_KEY,
    clientId: source.BIGSHIP_CLIENT_ID,
    clientSecret: source.BIGSHIP_CLIENT_SECRET,
    enableRealCalls,
    enabled: enableRealCalls,
    mockMode: mode === "mock" ? true : boolFromEnv(source.BIGSHIP_MOCK_MODE, false),
    timeoutMs: intFromEnv(source.BIGSHIP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  };
}

export class BigshipClient {
  private readonly baseUrl: string;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly accessKey: string | undefined;
  private readonly enableRealCalls: boolean;
  private readonly mockMode: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: BigshipFetch;

  constructor(config: BigshipClientConfig = {}, fetchImpl: BigshipFetch = defaultFetch()) {
    const mode = config.mode ?? (config.mockMode === false ? "sandbox" : "mock");
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.username = config.username ?? config.clientId;
    this.password = config.password ?? config.clientSecret;
    this.accessKey = config.accessKey ?? config.apiKey;
    this.enableRealCalls = config.enableRealCalls ?? config.enabled ?? false;
    this.mockMode = config.mockMode ?? mode === "mock";
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl;
  }

  private assertRealModeAllowed() {
    if (this.mockMode) return;

    if (!this.enableRealCalls) {
      throw new BigshipConfigError("Courier provider is disabled.");
    }

    if (!this.username || !this.password || !this.accessKey) {
      throw new BigshipConfigError("Courier provider credentials are incomplete.");
    }
  }

  private async requestJson<T>(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      token?: string;
    }
  ): Promise<T> {
    this.assertRealModeAllowed();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;

    const init: BigshipFetchInit = {
      method: options.method,
      headers,
      signal: controller.signal
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      if (!response.ok) {
        throw new BigshipProviderError({
          code: "COURIER_PROVIDER_HTTP_ERROR",
          message: "Courier provider request failed.",
          statusCode: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500
        });
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async login(): Promise<BigshipLoginResponse> {
    if (this.mockMode) {
      return {
        token: "mock_internal_token_001",
        expires_in: 3600,
        success: true,
        message: "Mock login ok."
      };
    }

    const request: BigshipLoginRequest = {
      username: this.username ?? "",
      password: this.password ?? "",
      access_key: this.accessKey ?? ""
    };

    return this.requestJson<BigshipLoginResponse>(BIGSHIP_ENDPOINTS.login, {
      method: "POST",
      body: request
    });
  }

  async saveWarehouse(input: BigshipSaveWarehouseRequest, token: string): Promise<BigshipSaveWarehouseResponse> {
    if (this.mockMode) {
      return {
        warehouseId: "mock_provider_pickup_001",
        status: "active",
        message: `Mock pickup saved for ${input.pincode}.`
      };
    }

    return this.requestJson<BigshipSaveWarehouseResponse>(BIGSHIP_ENDPOINTS.saveWarehouse, {
      method: "POST",
      token,
      body: input
    });
  }

  async createDomesticB2COrder(
    input: BigshipDomesticB2COrderRequest,
    token: string
  ): Promise<BigshipDomesticB2COrderResponse> {
    if (this.mockMode) {
      return {
        order_id: "mock_provider_order_001",
        reference_number: `mock_ref_${input.MasterCustomOrderId}`,
        status: "draft",
        message: "Mock draft shipment created."
      };
    }

    return this.requestJson<BigshipDomesticB2COrderResponse>(BIGSHIP_ENDPOINTS.createDomesticB2COrder, {
      method: "POST",
      token,
      body: input
    });
  }

  async getRates(input: BigshipCourierRateRequest, token: string): Promise<BigshipCourierRateResponse> {
    if (this.mockMode) {
      return {
        rates: [
          {
            courierId: "mock_courier_economy",
            courierName: "Internal Economy",
            total_charge: 84,
            base_freight: 70,
            cod_charge: input.payment_mode === "cod" ? 12 : 0,
            tax: 2,
            charged_weight: Math.max(input.weight_kg, 0.5),
            tat_days: 5
          },
          {
            courierId: "mock_courier_smart",
            courierName: "Internal Smart",
            total_charge: 104,
            base_freight: 90,
            cod_charge: input.payment_mode === "cod" ? 12 : 0,
            tax: 2,
            charged_weight: Math.max(input.weight_kg, 0.5),
            tat_days: 3,
            recommended: true
          },
          {
            courierId: "mock_courier_express",
            courierName: "Internal Express",
            total_charge: 139,
            base_freight: 125,
            cod_charge: input.payment_mode === "cod" ? 12 : 0,
            tax: 2,
            charged_weight: Math.max(input.weight_kg, 0.5),
            tat_days: 1
          }
        ],
        status: "ok",
        message: "Mock rates fetched."
      };
    }

    return this.requestJson<BigshipCourierRateResponse>(BIGSHIP_ENDPOINTS.rates, {
      method: "POST",
      token,
      body: input
    });
  }

  async placeOrder(input: BigshipPlaceOrderRequest, token: string): Promise<BigshipPlaceOrderResponse> {
    if (this.mockMode) {
      return {
        awb_assigned: "mock_awb_001",
        tracking_number: "mock_awb_001",
        reference_number: `mock_manifest_${input.order_id}`,
        status: "manifested",
        message: "Mock shipment manifested."
      };
    }

    return this.requestJson<BigshipPlaceOrderResponse>(BIGSHIP_ENDPOINTS.placeOrder, {
      method: "POST",
      token,
      body: input
    });
  }

  async getLabel(input: BigshipGetLabelRequest, token: string): Promise<BigshipGetLabelResponse> {
    if (this.mockMode) {
      const key = input.shipment_id ?? input.order_id ?? input.awb ?? input.tracking_number ?? "shipment";
      const safeKey = encodeURIComponent(String(key).replace(/[^a-z0-9_-]/gi, "").slice(-32) || "shipment");
      const awb = input.awb ?? input.tracking_number ?? "mock_awb_001";
      return {
        label_url: `https://labels.shipmastr.local/mock/${safeKey}.pdf`,
        tracking_url: `https://track.shipmastr.local/${encodeURIComponent(awb)}`,
        status: "label_generated",
        message: "Mock label generated."
      };
    }

    return this.requestJson<BigshipGetLabelResponse>(BIGSHIP_ENDPOINTS.label, {
      method: "POST",
      token,
      body: input
    });
  }

  async trackOrder(input: BigshipTrackingRequest, token: string): Promise<BigshipTrackingResponse> {
    if (this.mockMode) {
      const awb = input.awb ?? input.tracking_number ?? "mock_awb_001";
      return {
        awb,
        tracking_number: awb,
        status: "in_transit",
        latest_event: "Shipment is moving through the courier network.",
        events: [{
          status: "manifested",
          public_status: "Ready to ship",
          location: "Origin",
          message: "Shipment manifested.",
          checkpoint_time: "2026-06-06T09:00:00.000Z"
        }, {
          status: "in_transit",
          public_status: "In transit",
          location: "Transit hub",
          message: "Shipment is moving through the courier network.",
          checkpoint_time: "2026-06-06T12:00:00.000Z"
        }]
      };
    }

    return this.requestJson<BigshipTrackingResponse>(BIGSHIP_ENDPOINTS.tracking, {
      method: "POST",
      token,
      body: input
    });
  }

  async cancelOrder(input: BigshipCancelOrderRequest, token: string): Promise<BigshipCancelOrderResponse> {
    if (this.mockMode) {
      return {
        cancelled: true,
        status: "cancelled",
        message: "Mock shipment cancelled."
      };
    }

    return this.requestJson<BigshipCancelOrderResponse>(BIGSHIP_ENDPOINTS.cancel, {
      method: "POST",
      token,
      body: input
    });
  }
}
