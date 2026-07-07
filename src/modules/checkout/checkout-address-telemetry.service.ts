import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";

type DbClient = typeof prisma | any;

export const ADDRESS_EVENTS = [
  "phone_verified",
  "graph_hit_merchant",
  "graph_hit_network",
  "graph_miss",
  "prefill_offered",
  "prefill_accepted",
  "prefill_edited",
  "pincode_resolved",
  "places_selected",
  "manual_completed",
  "abandoned_at_address"
] as const;

export type AddressEventName = (typeof ADDRESS_EVENTS)[number];

export type AddressEventInput = {
  sessionId: string;
  shopperId?: string | null | undefined;
  merchantId: string;
  event: AddressEventName | string;
  meta?: unknown;
};

export const ADDRESS_EVENTS_BATCH_LIMIT = 25;

const unsafeMetaKey = /phone|mobile|email|ip|address|line1|line2|landmark|fullname|fullName|name|proof|otp|token|hash/i;
const emailLike = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const ipv4Like = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u;
const ipv6Like = /\b(?=[a-f0-9:]*:[a-f0-9:]*:)[a-f0-9:]{3,}\b/iu;
const addressLikeText = /\b(?:flat|floor|apartment|building|landmark|road|rd|street|lane|sector|block|pincode|postal|near)\b/iu;

function cleanRequiredText(value: unknown, field: string, max = 180) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new HttpError(400, "ADDRESS_EVENT_FIELD_REQUIRED", { field });
  return text;
}

function cleanOptionalText(value: unknown, field: string, max = 180) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new HttpError(400, "ADDRESS_EVENT_FIELD_INVALID", { field });
  return text;
}

function cleanEvent(value: unknown): AddressEventName {
  const event = String(value ?? "").trim();
  if (!ADDRESS_EVENTS.includes(event as AddressEventName)) {
    throw new HttpError(400, "ADDRESS_EVENT_UNKNOWN", { event });
  }
  return event as AddressEventName;
}

function containsPhoneLikeValue(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function containsUnsafeStringValue(value: string) {
  return emailLike.test(value)
    || containsPhoneLikeValue(value)
    || ipv4Like.test(value)
    || ipv6Like.test(value)
    || (value.length > 50 && addressLikeText.test(value));
}

function sanitizeScalar(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (containsUnsafeStringValue(trimmed)) return "[redacted]";
    return trimmed;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return String(value);
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeMetaKey.test(key)) continue;
      output[key] = sanitizeValue(child);
    }
    return output;
  }
  return sanitizeScalar(value);
}

export function sanitizeAddressEventMeta(meta: unknown) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  return sanitizeValue(meta) as Record<string, unknown>;
}

function prepareEvent(input: AddressEventInput) {
  return {
    sessionId: cleanRequiredText(input.sessionId, "sessionId", 180),
    shopperId: cleanOptionalText(input.shopperId, "shopperId", 180),
    merchantId: cleanRequiredText(input.merchantId, "merchantId", 180),
    event: cleanEvent(input.event),
    meta: sanitizeAddressEventMeta(input.meta ?? {})
  };
}

export class CheckoutAddressTelemetryService {
  constructor(private readonly client: DbClient = prisma) {}

  async recordAddressEvent(input: AddressEventInput) {
    const data = prepareEvent(input);
    return this.client.addressEvent.create({ data });
  }

  async recordAddressEventsBatch(inputs: AddressEventInput[]) {
    if (!Array.isArray(inputs)) throw new HttpError(400, "ADDRESS_EVENT_BATCH_INVALID");
    if (inputs.length < 1) return { count: 0 };
    if (inputs.length > ADDRESS_EVENTS_BATCH_LIMIT) {
      throw new HttpError(400, "ADDRESS_EVENT_BATCH_TOO_LARGE", { limit: ADDRESS_EVENTS_BATCH_LIMIT });
    }

    const data = inputs.map(prepareEvent);
    return this.client.addressEvent.createMany({ data });
  }
}

export const checkoutAddressTelemetryService = new CheckoutAddressTelemetryService();

export function recordAddressEvent(input: AddressEventInput) {
  return checkoutAddressTelemetryService.recordAddressEvent(input);
}

export function recordAddressEventsBatch(inputs: AddressEventInput[]) {
  return checkoutAddressTelemetryService.recordAddressEventsBatch(inputs);
}

export async function recordAddressEventSafely(input: AddressEventInput) {
  try {
    await recordAddressEvent(input);
  } catch {
    logger.warn({ event: input.event }, "checkout_address_telemetry_record_failed");
  }
}

export function recordAddressGraphHitMerchant(input: Omit<AddressEventInput, "event">) {
  return recordAddressEvent({ ...input, event: "graph_hit_merchant" });
}

export function recordAddressGraphHitNetwork(input: Omit<AddressEventInput, "event">) {
  return recordAddressEvent({ ...input, event: "graph_hit_network" });
}

export function recordAddressGraphMiss(input: Omit<AddressEventInput, "event">) {
  return recordAddressEvent({ ...input, event: "graph_miss" });
}

export function recordAddressPrefillOffered(input: Omit<AddressEventInput, "event">) {
  return recordAddressEvent({ ...input, event: "prefill_offered" });
}

export function recordAddressPrefillAccepted(input: Omit<AddressEventInput, "event">) {
  return recordAddressEvent({ ...input, event: "prefill_accepted" });
}

export function recordAddressPrefillEdited(input: Omit<AddressEventInput, "event">) {
  return recordAddressEvent({ ...input, event: "prefill_edited" });
}
