import { prisma } from "../../lib/prisma.js";
import {
  GOOGLE_PLACES_AUTOCOMPLETE_SERVICE_COUNTER,
  GOOGLE_PLACES_DETAILS_SERVICE_COUNTER,
  reserveGoogleMapsQuota
} from "../addressGeocoding/google-maps-quota.service.js";
import type {
  CheckoutPlaceDetails,
  CheckoutPlaceDetailsInput,
  CheckoutPlaceDetailsResponse,
  CheckoutPlaceSuggestion,
  CheckoutPlacesAutocompleteInput,
  CheckoutPlacesAutocompleteResponse,
  CheckoutPlacesConfig
} from "./checkout-places-provider.js";

type DbClient = typeof prisma | any;
type FetchLike = typeof fetch;

type GooglePlacesAutocompleteResponse = {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }>;
};

type GooglePlaceDetailsResponse = {
  id?: string;
  formattedAddress?: string;
  addressComponents?: Array<{
    longText?: string;
    shortText?: string;
    types?: string[];
  }>;
};

type PincodeCentroid = {
  latitude: number;
  longitude: number;
};

export const GOOGLE_PLACES_AUTOCOMPLETE_ENDPOINT = "https://places.googleapis.com/v1/places:autocomplete";
export const GOOGLE_PLACES_DETAILS_ENDPOINT_PREFIX = "https://places.googleapis.com/v1/places/";
export const GOOGLE_PLACES_AUTOCOMPLETE_FIELD_MASK = [
  "suggestions.placePrediction.placeId",
  "suggestions.placePrediction.structuredFormat.mainText.text",
  "suggestions.placePrediction.structuredFormat.secondaryText.text"
].join(",");
export const GOOGLE_PLACES_DETAILS_FIELD_MASK = "id,addressComponents,formattedAddress";

function safeAutocomplete(
  enabled: boolean,
  reason: CheckoutPlacesAutocompleteResponse["reason"]
): CheckoutPlacesAutocompleteResponse {
  return {
    enabled,
    suggestions: [],
    reason
  };
}

function safeDetails(enabled: boolean, reason: CheckoutPlaceDetailsResponse["reason"]): CheckoutPlaceDetailsResponse {
  return {
    enabled,
    place: null,
    reason
  };
}

function cleanText(value: unknown, max = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

function cleanPlaceId(value: unknown) {
  return cleanText(value, 240);
}

function cleanQuery(value: unknown) {
  return cleanText(value, 160);
}

function uniqueNonEmpty(parts: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    const text = cleanText(part, 120);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function componentText(body: GooglePlaceDetailsResponse, ...types: string[]) {
  const component = body.addressComponents?.find((item) => types.some((type) => item.types?.includes(type)));
  return cleanText(component?.longText ?? component?.shortText ?? "", 120);
}

function line1FromDetails(body: GooglePlaceDetailsResponse) {
  const streetNumber = componentText(body, "street_number");
  const route = componentText(body, "route");
  const premise = componentText(body, "premise", "subpremise");
  const neighborhood = componentText(body, "neighborhood");
  const sublocality = componentText(body, "sublocality_level_1", "sublocality");
  const parts = uniqueNonEmpty([
    premise,
    uniqueNonEmpty([streetNumber, route]).join(" "),
    neighborhood,
    sublocality
  ]);
  if (parts.length > 0) return cleanText(parts.join(", "), 240);
  return cleanText(String(body.formattedAddress ?? "").split(",")[0] ?? "", 240);
}

function normalizeSuggestion(item: NonNullable<GooglePlacesAutocompleteResponse["suggestions"]>[number]) {
  const prediction = item.placePrediction;
  const placeId = cleanPlaceId(prediction?.placeId);
  const mainText = cleanText(prediction?.structuredFormat?.mainText?.text, 160);
  const secondaryText = cleanText(prediction?.structuredFormat?.secondaryText?.text, 240);
  if (!placeId || !mainText) return null;
  return {
    placeId,
    mainText,
    secondaryText
  } satisfies CheckoutPlaceSuggestion;
}

function normalizeDetails(body: GooglePlaceDetailsResponse, fallbackPlaceId: string): CheckoutPlaceDetails | null {
  const placeId = cleanPlaceId(body.id || fallbackPlaceId);
  const line1Suggestion = line1FromDetails(body);
  const city = componentText(body, "locality", "postal_town", "administrative_area_level_3");
  const state = componentText(body, "administrative_area_level_1");
  const pincode = componentText(body, "postal_code");
  if (!placeId) return null;
  return {
    placeId,
    line1Suggestion,
    city,
    state,
    pincode
  };
}

function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class CheckoutGooglePlacesClient {
  private readonly client: DbClient;
  private readonly fetchImpl: FetchLike;
  private readonly config: CheckoutPlacesConfig;
  private readonly timeoutMs: number;

  constructor(input: {
    client?: DbClient | undefined;
    fetchImpl?: FetchLike | undefined;
    config: CheckoutPlacesConfig;
    timeoutMs?: number | undefined;
  }) {
    this.client = input.client ?? prisma;
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.config = input.config;
    this.timeoutMs = input.timeoutMs ?? 5000;
  }

  async autocomplete(input: CheckoutPlacesAutocompleteInput): Promise<CheckoutPlacesAutocompleteResponse> {
    if (!this.config.autocompleteEnabled) return safeAutocomplete(false, "disabled");
    if (!this.config.apiKey) return safeAutocomplete(false, "not_configured");

    const q = cleanQuery(input.q);
    if (q.length < this.config.minQueryChars) return safeAutocomplete(true, "query_too_short");

    try {
      const quota = await reserveGoogleMapsQuota(this.client, GOOGLE_PLACES_AUTOCOMPLETE_SERVICE_COUNTER);
      if (!quota.allowed) return safeAutocomplete(false, "quota");

      const body: Record<string, unknown> = {
        input: q,
        includedRegionCodes: ["in"],
        languageCode: "en-IN"
      };
      const centroid = await this.pincodeCentroid(input.pincode);
      if (centroid) {
        body.locationBias = {
          circle: {
            center: {
              latitude: centroid.latitude,
              longitude: centroid.longitude
            },
            radius: 50000
          }
        };
      }

      const response = await this.fetchJson(GOOGLE_PLACES_AUTOCOMPLETE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.config.apiKey,
          "X-Goog-FieldMask": GOOGLE_PLACES_AUTOCOMPLETE_FIELD_MASK
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) return safeAutocomplete(true, "ok");

      const data = response.body as GooglePlacesAutocompleteResponse;
      const suggestions = (data.suggestions ?? [])
        .map(normalizeSuggestion)
        .filter((suggestion): suggestion is CheckoutPlaceSuggestion => Boolean(suggestion))
        .slice(0, 5);
      return {
        enabled: true,
        suggestions,
        reason: "ok"
      };
    } catch {
      return safeAutocomplete(true, "ok");
    }
  }

  async details(input: CheckoutPlaceDetailsInput): Promise<CheckoutPlaceDetailsResponse> {
    if (!this.config.detailsEnabled) return safeDetails(false, "disabled");
    if (!this.config.apiKey) return safeDetails(false, "not_configured");

    const placeId = cleanPlaceId(input.placeId);
    if (!placeId) return safeDetails(true, "ok");

    try {
      const quota = await reserveGoogleMapsQuota(this.client, GOOGLE_PLACES_DETAILS_SERVICE_COUNTER);
      if (!quota.allowed) return safeDetails(false, "quota");

      const response = await this.fetchJson(`${GOOGLE_PLACES_DETAILS_ENDPOINT_PREFIX}${encodeURIComponent(placeId)}`, {
        method: "GET",
        headers: {
          "X-Goog-Api-Key": this.config.apiKey,
          "X-Goog-FieldMask": GOOGLE_PLACES_DETAILS_FIELD_MASK
        }
      });
      if (!response.ok) return safeDetails(true, "ok");

      const place = normalizeDetails(response.body as GooglePlaceDetailsResponse, placeId);
      return {
        enabled: true,
        place,
        reason: "ok"
      };
    } catch {
      return safeDetails(true, "ok");
    }
  }

  private async pincodeCentroid(pincode: unknown): Promise<PincodeCentroid | null> {
    const pin = String(pincode ?? "").trim();
    if (!/^\d{6}$/.test(pin)) return null;
    try {
      const row = await this.client.addressPincode.findUnique({
        where: { pincode: pin },
        select: { lat: true, lng: true }
      });
      const latitude = numberOrNull(row?.lat);
      const longitude = numberOrNull(row?.lng);
      if (latitude === null || longitude === null) return null;
      return { latitude, longitude };
    } catch {
      return null;
    }
  }

  private async fetchJson(url: string, init: RequestInit): Promise<{ ok: boolean; body: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal
      });
      if (!response.ok) return { ok: false, body: null };
      return {
        ok: true,
        body: await response.json()
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
