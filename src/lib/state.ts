import { HttpError } from "./httpError.js";

export function normalizeState(value?: string | null) {
  const normalized = value?.trim().replace(/\s+/g, " ").toUpperCase();
  if (!normalized) {
    throw new HttpError(400, "STATE_REQUIRED");
  }

  return normalized;
}

export function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized || null;
}

export function normalizePincode(value?: string | null) {
  const normalized = value?.trim();
  if (!normalized || !/^\d{6}$/.test(normalized)) {
    throw new HttpError(400, "INVALID_PINCODE");
  }

  return normalized;
}
