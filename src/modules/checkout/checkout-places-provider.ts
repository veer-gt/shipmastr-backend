import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { CheckoutGooglePlacesClient } from "./checkout-google-places.client.js";

type DbClient = typeof prisma | any;
type FetchLike = typeof fetch;

export type CheckoutPlacesReason = "disabled" | "not_configured" | "query_too_short" | "quota" | "ok";

export type CheckoutPlaceSuggestion = {
  placeId: string;
  mainText: string;
  secondaryText: string;
};

export type CheckoutPlacesAutocompleteInput = {
  q: string;
  pincode?: string | undefined;
};

export type CheckoutPlacesAutocompleteResponse = {
  enabled: boolean;
  suggestions: CheckoutPlaceSuggestion[];
  reason: CheckoutPlacesReason;
};

export type CheckoutPlaceDetailsInput = {
  placeId: string;
};

export type CheckoutPlaceDetails = {
  placeId: string;
  line1Suggestion: string;
  city: string;
  state: string;
  pincode: string;
};

export type CheckoutPlaceDetailsResponse = {
  enabled: boolean;
  place: CheckoutPlaceDetails | null;
  reason: Exclude<CheckoutPlacesReason, "query_too_short">;
};

export interface PlacesProvider {
  autocomplete(input: CheckoutPlacesAutocompleteInput): Promise<CheckoutPlacesAutocompleteResponse>;
  details(input: CheckoutPlaceDetailsInput): Promise<CheckoutPlaceDetailsResponse>;
}

export type CheckoutPlacesConfig = {
  autocompleteEnabled: boolean;
  detailsEnabled: boolean;
  apiKey: string;
  minQueryChars: number;
  debounceMs: number;
};

function envBoolean(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return fallback;
}

function envInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedInteger(value: number, fallback: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

export function getCheckoutPlacesConfig(overrides: Partial<CheckoutPlacesConfig> = {}): CheckoutPlacesConfig {
  const minQueryChars = boundedInteger(
    overrides.minQueryChars ?? envInteger("PLACES_MIN_QUERY_CHARS", env.PLACES_MIN_QUERY_CHARS),
    3,
    1,
    20
  );
  const debounceMs = boundedInteger(
    overrides.debounceMs ?? envInteger("PLACES_DEBOUNCE_MS", env.PLACES_DEBOUNCE_MS),
    300,
    0,
    5000
  );

  return {
    autocompleteEnabled: overrides.autocompleteEnabled ?? envBoolean(
      "GOOGLE_ADDRESS_AUTOCOMPLETE_ENABLED",
      env.GOOGLE_ADDRESS_AUTOCOMPLETE_ENABLED
    ),
    detailsEnabled: overrides.detailsEnabled ?? envBoolean("GOOGLE_PLACE_DETAILS_ENABLED", env.GOOGLE_PLACE_DETAILS_ENABLED),
    apiKey: overrides.apiKey ?? (process.env.GOOGLE_GEOCODING_API_KEY?.trim() || env.GOOGLE_GEOCODING_API_KEY?.trim() || ""),
    minQueryChars,
    debounceMs
  };
}

export class DisabledPlacesProvider implements PlacesProvider {
  constructor(private readonly reason: "disabled" | "not_configured" | "quota" = "disabled") {}

  async autocomplete(_input?: CheckoutPlacesAutocompleteInput): Promise<CheckoutPlacesAutocompleteResponse> {
    return {
      enabled: false,
      suggestions: [],
      reason: this.reason
    };
  }

  async details(_input?: CheckoutPlaceDetailsInput): Promise<CheckoutPlaceDetailsResponse> {
    return {
      enabled: false,
      place: null,
      reason: this.reason
    };
  }
}

export class GooglePlacesProvider implements PlacesProvider {
  constructor(private readonly client: CheckoutGooglePlacesClient) {}

  autocomplete(input: CheckoutPlacesAutocompleteInput) {
    return this.client.autocomplete(input);
  }

  details(input: CheckoutPlaceDetailsInput) {
    return this.client.details(input);
  }
}

export function createCheckoutPlacesProvider(input: {
  client?: DbClient | undefined;
  fetchImpl?: FetchLike | undefined;
  config?: Partial<CheckoutPlacesConfig> | undefined;
  timeoutMs?: number | undefined;
} = {}): PlacesProvider {
  return {
    async autocomplete(request) {
      const config = getCheckoutPlacesConfig(input.config);
      if (!config.autocompleteEnabled) return new DisabledPlacesProvider("disabled").autocomplete(request);
      if (!config.apiKey) return new DisabledPlacesProvider("not_configured").autocomplete(request);
      return new GooglePlacesProvider(new CheckoutGooglePlacesClient({
        client: input.client,
        fetchImpl: input.fetchImpl,
        config,
        timeoutMs: input.timeoutMs
      })).autocomplete(request);
    },
    async details(request) {
      const config = getCheckoutPlacesConfig(input.config);
      if (!config.detailsEnabled) return new DisabledPlacesProvider("disabled").details(request);
      if (!config.apiKey) return new DisabledPlacesProvider("not_configured").details(request);
      return new GooglePlacesProvider(new CheckoutGooglePlacesClient({
        client: input.client,
        fetchImpl: input.fetchImpl,
        config,
        timeoutMs: input.timeoutMs
      })).details(request);
    }
  };
}

export const checkoutPlacesProvider = createCheckoutPlacesProvider();
