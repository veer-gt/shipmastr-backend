import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";

export type PinConfirmationInput = {
  pinLatitude?: unknown;
  pinLongitude?: unknown;
  pinSource?: unknown;
  pinLabel?: unknown;
};

const PIN_SOURCE_GOOGLE_DRAG = "GOOGLE_MAP_DRAG_PIN";

function envFlag(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["true", "1", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function pickupPinConfirmationEnabled() {
  return envFlag("GOOGLE_PICKUP_PIN_CONFIRMATION_ENABLED", env.GOOGLE_PICKUP_PIN_CONFIRMATION_ENABLED);
}

export function hasPinConfirmationInput(input: PinConfirmationInput) {
  return [
    input.pinLatitude,
    input.pinLongitude,
    input.pinSource,
    input.pinLabel
  ].some((value) => value !== undefined);
}

function cleanCoordinate(value: unknown, min: number, max: number, code: string) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue < min || numberValue > max) {
    throw new HttpError(400, code);
  }
  return Number(numberValue.toFixed(7));
}

function cleanOptionalText(value: unknown, max: number) {
  const cleaned = String(value ?? "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

export function cleanPinConfirmation(input: PinConfirmationInput) {
  if (!hasPinConfirmationInput(input)) return {};

  if (!pickupPinConfirmationEnabled()) {
    throw new HttpError(400, "GOOGLE_PICKUP_PIN_CONFIRMATION_DISABLED");
  }

  if (input.pinLatitude === undefined || input.pinLatitude === null || input.pinLongitude === undefined || input.pinLongitude === null) {
    throw new HttpError(400, "PICKUP_PIN_COORDINATES_REQUIRED");
  }

  const now = new Date();
  return {
    pinLatitude: cleanCoordinate(input.pinLatitude, -90, 90, "PICKUP_PIN_LATITUDE_INVALID"),
    pinLongitude: cleanCoordinate(input.pinLongitude, -180, 180, "PICKUP_PIN_LONGITUDE_INVALID"),
    pinSource: cleanOptionalText(input.pinSource, 80) || PIN_SOURCE_GOOGLE_DRAG,
    pinLabel: cleanOptionalText(input.pinLabel, 120),
    pinConfirmedAt: now,
    pinUpdatedAt: now
  };
}

function numericOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function pinMetadataResponse(record: Record<string, unknown>) {
  const pinLatitude = numericOrNull(record.pinLatitude);
  const pinLongitude = numericOrNull(record.pinLongitude);
  const latitude = numericOrNull(record.latitude);
  const longitude = numericOrNull(record.longitude);
  const hasPin = pinLatitude !== null && pinLongitude !== null && Boolean(record.pinConfirmedAt);

  return {
    pinLatitude,
    pinLongitude,
    pinConfirmedAt: record.pinConfirmedAt ?? null,
    pinSource: record.pinSource ?? null,
    pinLabel: record.pinLabel ?? null,
    pinUpdatedAt: record.pinUpdatedAt ?? null,
    effectiveLatitude: hasPin ? pinLatitude : latitude,
    effectiveLongitude: hasPin ? pinLongitude : longitude
  };
}
