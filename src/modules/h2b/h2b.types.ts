import type { StorePlatform } from "@prisma/client";

export type H2BProvider = "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO";
export type H2BTopic =
  | "orders/create"
  | "orders/updated"
  | "order.created"
  | "order.updated"
  | "shipmastr.order.committed.v1";

export const H2B_PUBLIC_ROUTE_PREFIX = "/api/public/provider-webhooks" as const;
export const H2B_MAGENTO_INTERNAL_EVENT_HOOK = "TBD_AFTER_MAGENTO_EXTENSION_EVENT_AUDIT" as const;
export const H2B_MAGENTO_TOPIC = "shipmastr.order.committed.v1" as const;
export const H2B_ENDPOINT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const H2B_ABSOLUTE_BODY_LIMIT_BYTES = 256 * 1024;
export const H2B_PROVIDER_HINTS: Record<H2BProvider, string> = {
  SHOPIFY: "shp",
  WOOCOMMERCE: "woo",
  MAGENTO: "mag"
};
export const H2B_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  INR: 2, USD: 2, EUR: 2, GBP: 2, AED: 2, SGD: 2,
  JPY: 0, KRW: 0, KWD: 3, BHD: 3, OMR: 3
});

export function providerHintForProvider(provider: H2BProvider) {
  return H2B_PROVIDER_HINTS[provider];
}

export function providerFromHint(hint: string): H2BProvider | null {
  const found = (Object.entries(H2B_PROVIDER_HINTS) as Array<[H2BProvider, string]>).find(([, value]) => value === hint);
  return found?.[0] ?? null;
}

export function endpointParts(value: string): { provider: H2BProvider; token: string } | null {
  const match = /^([a-z]{3})_([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return null;
  const provider = providerFromHint(match[1] ?? "");
  return provider ? { provider, token: value } : null;
}

export function decimalMajorToMinor(value: unknown, currency: string): string {
  const code = typeof currency === "string" ? currency : "";
  if (!/^[A-Z]{3}$/.test(code) || H2B_CURRENCY_EXPONENTS[code] === undefined) {
    throw new Error(code ? "H2B_CURRENCY_UNSUPPORTED" : "H2B_CURRENCY_REQUIRED");
  }
  const exponent = H2B_CURRENCY_EXPONENTS[code];
  let text: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("H2B_TOTAL_NUMBER_INVALID");
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    throw new Error("H2B_TOTAL_INVALID");
  }
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) throw new Error("H2B_TOTAL_INVALID");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > exponent) throw new Error("H2B_TOTAL_PRECISION_INVALID");
  const digits = `${whole}${fraction.padEnd(exponent, "0")}`.replace(/^0+(?=\d)/, "");
  try {
    const minor = BigInt(digits || "0");
    if (minor > BigInt("900719925474099100000000000000")) throw new Error("H2B_TOTAL_OVERFLOW");
    return minor.toString();
  } catch (error) {
    if (error instanceof Error && error.message === "H2B_TOTAL_OVERFLOW") throw error;
    throw new Error("H2B_TOTAL_OVERFLOW");
  }
}

export const H2B_INITIAL_TOPICS: Record<H2BProvider, readonly string[]> = {
  SHOPIFY: ["orders/create", "orders/updated"],
  WOOCOMMERCE: ["order.created", "order.updated"],
  MAGENTO: [H2B_MAGENTO_TOPIC]
};

export function providerFromPlatform(platform: StorePlatform): H2BProvider {
  if (platform === "SHOPIFY" || platform === "WOOCOMMERCE" || platform === "MAGENTO") return platform;
  throw new Error("H2B_UNSUPPORTED_PLATFORM");
}

export function topicForProvider(provider: H2BProvider, headers: Record<string, unknown>): string {
  const value = (name: string, normalize = true) => {
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const raw = key ? headers[key] : undefined;
    const text = Array.isArray(raw) ? String(raw[0] ?? "").trim() : String(raw ?? "").trim();
    return normalize ? text.toLowerCase() : text;
  };
  if (provider === "SHOPIFY") return value("x-shopify-topic", false);
  if (provider === "MAGENTO") return value("x-magento-topic", false);
  const direct = value("x-wc-webhook-topic");
  if (direct) return direct;
  const resource = value("x-wc-webhook-resource");
  const event = value("x-wc-webhook-event");
  return resource && event ? `${resource}.${event}` : "";
}

export function deliveryIdForProvider(provider: H2BProvider, headers: Record<string, unknown>): string {
  const value = (name: string) => {
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const raw = key ? headers[key] : undefined;
    return Array.isArray(raw) ? String(raw[0] ?? "").trim() : String(raw ?? "").trim();
  };
  if (provider === "SHOPIFY") return value("x-shopify-webhook-id");
  if (provider === "MAGENTO") return value("x-magento-webhook-id") || value("x-adobe-commerce-webhook-id");
  return value("x-wc-webhook-delivery-id") || value("x-wc-webhook-id");
}

export function signatureForProvider(provider: H2BProvider, headers: Record<string, unknown>): string {
  const name = provider === "SHOPIFY"
    ? "x-shopify-hmac-sha256"
    : provider === "WOOCOMMERCE"
      ? "x-wc-webhook-signature"
      : "x-magento-signature";
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const raw = key ? headers[key] : undefined;
  return Array.isArray(raw) ? String(raw[0] ?? "").trim() : String(raw ?? "").trim();
}
