import type {
  InternalCourierProviderAdapter,
  ProviderCancelInput,
  ProviderCancelResult,
  ProviderDraftOrderInput,
  ProviderDraftOrderResult,
  ProviderLabelInput,
  ProviderLabelResult,
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
import {
  resolveShiprocketLiveCredentials,
  type ShiprocketLiveCredentials
} from "./shiprocket-live-credentials.js";
import {
  ShiprocketLiveClient,
  ShiprocketLiveConfigError,
  ShiprocketLiveProviderError,
  shiprocketLiveClientConfigFromEnv,
  type ShiprocketCreateOrderResponse,
  type ShiprocketLiveClientConfig,
  type ShiprocketLiveFetch
} from "./shiprocket-live.client.js";
import {
  mapProviderDraftToShiprocketOrder,
  mapShiprocketAwbToProviderManifest,
  mapShiprocketLabelToProviderLabel,
  mapShiprocketOrderToProviderDraft
} from "./shiprocket-live.mapper.js";

type ShiprocketLiveAdapterClient = {
  login(credentials: ShiprocketLiveCredentials): Promise<{ token?: string; expires_in?: number; expiresIn?: number }>;
  createAdhocOrder(input: Record<string, unknown>, token: string): Promise<ShiprocketCreateOrderResponse>;
  assignAwb(input: { shipment_id: string | number; courier_id: string | number }, token: string): Promise<Record<string, unknown>>;
  generateLabel(input: { shipment_id: Array<string | number> }, token: string): Promise<Record<string, unknown>>;
};

type ShiprocketLiveAdapterOptions = {
  credentialRef: string;
  source?: Record<string, unknown>;
  client?: ShiprocketLiveAdapterClient;
  now?: () => Date;
  refreshWindowMs?: number;
};

const DEFAULT_REFRESH_WINDOW_MS = 60_000;

function expiresAtFrom(response: { expires_in?: number; expiresIn?: number }, now: Date) {
  const expiresInSeconds = Number(response.expires_in ?? response.expiresIn ?? 3600);
  const safeExpiresInSeconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600;
  return new Date(now.getTime() + safeExpiresInSeconds * 1000);
}

function safeProviderError(error: unknown): never {
  if (error instanceof ShiprocketLiveConfigError || error instanceof ShiprocketLiveProviderError) throw error;
  throw new ShiprocketLiveProviderError({
    code: "SHIPROCKET_LIVE_PROVIDER_ERROR",
    retryable: true
  });
}

function numericProviderId(value: string | null | undefined) {
  if (!value || !/^[0-9]+$/.test(value)) {
    throw new ShiprocketLiveConfigError("Courier provider live request is incomplete.");
  }
  return value;
}

export class ShiprocketLiveAdapter implements InternalCourierProviderAdapter {
  readonly code = "shiprocket";

  private readonly credentialRef: string;
  private readonly source: Record<string, unknown>;
  private readonly client: ShiprocketLiveAdapterClient;
  private readonly now: () => Date;
  private readonly refreshWindowMs: number;
  private tokenCache: TokenResult | null = null;

  constructor(options: ShiprocketLiveAdapterOptions) {
    this.credentialRef = options.credentialRef;
    this.source = options.source ?? {};
    this.client = options.client ?? new ShiprocketLiveClient(shiprocketLiveClientConfigFromEnv(this.source));
    this.now = options.now ?? (() => new Date());
    this.refreshWindowMs = options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
  }

  private tokenIsFresh(token: TokenResult) {
    return token.expiresAt.getTime() - this.now().getTime() > this.refreshWindowMs;
  }

  async login(): Promise<TokenResult> {
    try {
      const credentials = resolveShiprocketLiveCredentials(this.credentialRef, this.source);
      const response = await this.client.login(credentials);
      if (!response.token) {
        throw new ShiprocketLiveProviderError({
          code: "SHIPROCKET_AUTH_FAILED",
          retryable: true
        });
      }
      return {
        token: response.token,
        expiresAt: expiresAtFrom(response, this.now())
      };
    } catch (error) {
      safeProviderError(error);
    }
  }

  async ensureToken(): Promise<TokenResult> {
    if (this.tokenCache && this.tokenIsFresh(this.tokenCache)) return this.tokenCache;
    this.tokenCache = await this.login();
    return this.tokenCache;
  }

  async createPickupLocation(_input: ProviderPickupLocationInput): Promise<ProviderPickupLocationResult> {
    throw new ShiprocketLiveConfigError("Courier provider pickup mutation is not enabled by this bridge.");
  }

  async createDraftOrder(input: ProviderDraftOrderInput): Promise<ProviderDraftOrderResult> {
    try {
      const token = await this.ensureToken();
      const response = await this.client.createAdhocOrder(mapProviderDraftToShiprocketOrder(input), token.token);
      return mapShiprocketOrderToProviderDraft(response);
    } catch (error) {
      safeProviderError(error);
    }
  }

  async getRates(_input: ProviderRateInput): Promise<ProviderRateResult[]> {
    throw new ShiprocketLiveConfigError("Courier provider live rates are not enabled by this bridge.");
  }

  async manifestOrder(input: ProviderManifestInput): Promise<ProviderManifestResult> {
    try {
      const token = await this.ensureToken();
      const response = await this.client.assignAwb({
        shipment_id: numericProviderId(input.providerOrderId),
        courier_id: numericProviderId(input.providerCourierId)
      }, token.token);
      return mapShiprocketAwbToProviderManifest(response);
    } catch (error) {
      safeProviderError(error);
    }
  }

  async getLabel(input: ProviderLabelInput): Promise<ProviderLabelResult> {
    try {
      const token = await this.ensureToken();
      const shipmentId = numericProviderId(input.providerShipmentId ?? input.providerOrderId ?? input.shipmentId);
      const response = await this.client.generateLabel({ shipment_id: [shipmentId] }, token.token);
      return mapShiprocketLabelToProviderLabel(response);
    } catch (error) {
      safeProviderError(error);
    }
  }

  async trackOrder(_input: ProviderTrackingInput): Promise<ProviderTrackingResult> {
    throw new ShiprocketLiveConfigError("Courier provider tracking sync is not enabled by this bridge.");
  }

  async cancelOrder(_input: ProviderCancelInput): Promise<ProviderCancelResult> {
    throw new ShiprocketLiveConfigError("Courier provider cancellation is not enabled by this bridge.");
  }
}

export function createShiprocketLiveAdapter(input: {
  credentialRef: string;
  source?: Record<string, unknown>;
  config?: ShiprocketLiveClientConfig;
  fetchImpl?: ShiprocketLiveFetch;
}) {
  return new ShiprocketLiveAdapter({
    credentialRef: input.credentialRef,
    ...(input.source ? { source: input.source } : {}),
    client: new ShiprocketLiveClient({
      ...shiprocketLiveClientConfigFromEnv(input.source),
      ...(input.config ?? {})
    }, input.fetchImpl)
  });
}
