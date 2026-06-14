import { createHmac, timingSafeEqual } from "node:crypto";
import { serializeShopifyWebhookValidation } from "./shopify.serializers.js";

const requiredHeaders = [
  "x-shopify-hmac-sha256",
  "x-shopify-topic",
  "x-shopify-shop-domain",
  "x-shopify-webhook-id",
  "x-shopify-triggered-at"
];

function headerValue(headers: Record<string, unknown>, name: string) {
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  const value = entry?.[1];
  if (Array.isArray(value)) return String(value[0] ?? "");
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function bodyString(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

function safeCompare(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function validateShopifyWebhookFoundation(input: {
  headers: Record<string, unknown>;
  body?: unknown;
  secret?: string | undefined;
}) {
  const missingHeaders = requiredHeaders.filter((header) => !headerValue(input.headers, header));
  const hmac = headerValue(input.headers, "x-shopify-hmac-sha256");
  const topic = headerValue(input.headers, "x-shopify-topic") || null;
  const shopDomain = headerValue(input.headers, "x-shopify-shop-domain") || null;
  const webhookId = headerValue(input.headers, "x-shopify-webhook-id") || null;
  const triggeredAt = headerValue(input.headers, "x-shopify-triggered-at") || null;
  let status: "VALID" | "INVALID" | "NOT_CONFIGURED" = missingHeaders.length ? "INVALID" : "NOT_CONFIGURED";

  if (!missingHeaders.length && input.secret) {
    const expected = createHmac("sha256", input.secret)
      .update(bodyString(input.body))
      .digest("base64");
    status = safeCompare(hmac, expected) ? "VALID" : "INVALID";
  }

  return serializeShopifyWebhookValidation({
    status,
    missingHeaders,
    topic,
    shopDomain,
    webhookId,
    triggeredAt,
    hmacConfigured: Boolean(input.secret)
  });
}
