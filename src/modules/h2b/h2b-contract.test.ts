import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractH2BSafeEnvelope } from "./h2b-safe-envelope.js";
import { decimalMajorToMinor, endpointParts, H2B_INITIAL_TOPICS, H2B_MAGENTO_INTERNAL_EVENT_HOOK, H2B_MAGENTO_TOPIC, topicForProvider } from "./h2b.types.js";
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
  for (let index = 0; index < 60; index += 1) assert.equal(allowH2BRequest(null, "127.0.0.1", 2_000, "shp"), true);
  assert.equal(allowH2BRequest(null, "127.0.0.1", 2_000, "shp"), false);
  resetH2BRateLimitForTests();
});

test("strict decimal major-unit conversion uses reviewed currency exponents", () => {
  assert.equal(decimalMajorToMinor("598.94", "INR"), "59894");
  assert.equal(decimalMajorToMinor("1499.00", "INR"), "149900");
  assert.equal(decimalMajorToMinor("2500.50", "INR"), "250050");
  assert.equal(decimalMajorToMinor("0", "EUR"), "0");
  assert.equal(decimalMajorToMinor("2500", "JPY"), "2500");
  assert.equal(decimalMajorToMinor("10.125", "KWD"), "10125");
  for (const [value, code] of [["1.001", "INR"], ["-1", "INR"], ["1e2", "INR"], ["01", "INR"], ["1", "ZZZ"]] as const) assert.throws(() => decimalMajorToMinor(value, code));
  assert.throws(() => decimalMajorToMinor(1.5, "INR"));
  assert.throws(() => decimalMajorToMinor("9".repeat(40), "INR"));
});

test("provider hints are routing-only and reject near-prefix tokens", () => {
  const token = `shp_${"A".repeat(43)}`;
  assert.equal(endpointParts(token)?.provider, "SHOPIFY");
  assert.equal(endpointParts(`shp-${"A".repeat(43)}`), null);
  assert.equal(endpointParts(`shp_${"A".repeat(42)}!`), null);
  assert.equal(endpointParts(`shp_${"A".repeat(43)}_evil`), null);
  assert.equal(endpointParts(`xyz_${"A".repeat(43)}`), null);
});

test("unknown endpoint resolution precedes admission and provider-side services", async () => {
  const routes = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "h2b-public.routes.ts").replace(/dist[\\/]modules[\\/]h2b/, "src/modules/h2b"), "utf8").catch(() => readFile(resolve(dirname(fileURLToPath(import.meta.url)), "h2b-public.routes.js"), "utf8"));
  assert.ok(routes.lastIndexOf("await resolveH2BEndpoint") < routes.lastIndexOf("await admitH2BWebhook"));
  assert.equal(routes.includes("credentialVault"), false);
  assert.equal(routes.includes("inventory"), false);
});

test("endpoint token rows provide global digest uniqueness without cross-column triggers", async () => {
  const schema = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../../prisma/schema.prisma"), "utf8");
  const migration = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../../prisma/migrations/20260716113000_h2b_public_provider_ingress_foundation/migration.sql"), "utf8");
  assert.match(schema, /model H2BConnectionEndpointToken/);
  assert.match(schema, /digest\s+String\s+@unique/);
  assert.match(schema, /@@unique\(\[endpointId, role\]\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "h2b_connection_endpoint_tokens_digest_key"/);
  assert.equal(migration.includes("CREATE CONSTRAINT TRIGGER"), false);
});

test("worker fencing and sequence fields are part of every completion path", async () => {
  const worker = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "h2b-worker.ts").replace(/dist[\\/]modules[\\/]h2b/, "src/modules/h2b"), "utf8").catch(() => readFile(resolve(dirname(fileURLToPath(import.meta.url)), "h2b-worker.js"), "utf8"));
  assert.match(worker, /claimVersion/);
  assert.match(worker, /ingestionSequence/);
  assert.match(worker, /FOR UPDATE SKIP LOCKED/);
  assert.match(worker, /status: H2BOutboxStatus\.PROCESSING/);
  assert.match(worker, /status: H2BOutboxStatus\.PROCESSED/);
  assert.match(worker, /H2BOutboxStatus\.DEAD_LETTER/);
});
