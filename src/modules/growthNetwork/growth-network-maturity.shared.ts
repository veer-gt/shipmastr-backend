import { Prisma } from "@prisma/client";

export const unsafeGrowthPublicTextPattern = /\b(shiprocket|shipmozo|bigship|delhivery|bluedart|blue dart|xpressbees|shadowfax|ecom express|ekart)\b/gi;
const unsafeMetadataKeyPattern = /buyer|email|phone|mobile|address|name|provider|courier|secret|token|authorization|cookie|card|payment|billing|invoice|payout|gst|tax/i;
const unsafeMetadataStringPattern = /@|\b\d{10,}\b|shiprocket|shipmozo|bigship|delhivery|bluedart|blue dart|xpressbees|shadowfax|ecom express|ekart/i;
const unsafePolicyTextPattern = /@|\b\d{10,}\b|shiprocket|shipmozo|bigship|delhivery|bluedart|blue dart|xpressbees|shadowfax|ecom express|ekart|payment gateway|pay now|invoice|payout/i;

export function cleanString(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function safePublicText(value: string | null | undefined) {
  const text = cleanString(value);
  if (!text) return null;
  return text.replace(unsafeGrowthPublicTextPattern, "Shipmastr logistics network");
}

export function safeInternalCtaUrl(value: string | null | undefined) {
  const text = cleanString(value);
  if (!text) return null;
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  if (/[\r\n]/.test(text)) return null;
  return text;
}

export function isSafeInternalCtaUrl(value: string | null | undefined) {
  const text = cleanString(value);
  return !text || safeInternalCtaUrl(text) === text;
}

export function hasUnsafePublicText(value: string | null | undefined) {
  const text = cleanString(value);
  if (!text) return false;
  unsafePolicyTextPattern.lastIndex = 0;
  return unsafePolicyTextPattern.test(text);
}

export function sanitizeGrowthNetworkMetadata(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeGrowthNetworkMetadata);
  if (typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeMetadataKeyPattern.test(key)) continue;
      safe[key] = sanitizeGrowthNetworkMetadata(child);
    }
    return safe;
  }
  if (typeof value === "string" && unsafeMetadataStringPattern.test(value)) return "[redacted]";
  return value;
}

export function toStoredJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return JSON.parse(JSON.stringify(sanitizeGrowthNetworkMetadata(value))) as Prisma.InputJsonValue;
}

export function metadataRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

export function isDuplicateKeyError(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "P2002"
  );
}

export function dateIsLive(startsAt: Date | string | null | undefined, endsAt: Date | string | null | undefined, now: Date) {
  const startsAtMs = startsAt ? new Date(startsAt).getTime() : null;
  const endsAtMs = endsAt ? new Date(endsAt).getTime() : null;
  const nowMs = now.getTime();
  return (startsAtMs == null || startsAtMs <= nowMs) && (endsAtMs == null || endsAtMs >= nowMs);
}

export function activeDateWhere(now: Date) {
  return [
    { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
    { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }
  ];
}

export function rate(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}
