import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { HttpError } from "../../../lib/httpError.js";
import { validateMagentoWebhookFoundation } from "../magento/magento-webhook-validation.js";
import { validateShopifyWebhookFoundation } from "../shopify/shopify-webhook-validation.js";
import { validateWooCommerceWebhookFoundation } from "../woocommerce/woocommerce-webhook-validation.js";
import {
  assertSupportedPlatformWebhookHeaders,
  parsePlatformWebhookPayload
} from "./platform-webhook.validation.js";

const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || randomBytes(32).toString("hex");
const WOOCOMMERCE_SECRET = process.env.WOOCOMMERCE_WEBHOOK_SECRET || randomBytes(32).toString("hex");
const MAGENTO_SECRET = process.env.MAGENTO_WEBHOOK_SECRET || randomBytes(32).toString("hex");

function errorCode(run: () => unknown) {
  try {
    run();
    return "";
  } catch (error) {
    return error instanceof HttpError ? error.message : String(error);
  }
}

test("platform webhook payloads are bounded and require provider identifiers", () => {
  assert.equal(errorCode(() => parsePlatformWebhookPayload("SHOPIFY", { note: "missing id" })), "WEBHOOK_ORDER_IDENTIFIER_REQUIRED");
  assert.equal(errorCode(() => parsePlatformWebhookPayload("WOOCOMMERCE", { id: "order_1", "bad key": true })), "WEBHOOK_FIELD_NAME_INVALID");
  assert.equal(errorCode(() => parsePlatformWebhookPayload("MAGENTO", "not-an-object")), "WEBHOOK_PAYLOAD_OBJECT_REQUIRED");
  assert.deepEqual(parsePlatformWebhookPayload("SHOPIFY", { id: 123, line_items: [] }), { id: 123, line_items: [] });
});

test("provider event allowlists reject unsupported topics without payload logging", () => {
  assert.equal(errorCode(() => assertSupportedPlatformWebhookHeaders("SHOPIFY", { "x-shopify-topic": "products/create" })), "UNSUPPORTED_WEBHOOK_EVENT");
  assert.equal(errorCode(() => assertSupportedPlatformWebhookHeaders("WOOCOMMERCE", { "x-wc-webhook-resource": "product", "x-wc-webhook-event": "created" })), "UNSUPPORTED_WEBHOOK_EVENT");
  assert.equal(errorCode(() => assertSupportedPlatformWebhookHeaders("MAGENTO", { "x-magento-event": "customer.created" })), "UNSUPPORTED_WEBHOOK_EVENT");
  assert.doesNotThrow(() => assertSupportedPlatformWebhookHeaders("SHOPIFY", { "x-shopify-topic": "orders/create" }));
});

test("raw body bytes, not reserialized JSON, are used for provider signatures", () => {
  const rawBody = Buffer.from('{"id":123,"order_number":"1001"}');
  const signature = createHmac("sha256", SHOPIFY_SECRET).update(rawBody).digest("base64");
  const headers = {
    "x-shopify-hmac-sha256": signature,
    "x-shopify-topic": "orders/create",
    "x-shopify-shop-domain": "fixture-shop.example.test",
    "x-shopify-webhook-id": "delivery_1",
    "x-shopify-triggered-at": "2026-07-12T00:00:00.000Z"
  };
  assert.equal(validateShopifyWebhookFoundation({ headers, body: rawBody, secret: SHOPIFY_SECRET }).status, "VALID");
  assert.equal(validateShopifyWebhookFoundation({ headers, body: Buffer.from('{"order_number":"1001","id":123}'), secret: SHOPIFY_SECRET }).status, "INVALID");

  const wooRawBody = Buffer.from('{"id":456,"number":"1002"}');
  const wooSignature = createHmac("sha256", WOOCOMMERCE_SECRET).update(wooRawBody).digest("base64");
  assert.equal(validateWooCommerceWebhookFoundation({
    headers: {
      "x-wc-webhook-source": "https://fixture-shop.example.test",
      "x-wc-webhook-topic": "order.created",
      "x-wc-webhook-resource": "order",
      "x-wc-webhook-event": "created",
      "x-wc-webhook-signature": wooSignature,
      "x-wc-webhook-id": "hook_1",
      "x-wc-webhook-delivery-id": "delivery_2"
    },
    body: wooRawBody,
    secret: WOOCOMMERCE_SECRET
  }).status, "VALID");
});

test("synthetic provider fixtures cover valid, malformed, missing, unsupported, and fail-closed cases", () => {
  const cases = [
    {
      secret: SHOPIFY_SECRET,
      body: Buffer.from('{"id":"fixture_order_shopify_001","order_number":"fixture_order_number_001"}'),
      headers: { "x-shopify-topic": "orders/create", "x-shopify-shop-domain": "fixture-shop.example.test", "x-shopify-webhook-id": "fixture_delivery_shopify_002", "x-shopify-triggered-at": "2026-07-12T00:00:00.000Z" },
      header: "x-shopify-hmac-sha256",
      validate: validateShopifyWebhookFoundation
    },
    {
      secret: WOOCOMMERCE_SECRET,
      body: Buffer.from('{"id":"fixture_order_woo_001","number":"fixture_order_number_002"}'),
      headers: { "x-wc-webhook-source": "https://fixture-shop.example.test", "x-wc-webhook-topic": "order.created", "x-wc-webhook-resource": "order", "x-wc-webhook-event": "created", "x-wc-webhook-id": "fixture_hook_woo_002", "x-wc-webhook-delivery-id": "fixture_delivery_woo_002" },
      header: "x-wc-webhook-signature",
      validate: validateWooCommerceWebhookFoundation
    },
    {
      secret: MAGENTO_SECRET,
      body: Buffer.from('{"entity_id":"fixture_order_magento_001","increment_id":"fixture_order_number_003"}'),
      headers: { "x-magento-topic": "sales_order", "x-magento-event": "order.created", "x-magento-webhook-id": "fixture_delivery_magento_002", "x-magento-store": "fixture_store" },
      header: "x-magento-signature",
      validate: validateMagentoWebhookFoundation
    }
  ] as const;
  for (const item of cases) {
    const signature = createHmac("sha256", item.secret).update(item.body).digest("base64");
    const headers: Record<string, unknown> = { ...item.headers, [item.header]: signature };
    assert.equal(item.validate({ headers, body: item.body, secret: item.secret }).status, "VALID");
    assert.equal(item.validate({ headers: { ...headers, [item.header]: `${signature.slice(0, -1)}!` }, body: item.body, secret: item.secret }).status, "INVALID");
    assert.equal(item.validate({ headers: { ...headers, [item.header]: "%%%" }, body: item.body, secret: item.secret }).status, "INVALID");
    const missing = { ...headers };
    delete missing[item.header];
    assert.equal(item.validate({ headers: missing, body: item.body, secret: item.secret }).status, "INVALID");
    assert.equal(item.validate({ headers, body: item.body, secret: undefined }).status, "NOT_CONFIGURED");
    assert.equal(item.validate({ headers, body: Buffer.from(`${item.body.toString("utf8")} `), secret: item.secret }).status, "INVALID");
  }
  assert.equal(errorCode(() => parsePlatformWebhookPayload("SHOPIFY", { id: "fixture_order_001", nested: "x".repeat(20_001) })), "WEBHOOK_FIELD_TOO_LONG");
  assert.equal(errorCode(() => assertSupportedPlatformWebhookHeaders("SHOPIFY", { "x-shopify-topic": "products/create" })), "UNSUPPORTED_WEBHOOK_EVENT");
});
