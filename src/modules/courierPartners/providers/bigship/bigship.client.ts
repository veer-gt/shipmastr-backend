import { BigshipConfigError, BigshipProviderError } from "./bigship.errors.js";
import type {
  BigshipCancelOrderRequest,
  BigshipCancelOrderResponse,
  BigshipCourierRateRequest,
  BigshipCourierRateResponse,
  BigshipDomesticB2COrderRequest,
  BigshipDomesticB2COrderResponse,
  BigshipLoginRequest,
  BigshipLoginResponse,
  BigshipPlaceOrderRequest,
  BigshipPlaceOrderResponse,
  BigshipSaveWarehouseRequest,
  BigshipSaveWarehouseResponse,
  BigshipTrackingRequest,
  BigshipTrackingResponse
} from "./bigship.types.js";

export type BigshipClientConfig = {
  baseUrl?: string;
  username?: string | undefined;
  password?: string | undefined;
  accessKey?: string | undefined;
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
const DEFAULT_TIMEOUT_MS = 8000;

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

function defaultFetch(): BigshipFetch {
  return async (url, init) => {
    if (typeof fetch !== "function") {
      throw new BigshipConfigError("Courier provider HTTP runtime is unavailable.");
    }

    return fetch(url, init as RequestInit);
  };
}

export function bigshipClientConfigFromEnv(source: NodeJS.ProcessEnv = process.env): BigshipClientConfig {
  return {
    baseUrl: source.BIGSHIP_BASE_URL ?? DEFAULT_BASE_URL,
    username: source.BIGSHIP_USERNAME,
    password: source.BIGSHIP_PASSWORD,
    accessKey: source.BIGSHIP_ACCESS_KEY,
    enabled: boolFromEnv(source.BIGSHIP_ENABLED, false),
    mockMode: boolFromEnv(source.BIGSHIP_MOCK_MODE, true)
  };
}

export class BigshipClient {
  private readonly baseUrl: string;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly accessKey: string | undefined;
  private readonly enabled: boolean;
  private readonly mockMode: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: BigshipFetch;

  constructor(config: BigshipClientConfig = {}, fetchImpl: BigshipFetch = defaultFetch()) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.username = config.username;
    this.password = config.password;
    this.accessKey = config.accessKey;
    this.enabled = config.enabled ?? false;
    this.mockMode = config.mockMode ?? true;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl;
  }

  private assertRealModeAllowed() {
    if (this.mockMode) return;

    if (!this.enabled) {
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

    return this.requestJson<BigshipLoginResponse>("/api/login", {
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

    return this.requestJson<BigshipSaveWarehouseResponse>("/api/warehouse/save", {
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

    return this.requestJson<BigshipDomesticB2COrderResponse>("/api/orders/domestic-b2c", {
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

    return this.requestJson<BigshipCourierRateResponse>("/api/rates", {
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

    return this.requestJson<BigshipPlaceOrderResponse>("/api/orders/place", {
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

    return this.requestJson<BigshipTrackingResponse>("/api/track", {
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

    return this.requestJson<BigshipCancelOrderResponse>("/api/orders/cancel", {
      method: "POST",
      token,
      body: input
    });
  }
}
