import { createHash } from "node:crypto";
import type { AddressFields } from "./address-geocoding.types.js";

function cleanPart(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanUpper(value: unknown) {
  return cleanPart(value).toUpperCase();
}

function cleanPincode(value: unknown) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 6);
}

export function normalizeAddressForFingerprint(input: AddressFields) {
  return {
    addressLine1: cleanUpper(input.addressLine1),
    addressLine2: cleanUpper(input.addressLine2),
    city: cleanUpper(input.city),
    state: cleanUpper(input.state),
    pincode: cleanPincode(input.pincode),
    country: cleanUpper(input.country || "IN") || "IN",
    googlePlaceId: cleanPart(input.googlePlaceId)
  };
}

export function addressFingerprint(input: AddressFields) {
  const normalized = normalizeAddressForFingerprint(input);
  return createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");
}

export function addressTextForGeocoding(input: AddressFields) {
  const normalized = normalizeAddressForFingerprint(input);
  return [
    normalized.addressLine1,
    normalized.addressLine2,
    normalized.city,
    normalized.state,
    normalized.pincode,
    normalized.country
  ].filter(Boolean).join(", ");
}
