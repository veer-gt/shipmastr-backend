import { createHmac, timingSafeEqual } from "node:crypto";
import { serializeWooCommerceWebhookValidation } from "./woocommerce.serializers.js";

const requiredHeaders = [
  "x-wc-webhook-source",
  "x-wc-webhook-topic",
  "x-wc-webhook-resource",
  "x-wc-webhook-event",
  "x-wc-webhook-signature",
  "x-wc-webhook-id",
  "x-wc-webhook-delivery-id"
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

export function validateWooCommerceWebhookFoundation(input: {
  headers: Record<string, unknown>;
  body?: unknown;
  secret?: string | undefined;
}) {
  const missingHeaders = requiredHeaders.filter((header) => !headerValue(input.headers, header));
  const signature = headerValue(input.headers, "x-wc-webhook-signature");
  const source = headerValue(input.headers, "x-wc-webhook-source") || null;
  const topic = headerValue(input.headers, "x-wc-webhook-topic") || null;
  const resource = headerValue(input.headers, "x-wc-webhook-resource") || null;
  const event = headerValue(input.headers, "x-wc-webhook-event") || null;
  const webhookId = headerValue(input.headers, "x-wc-webhook-id") || null;
  const deliveryId = headerValue(input.headers, "x-wc-webhook-delivery-id") || null;
  let status: "VALID" | "INVALID" | "NOT_CONFIGURED" = missingHeaders.length ? "INVALID" : "NOT_CONFIGURED";

  if (!missingHeaders.length && input.secret) {
    const expected = createHmac("sha256", input.secret)
      .update(bodyString(input.body))
      .digest("base64");
    status = safeCompare(signature, expected) ? "VALID" : "INVALID";
  }

  return serializeWooCommerceWebhookValidation({
    status,
    missingHeaders,
    source,
    topic,
    resource,
    event,
    webhookId,
    deliveryId,
    signatureConfigured: Boolean(input.secret)
  });
}
