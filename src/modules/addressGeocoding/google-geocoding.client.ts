import type { AddressFields, GoogleGeocodeResult } from "./address-geocoding.types.js";
import { addressTextForGeocoding } from "./address-fingerprint.js";

type FetchLike = typeof fetch;

type GoogleGeocodeResponse = {
  status?: string;
  error_message?: string;
  results?: Array<{
    place_id?: string;
    formatted_address?: string;
    partial_match?: boolean;
    geometry?: {
      location?: {
        lat?: number;
        lng?: number;
      };
      location_type?: string;
    };
  }>;
};

const highConfidenceLocationTypes = new Set(["ROOFTOP", "RANGE_INTERPOLATED"]);

function safeFailure(errorCode: string): GoogleGeocodeResult {
  return {
    status: "FAILED",
    geocodeErrorCode: errorCode
  };
}

export async function geocodeAddressWithGoogle(input: {
  address: AddressFields;
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<GoogleGeocodeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5000);
  const params = new URLSearchParams();
  params.set("key", input.apiKey);
  params.set("region", "in");

  const placeId = String(input.address.googlePlaceId ?? "").trim();
  if (placeId) {
    params.set("place_id", placeId);
  } else {
    params.set("address", addressTextForGeocoding(input.address));
    params.set("components", "country:IN");
  }

  try {
    const response = await fetchImpl(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`, {
      signal: controller.signal
    });
    if (!response.ok) return safeFailure("GOOGLE_GEOCODE_HTTP_ERROR");

    const body = await response.json() as GoogleGeocodeResponse;
    if (body.status !== "OK") {
      if (body.status === "ZERO_RESULTS") return safeFailure("GOOGLE_GEOCODE_ZERO_RESULTS");
      return safeFailure("GOOGLE_GEOCODE_INVALID_RESPONSE");
    }

    const result = body.results?.[0];
    const lat = result?.geometry?.location?.lat;
    const lng = result?.geometry?.location?.lng;
    if (typeof lat !== "number" || typeof lng !== "number") return safeFailure("GOOGLE_GEOCODE_INVALID_RESPONSE");

    const locationType = result?.geometry?.location_type ?? null;
    const partialMatch = Boolean(result?.partial_match);
    const confidenceStatus = partialMatch || !highConfidenceLocationTypes.has(locationType || "")
      ? "LOW_CONFIDENCE"
      : "GEOCODED";

    return {
      status: confidenceStatus,
      latitude: lat,
      longitude: lng,
      googleGeocodePlaceId: result?.place_id ?? (placeId || null),
      googleFormattedAddress: result?.formatted_address ?? null,
      geocodeLocationType: locationType,
      geocodePartialMatch: partialMatch,
      geocodeErrorCode: confidenceStatus === "LOW_CONFIDENCE" ? "GOOGLE_GEOCODE_LOW_CONFIDENCE" : null
    };
  } catch (_error) {
    return safeFailure("GOOGLE_GEOCODE_TIMEOUT");
  } finally {
    clearTimeout(timeout);
  }
}
