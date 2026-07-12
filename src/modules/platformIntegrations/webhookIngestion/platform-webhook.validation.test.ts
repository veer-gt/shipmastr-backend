import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { HttpError } from "../../../lib/httpError.js";
import { validateShopifyWebhookFoundation } from "../shopify/shopify-webhook-validation.js";
import { validateWooCommerceWebhookFoundation } from "../woocommerce/woocommerce-webhook-validation.js";
import {
  assertSupportedPlatformWebhookHeaders,
  parsePlatformWebhookPayload
} from "./platform-webhook.validation.js";

const SHOPIFY_SECRET = "local-test-webhook-secret";

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
    "x-shopify-shop-domain": "demo.myshopify.com",
    "x-shopify-webhook-id": "delivery_1",
    "x-shopify-triggered-at": "2026-07-12T00:00:00.000Z"
  };
  assert.equal(validateShopifyWebhookFoundation({ headers, body: rawBody, secret: SHOPIFY_SECRET }).status, "VALID");
  assert.equal(validateShopifyWebhookFoundation({ headers, body: Buffer.from('{"order_number":"1001","id":123}'), secret: SHOPIFY_SECRET }).status, "INVALID");

  const wooRawBody = Buffer.from('{"id":456,"number":"1002"}');
  const wooSignature = createHmac("sha256", SHOPIFY_SECRET).update(wooRawBody).digest("base64");
  assert.equal(validateWooCommerceWebhookFoundation({
    headers: {
      "x-wc-webhook-source": "https://shop.example",
      "x-wc-webhook-topic": "order.created",
      "x-wc-webhook-resource": "order",
      "x-wc-webhook-event": "created",
      "x-wc-webhook-signature": wooSignature,
      "x-wc-webhook-id": "hook_1",
      "x-wc-webhook-delivery-id": "delivery_2"
    },
    body: wooRawBody,
    secret: SHOPIFY_SECRET
  }).status, "VALID");
});
