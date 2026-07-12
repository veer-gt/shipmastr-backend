import { z } from "zod";
import { HttpError } from "../../../lib/httpError.js";

export const platformWebhookPlatformSchema = z.enum(["SHOPIFY", "WOOCOMMERCE", "MAGENTO"]);

export const platformWebhookStatusSchema = z.enum([
  "RECEIVED",
  "VERIFIED",
  "REJECTED",
  "DUPLICATE",
  "STAGED_FOR_IMPORT",
  "FAILED",
  "IGNORED"
]);

export const platformWebhookEventListQuerySchema = z.object({
  platform: platformWebhookPlatformSchema.optional(),
  status: platformWebhookStatusSchema.optional(),
  connectionId: z.string().trim().min(1).optional(),
  topic: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export const stagePlatformWebhookEventImportSchema = z.object({}).strict();

const MAX_WEBHOOK_DEPTH = 8;
const MAX_WEBHOOK_KEYS = 200;
const MAX_WEBHOOK_ARRAY_ITEMS = 500;
const MAX_WEBHOOK_STRING_CHARS = 20_000;
const WEBHOOK_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

function assertBoundedWebhookValue(value: unknown, depth: number, path: string) {
  if (depth > MAX_WEBHOOK_DEPTH) throw new HttpError(400, "WEBHOOK_PAYLOAD_TOO_DEEP");
  if (typeof value === "string") {
    if (value.length > MAX_WEBHOOK_STRING_CHARS) throw new HttpError(400, "WEBHOOK_FIELD_TOO_LONG");
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > MAX_WEBHOOK_ARRAY_ITEMS) throw new HttpError(400, "WEBHOOK_ARRAY_TOO_LARGE");
    value.forEach((child, index) => assertBoundedWebhookValue(child, depth + 1, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") throw new HttpError(400, "WEBHOOK_PAYLOAD_INVALID");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_WEBHOOK_KEYS) throw new HttpError(400, "WEBHOOK_OBJECT_TOO_LARGE");
  for (const [key, child] of entries) {
    if (!WEBHOOK_KEY_PATTERN.test(key)) throw new HttpError(400, "WEBHOOK_FIELD_NAME_INVALID");
    assertBoundedWebhookValue(child, depth + 1, `${path}.${key}`);
  }
}

function headerValue(headers: Record<string, unknown>, name: string) {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? String(value[0] ?? "").trim().toLowerCase() : String(value ?? "").trim().toLowerCase();
}

export function parsePlatformWebhookPayload(
  platform: "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO",
  payload: unknown
) {
  assertBoundedWebhookValue(payload, 0, "payload");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "WEBHOOK_PAYLOAD_OBJECT_REQUIRED");
  }
  const record = payload as Record<string, unknown>;
  const idFields = platform === "SHOPIFY"
    ? ["id", "order_number"]
    : platform === "WOOCOMMERCE"
      ? ["id", "number"]
      : ["entity_id", "id", "increment_id"];
  if (!idFields.some((field) => record[field] !== undefined && record[field] !== null && String(record[field]).trim())) {
    throw new HttpError(400, "WEBHOOK_ORDER_IDENTIFIER_REQUIRED");
  }
  return record;
}

export function assertSupportedPlatformWebhookHeaders(
  platform: "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO",
  headers: Record<string, unknown>
) {
  if (platform === "SHOPIFY") {
    const topic = headerValue(headers, "x-shopify-topic");
    if (!["orders/create", "orders/created", "order/create", "order/created", "orders/update", "orders/updated", "order/update", "order/updated"].includes(topic)) {
      throw new HttpError(400, "UNSUPPORTED_WEBHOOK_EVENT");
    }
    return;
  }
  if (platform === "WOOCOMMERCE") {
    const topic = headerValue(headers, "x-wc-webhook-topic");
    const resource = headerValue(headers, "x-wc-webhook-resource");
    const event = headerValue(headers, "x-wc-webhook-event");
    if (!(resource === "order" && ["created", "updated"].includes(event)) && !/order[._/-]?(created|updated)/.test(`${topic} ${resource}.${event}`)) {
      throw new HttpError(400, "UNSUPPORTED_WEBHOOK_EVENT");
    }
    return;
  }
  const topic = headerValue(headers, "x-magento-topic");
  const event = headerValue(headers, "x-magento-event") || headerValue(headers, "x-adobe-commerce-event");
  if (!/order[._/-]?(created|updated)|sales_order_save_after|sales_order_place_after/.test(`${topic} ${event}`)) {
    throw new HttpError(400, "UNSUPPORTED_WEBHOOK_EVENT");
  }
}

export type PlatformWebhookEventListQueryInput = z.infer<typeof platformWebhookEventListQuerySchema>;
