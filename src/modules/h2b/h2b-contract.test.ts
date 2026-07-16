import assert from "node:assert/strict";
import test from "node:test";
import { extractH2BSafeEnvelope } from "./h2b-safe-envelope.js";
import { H2B_INITIAL_TOPICS, H2B_MAGENTO_INTERNAL_EVENT_HOOK, H2B_MAGENTO_TOPIC, topicForProvider } from "./h2b.types.js";
import { h2bEndpointFingerprint } from "./h2b-endpoint.service.js";
import { allowH2BRequest, h2bRateLimitKey, resetH2BRateLimitForTests } from "./h2b-rate-limit.js";

test("H2B topic allowlists are frozen and Magento uses the semantic topic", () => {
  assert.deepEqual(H2B_INITIAL_TOPICS.SHOPIFY, ["orders/create", "orders/updated"]);
  assert.deepEqual(H2B_INITIAL_TOPICS.WOOCOMMERCE, ["order.created", "order.updated"]);
  assert.deepEqual(H2B_INITIAL_TOPICS.MAGENTO, [H2B_MAGENTO_TOPIC]);
  assert.equal(H2B_MAGENTO_INTERNAL_EVENT_HOOK, "TBD_AFTER_MAGENTO_EXTENSION_EVENT_AUDIT");
  assert.equal(topicForProvider("MAGENTO", { "x-magento-topic": "sales_order_place_after" }), "sales_order_place_after");
  assert.equal(topicForProvider("SHOPIFY", { "x-shopify-topic": "ORDERS/CREATE" }), "ORDERS/CREATE");
  assert.equal((H2B_INITIAL_TOPICS.MAGENTO as readonly string[]).includes("sales_order_place_after"), false);
});

test("H2B safe envelope allowlists fields and excludes buyer PII", () => {
  const envelope = extractH2BSafeEnvelope("SHOPIFY", "orders/create", {
    id: "order-1",
    name: "#1",
    total_price: "1499",
    currency: "INR",
    customer: { email: "buyer@example.invalid", phone: "0000000000" },
    shipping_address: { address1: "secret street" },
    line_items: [{ product_id: "p1", variant_id: "v1", sku: "sku-1", quantity: 2 }]
  });
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes("buyer@example.invalid"), false);
  assert.equal(serialized.includes("secret street"), false);
  assert.equal(serialized.includes("1499"), true);
  assert.equal(envelope.lineItems.length, 1);
});

test("endpoint fingerprint is fixed length and rate keys are pseudonymous", () => {
  const fingerprint = h2bEndpointFingerprint("A".repeat(43));
  assert.match(fingerprint, /^[a-f0-9]{16}$/);
  assert.equal(h2bRateLimitKey(fingerprint, "127.0.0.1").includes("127.0.0.1"), false);
  resetH2BRateLimitForTests();
  for (let index = 0; index < 60; index += 1) assert.equal(allowH2BRequest(fingerprint, "127.0.0.1", 1_000), true);
  assert.equal(allowH2BRequest(fingerprint, "127.0.0.1", 1_000), false);
  resetH2BRateLimitForTests();
});
