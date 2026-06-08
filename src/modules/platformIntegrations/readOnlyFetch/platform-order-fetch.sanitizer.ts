import crypto from "crypto";
import type { NormalizedPlatformOrder } from "../platform-types.js";

const unsafeKeyPattern = /secret|token|password|encrypted|authorization|cookie|headers|raw|api[_-]?key|consumer|credential|hmac|signature/i;
const unsafeStringPattern = /shpat_|ck_|cs_|magentotoken_|bearer\s+|basic\s+|sk_live|sk_test|whsec_|token|secret|consumer_secret|access_token/i;

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(source[key])}`).join(",")}}`;
}

export function safePayloadHash(value: unknown) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function sanitizePlatformFetchDetails(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizePlatformFetchDetails);
  if (typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      safe[key] = sanitizePlatformFetchDetails(child);
    }
    return safe;
  }
  if (typeof value === "string" && unsafeStringPattern.test(value)) return "[redacted]";
  return value;
}

function maskPhone(value: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length <= 4) return "masked";
  return `***${digits.slice(-4)}`;
}

function maskEmail(value: string | null) {
  const email = String(value || "").trim();
  if (!email || !email.includes("@")) return email ? "available" : null;
  const [local, domain] = email.split("@");
  return `${(local ?? "").slice(0, 1) || "*"}***@${domain ?? ""}`;
}

export function buildFetchedOrderPreview(
  normalized: NormalizedPlatformOrder,
  rawPayload: Record<string, unknown>
) {
  return {
    platform: normalized.platform,
    externalOrderId: normalized.externalOrderId,
    externalOrderName: normalized.externalOrderName,
    createdAt: normalized.orderCreatedAt,
    updatedAt: null,
    financialStatus: normalized.paymentMode,
    fulfillmentStatus: null,
    currency: normalized.currency,
    totalAmount: normalized.orderAmountPaise / 100,
    codDetected: normalized.paymentMode === "COD",
    buyerPreview: {
      name: normalized.buyerName,
      phoneMasked: maskPhone(normalized.buyerPhone),
      emailMasked: maskEmail(normalized.buyerEmail),
      city: normalized.shippingAddress.city,
      state: normalized.shippingAddress.state,
      pincode: normalized.shippingAddress.postalCode,
      country: normalized.shippingAddress.country
    },
    lineItemPreview: normalized.items.slice(0, 10).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      sku: item.sku,
      weightGrams: item.weightGrams
    })),
    mappingWarnings: normalized.mappingWarnings.map((warning) => warning.message),
    safePayloadHash: safePayloadHash(rawPayload)
  };
}
