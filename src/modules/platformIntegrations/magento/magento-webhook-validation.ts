import { createHmac, timingSafeEqual } from "node:crypto";
import { serializeMagentoWebhookValidation } from "./magento.serializers.js";

const requiredHeaders = [
  "x-magento-topic",
  "x-magento-event",
  "x-magento-webhook-id",
  "x-magento-signature"
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

export function validateMagentoWebhookFoundation(input: {
  headers: Record<string, unknown>;
  body?: unknown;
  secret?: string | undefined;
}) {
  const missingHeaders = requiredHeaders.filter((header) => !headerValue(input.headers, header));
  const signature = headerValue(input.headers, "x-magento-signature");
  const topic = headerValue(input.headers, "x-magento-topic") || null;
  const event = headerValue(input.headers, "x-magento-event") || headerValue(input.headers, "x-adobe-commerce-event") || null;
  const store = headerValue(input.headers, "x-magento-store") || null;
  const webhookId = headerValue(input.headers, "x-magento-webhook-id") || headerValue(input.headers, "x-adobe-commerce-webhook-id") || null;
  let status: "VALID" | "INVALID" | "NOT_CONFIGURED" = missingHeaders.length ? "INVALID" : "NOT_CONFIGURED";

  if (!missingHeaders.length && input.secret) {
    const expected = createHmac("sha256", input.secret)
      .update(bodyString(input.body))
      .digest("base64");
    status = safeCompare(signature, expected) ? "VALID" : "INVALID";
  }

  return serializeMagentoWebhookValidation({
    status,
    missingHeaders,
    topic,
    event,
    store,
    webhookId,
    signatureConfigured: Boolean(input.secret)
  });
}
