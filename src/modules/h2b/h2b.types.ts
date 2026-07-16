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
