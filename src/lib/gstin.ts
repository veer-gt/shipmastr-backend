import { HttpError } from "./httpError.js";

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function normalizeOptionalGstin(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const normalized = trimmed.toUpperCase();
  if (!GSTIN_PATTERN.test(normalized)) {
    throw new HttpError(400, "INVALID_GSTIN");
  }

  return normalized;
}

export function normalizeRequiredGstin(value?: string | null) {
  const normalized = normalizeOptionalGstin(value);
  if (!normalized) {
    throw new HttpError(400, "GSTIN_REQUIRED");
  }

  return normalized;
}
