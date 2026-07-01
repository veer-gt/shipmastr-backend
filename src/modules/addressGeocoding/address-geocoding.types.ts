import type { AddressGeocodeStatus } from "@prisma/client";

export const ADDRESS_GEOCODE_PROVIDER_GOOGLE = "GOOGLE_GEOCODING";

export const addressGeocodeEntityTypes = [
  "MERCHANT_PICKUP_POINT",
  "MERCHANT_WAREHOUSE"
] as const;

export type AddressGeocodeEntityType = typeof addressGeocodeEntityTypes[number];

export type AddressFields = {
  addressLine1: string;
  addressLine2?: string | null | undefined;
  city: string;
  state: string;
  pincode: string;
  country?: string | null | undefined;
  googlePlaceId?: string | null | undefined;
};

export type GeocodeStatus = AddressGeocodeStatus | "PENDING" | "GEOCODED" | "LOW_CONFIDENCE" | "FAILED" | "SKIPPED";

export type GoogleGeocodeResult = {
  status: Extract<GeocodeStatus, "GEOCODED" | "LOW_CONFIDENCE" | "FAILED">;
  latitude?: number;
  longitude?: number;
  googleGeocodePlaceId?: string | null;
  googleFormattedAddress?: string | null;
  geocodeLocationType?: string | null;
  geocodePartialMatch?: boolean | null;
  geocodeErrorCode?: string | null;
};

export type AddressGeocodeTaskRecord = {
  id: string;
  entityType: AddressGeocodeEntityType | string;
  entityId: string;
  merchantId: string;
  addressFingerprint: string;
  attempts: number;
};
