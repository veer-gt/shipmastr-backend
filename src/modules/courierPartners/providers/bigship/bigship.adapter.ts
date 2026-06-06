import type {
  InternalCourierProviderAdapter,
  ProviderCancelInput,
  ProviderCancelResult,
  ProviderDraftOrderInput,
  ProviderDraftOrderResult,
  ProviderManifestInput,
  ProviderManifestResult,
  ProviderPickupLocationInput,
  ProviderPickupLocationResult,
  ProviderRateInput,
  ProviderRateResult,
  ProviderTrackingInput,
  ProviderTrackingResult,
  TokenResult
} from "../provider-adapter.types.js";
import { BigshipClient, bigshipClientConfigFromEnv, type BigshipClientConfig } from "./bigship.client.js";
import {
  BigshipConfigError,
  BigshipProviderError,
  BigshipValidationError,
  normalizeBigshipError
} from "./bigship.errors.js";
import {
  mapBigshipCancelToProviderCancel,
  mapBigshipDraftOrderToProviderDraftOrder,
  mapBigshipManifestToProviderManifest,
  mapBigshipPickupToProviderPickup,
  mapBigshipRateInputToRateRequest,
  mapBigshipRatesToProviderRates,
  mapBigshipTrackingToProviderTracking,
  mapDomesticB2CShipmentToBigship,
  mapPickupLocationToBigship
} from "./bigship.mapper.js";
import type {
  BigshipCancelOrderRequest,
  BigshipCancelOrderResponse,
  BigshipCourierRateRequest,
  BigshipCourierRateResponse,
  BigshipDomesticB2COrderRequest,
  BigshipDomesticB2COrderResponse,
  BigshipLoginResponse,
  BigshipPlaceOrderRequest,
  BigshipPlaceOrderResponse,
  BigshipSaveWarehouseRequest,
  BigshipSaveWarehouseResponse,
  BigshipTrackingRequest,
  BigshipTrackingResponse
} from "./bigship.types.js";

type BigshipAdapterClient = {
  login(): Promise<BigshipLoginResponse>;
  saveWarehouse(input: BigshipSaveWarehouseRequest, token: string): Promise<BigshipSaveWarehouseResponse>;
  createDomesticB2COrder(
    input: BigshipDomesticB2COrderRequest,
    token: string
  ): Promise<BigshipDomesticB2COrderResponse>;
  getRates(input: BigshipCourierRateRequest, token: string): Promise<BigshipCourierRateResponse>;
  placeOrder(input: BigshipPlaceOrderRequest, token: string): Promise<BigshipPlaceOrderResponse>;
  trackOrder(input: BigshipTrackingRequest, token: string): Promise<BigshipTrackingResponse>;
  cancelOrder(input: BigshipCancelOrderRequest, token: string): Promise<BigshipCancelOrderResponse>;
};

type BigshipAdapterOptions = {
  client?: BigshipAdapterClient;
  now?: () => Date;
  refreshWindowMs?: number;
};

const DEFAULT_REFRESH_WINDOW_MS = 60_000;

function expiresAtFrom(response: BigshipLoginResponse, now: Date) {
  const expiresInSeconds = Number(response.expires_in ?? response.expiresIn ?? 3600);
  const safeExpiresInSeconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600;
  return new Date(now.getTime() + safeExpiresInSeconds * 1000);
}

export class BigshipAdapter implements InternalCourierProviderAdapter {
  readonly code = "bigship";

  private readonly client: BigshipAdapterClient;
  private readonly now: () => Date;
  private readonly refreshWindowMs: number;
  private tokenCache: TokenResult | null = null;

  constructor(options: BigshipAdapterOptions = {}) {
    this.client = options.client ?? new BigshipClient(bigshipClientConfigFromEnv());
    this.now = options.now ?? (() => new Date());
    this.refreshWindowMs = options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
  }

  private tokenIsFresh(token: TokenResult) {
    return token.expiresAt.getTime() - this.now().getTime() > this.refreshWindowMs;
  }

  private safeProviderError(error: unknown): never {
    if (error instanceof BigshipConfigError || error instanceof BigshipValidationError) {
      throw error;
    }

    const normalized = normalizeBigshipError(error);
    const options = {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable
    };

    if (normalized.statusCode !== undefined) {
      throw new BigshipProviderError({
        ...options,
        statusCode: normalized.statusCode
      });
    }

    throw new BigshipProviderError(options);
  }

  async login(): Promise<TokenResult> {
    try {
      const response = await this.client.login();
      if (!response.token) {
        throw new BigshipProviderError({
          code: "COURIER_PROVIDER_AUTH_FAILED",
          message: "Courier provider authentication failed.",
          retryable: true
        });
      }

      return {
        token: response.token,
        expiresAt: expiresAtFrom(response, this.now())
      };
    } catch (error) {
      this.safeProviderError(error);
    }
  }

  async ensureToken(): Promise<TokenResult> {
    if (this.tokenCache && this.tokenIsFresh(this.tokenCache)) {
      return this.tokenCache;
    }

    this.tokenCache = await this.login();
    return this.tokenCache;
  }

  async createPickupLocation(input: ProviderPickupLocationInput): Promise<ProviderPickupLocationResult> {
    try {
      const token = await this.ensureToken();
      const response = await this.client.saveWarehouse(mapPickupLocationToBigship(input), token.token);
      return mapBigshipPickupToProviderPickup(response);
    } catch (error) {
      this.safeProviderError(error);
    }
  }

  async createDraftOrder(input: ProviderDraftOrderInput): Promise<ProviderDraftOrderResult> {
    if (input.segment !== "domestic_b2c") {
      throw new BigshipValidationError("Courier provider request is invalid.");
    }

    try {
      const token = await this.ensureToken();
      const response = await this.client.createDomesticB2COrder(mapDomesticB2CShipmentToBigship(input), token.token);
      return mapBigshipDraftOrderToProviderDraftOrder(response);
    } catch (error) {
      this.safeProviderError(error);
    }
  }

  async getRates(input: ProviderRateInput): Promise<ProviderRateResult[]> {
    try {
      const token = await this.ensureToken();
      const response = await this.client.getRates(mapBigshipRateInputToRateRequest(input), token.token);
      return mapBigshipRatesToProviderRates(response);
    } catch (error) {
      this.safeProviderError(error);
    }
  }

  async manifestOrder(input: ProviderManifestInput): Promise<ProviderManifestResult> {
    try {
      const token = await this.ensureToken();
      const response = await this.client.placeOrder({
        order_id: input.providerOrderId,
        courierId: input.providerCourierId
      }, token.token);
      return mapBigshipManifestToProviderManifest(response);
    } catch (error) {
      this.safeProviderError(error);
    }
  }

  async trackOrder(input: ProviderTrackingInput): Promise<ProviderTrackingResult> {
    try {
      const token = await this.ensureToken();
      const response = await this.client.trackOrder({
        awb: input.awb ?? null,
        tracking_number: input.trackingNumber ?? null,
        order_id: input.providerOrderId ?? null
      }, token.token);
      return mapBigshipTrackingToProviderTracking(response);
    } catch (error) {
      this.safeProviderError(error);
    }
  }

  async cancelOrder(input: ProviderCancelInput): Promise<ProviderCancelResult> {
    try {
      const token = await this.ensureToken();
      const response = await this.client.cancelOrder({
        awb: input.awb ?? null,
        tracking_number: input.trackingNumber ?? null,
        order_id: input.providerOrderId ?? null,
        reason: input.reason ?? null
      }, token.token);
      return mapBigshipCancelToProviderCancel(response);
    } catch (error) {
      this.safeProviderError(error);
    }
  }
}

export function createBigshipAdapter(config: BigshipClientConfig = {}) {
  return new BigshipAdapter({
    client: new BigshipClient({
      ...bigshipClientConfigFromEnv(),
      ...config
    })
  });
}
