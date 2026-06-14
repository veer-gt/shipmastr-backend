import type { PlatformMappingWarning } from "../platform-types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function asNullableString(value: unknown): string | null {
  const normalized = asString(value);
  return normalized ? normalized : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,₹\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function intOrNull(value: unknown): number | null {
  const parsed = asNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

export function parseAmountToPaise(value: unknown): number {
  const raw = asString(value);
  const numeric = typeof value === "number"
    ? value
    : Number(raw.replace(/[,₹\s]/g, ""));
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric * 100) : 0;
}

export function firstString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) return normalized;
  }
  return "";
}

export function firstNullableString(...values: unknown[]): string | null {
  const value = firstString(...values);
  return value || null;
}

export function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter(Boolean);
  }
  return asString(value)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function addWarning(
  warnings: PlatformMappingWarning[],
  code: string,
  field: string,
  message: string,
  level: "info" | "warning" = "warning"
) {
  warnings.push({ code, field, message, level });
}

export function normalizeCountry(value: unknown): string {
  const country = asString(value).toUpperCase();
  if (!country) return "IN";
  if (country === "INDIA") return "IN";
  return country;
}

export function parseDate(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
