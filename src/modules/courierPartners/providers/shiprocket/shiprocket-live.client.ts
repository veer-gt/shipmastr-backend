import { env } from "../../../../config/env.js";
import type { ShiprocketLiveCredentials } from "./shiprocket-live-credentials.js";

export type ShiprocketLiveFetchInit = {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

export type ShiprocketLiveFetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type ShiprocketLiveFetch = (
  url: string,
  init: ShiprocketLiveFetchInit
) => Promise<ShiprocketLiveFetchResponse>;

export type ShiprocketLiveClientConfig = {
  baseUrl?: string;
  timeoutMs?: number;
};

export type ShiprocketLoginResponse = {
  token?: string;
  expires_in?: number;
  expiresIn?: number;
};

export type ShiprocketCreateOrderRequest = Record<string, unknown>;
export type ShiprocketCreateOrderResponse = Record<string, unknown>;

export type ShiprocketAssignAwbRequest = {
  shipment_id: string | number;
  courier_id: string | number;
};
export type ShiprocketAssignAwbResponse = Record<string, unknown>;

export type ShiprocketGenerateLabelRequest = {
  shipment_id: Array<string | number>;
};
export type ShiprocketGenerateLabelResponse = Record<string, unknown>;

export type ShiprocketServiceabilityRequest = {
  pickup_postcode: string;
  delivery_postcode: string;
  weight: number;
  cod: 0 | 1;
  declared_value?: number;
};
export type ShiprocketServiceabilityResponse = Record<string, unknown>;

export class ShiprocketLiveConfigError extends Error {
  constructor(message = "Courier provider live configuration is incomplete.") {
    super(message);
    this.name = "ShiprocketLiveConfigError";
  }
}

export class ShiprocketLiveProviderError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(input: { code: string; statusCode?: number; retryable?: boolean }) {
    super("Courier provider live request failed.");
    this.name = "ShiprocketLiveProviderError";
    this.code = input.code;
    if (input.statusCode !== undefined) this.statusCode = input.statusCode;
    this.retryable = input.retryable ?? true;
  }
}

function normalizeBaseUrl(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function defaultFetch(): ShiprocketLiveFetch {
  if (typeof fetch !== "function") {
    return async () => {
      throw new ShiprocketLiveConfigError("Courier provider HTTP runtime is unavailable.");
    };
  }
  return async (url, init) => {
    const response = await fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json()
    };
  };
}

export function shiprocketLiveClientConfigFromEnv(
  source: Record<string, unknown> = env
): ShiprocketLiveClientConfig {
  return {
    baseUrl: typeof source.SHIPROCKET_BASE_URL === "string" && source.SHIPROCKET_BASE_URL.trim()
      ? source.SHIPROCKET_BASE_URL.trim()
      : env.SHIPROCKET_BASE_URL,
    timeoutMs: 15000
  };
}

export class ShiprocketLiveClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: ShiprocketLiveFetch;

  constructor(
    config: ShiprocketLiveClientConfig = {},
    fetchImpl: ShiprocketLiveFetch = defaultFetch()
  ) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? env.SHIPROCKET_BASE_URL);
    this.fetchImpl = fetchImpl;
  }

  private async requestJson<T>(
    path: string,
    init: ShiprocketLiveFetchInit,
    expectedFailureCode: string
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new ShiprocketLiveProviderError({
        code: expectedFailureCode,
        statusCode: response.status,
        retryable: response.status >= 500 || response.status === 429
      });
    }
    return body as T;
  }

  login(credentials: ShiprocketLiveCredentials): Promise<ShiprocketLoginResponse> {
    return this.requestJson<ShiprocketLoginResponse>("/v1/external/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password
      })
    }, "SHIPROCKET_AUTH_FAILED");
  }

  createAdhocOrder(input: ShiprocketCreateOrderRequest, token: string): Promise<ShiprocketCreateOrderResponse> {
    return this.requestJson<ShiprocketCreateOrderResponse>("/v1/external/orders/create/adhoc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(input)
    }, "SHIPROCKET_ORDER_CREATE_FAILED");
  }

  assignAwb(input: ShiprocketAssignAwbRequest, token: string): Promise<ShiprocketAssignAwbResponse> {
    return this.requestJson<ShiprocketAssignAwbResponse>("/v1/external/courier/assign/awb", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(input)
    }, "SHIPROCKET_AWB_ASSIGN_FAILED");
  }

  generateLabel(input: ShiprocketGenerateLabelRequest, token: string): Promise<ShiprocketGenerateLabelResponse> {
    return this.requestJson<ShiprocketGenerateLabelResponse>("/v1/external/courier/generate/label", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(input)
    }, "SHIPROCKET_LABEL_GENERATION_FAILED");
  }

  getServiceability(input: ShiprocketServiceabilityRequest, token: string): Promise<ShiprocketServiceabilityResponse> {
    const params = new URLSearchParams();
    params.set("pickup_postcode", input.pickup_postcode);
    params.set("delivery_postcode", input.delivery_postcode);
    params.set("weight", String(input.weight));
    params.set("cod", String(input.cod));
    if (input.declared_value !== undefined) params.set("declared_value", String(input.declared_value));

    return this.requestJson<ShiprocketServiceabilityResponse>(`/v1/external/courier/serviceability/?${params.toString()}`, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      }
    }, "SHIPROCKET_RATE_SERVICEABILITY_FAILED");
  }
}
