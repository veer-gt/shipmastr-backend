import { createHmac, randomBytes } from "node:crypto";

export const PLATFORM_FIXTURE_CONFIG = Object.freeze({
  SHOPIFY: Object.freeze({
    secretEnv: "SHOPIFY_WEBHOOK_SECRET",
    signatureHeader: "x-shopify-hmac-sha256",
    eventHeaders: { "x-shopify-topic": "orders/create", "x-shopify-shop-domain": "fixture-shop.example.test", "x-shopify-webhook-id": "fixture_delivery_shopify_001", "x-shopify-triggered-at": "2026-07-12T00:00:00.000Z" }
  }),
  WOOCOMMERCE: Object.freeze({
    secretEnv: "WOOCOMMERCE_WEBHOOK_SECRET",
    signatureHeader: "x-wc-webhook-signature",
    eventHeaders: { "x-wc-webhook-source": "https://fixture-shop.example.test", "x-wc-webhook-topic": "order.created", "x-wc-webhook-resource": "order", "x-wc-webhook-event": "created", "x-wc-webhook-id": "fixture_hook_woo_001", "x-wc-webhook-delivery-id": "fixture_delivery_woo_001" }
  }),
  MAGENTO: Object.freeze({
    secretEnv: "MAGENTO_WEBHOOK_SECRET",
    signatureHeader: "x-magento-signature",
    eventHeaders: { "x-magento-topic": "sales_order", "x-magento-event": "order.created", "x-magento-webhook-id": "fixture_delivery_magento_001", "x-magento-store": "fixture_store" }
  })
});

export function fixtureSecret(provider, environment = process.env) {
  const name = PLATFORM_FIXTURE_CONFIG[provider]?.secretEnv;
  if (!name) throw new Error(`Unsupported fixture provider: ${provider}`);
  return environment[name] || randomBytes(32).toString("hex");
}

export function fixturePayload(provider) {
  if (provider === "SHOPIFY") return { id: "fixture_order_shopify_001", order_number: "fixture_order_number_001", currency: "INR", line_items: [{ name: "Fixture item", sku: "fixture_sku_001", quantity: 1 }] };
  if (provider === "WOOCOMMERCE") return { id: "fixture_order_woo_001", number: "fixture_order_number_002", currency: "INR", line_items: [{ name: "Fixture item", sku: "fixture_sku_002", quantity: 1 }] };
  if (provider === "MAGENTO") return { entity_id: "fixture_order_magento_001", increment_id: "fixture_order_number_003", order_currency_code: "INR", items: [{ name: "Fixture item", sku: "fixture_sku_003", qty_ordered: 1 }] };
  throw new Error(`Unsupported fixture provider: ${provider}`);
}

export function signedFixture(provider, secret = fixtureSecret(provider)) {
  const config = PLATFORM_FIXTURE_CONFIG[provider];
  const rawBody = Buffer.from(JSON.stringify(fixturePayload(provider)));
  const signature = createHmac("sha256", secret).update(rawBody).digest("base64");
  return { provider, rawBody, headers: { ...config.eventHeaders, [config.signatureHeader]: signature }, signature };
}

export function fixtureJson(provider, secret = fixtureSecret(provider)) {
  const fixture = signedFixture(provider, secret);
  return { provider: fixture.provider, headers: fixture.headers, body: JSON.parse(fixture.rawBody.toString("utf8")) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const provider = process.argv[2]?.toUpperCase();
  if (!provider || !PLATFORM_FIXTURE_CONFIG[provider]) {
    console.error("Usage: node scripts/security-fixtures/platform-webhooks.mjs SHOPIFY|WOOCOMMERCE|MAGENTO");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(fixtureJson(provider), null, 2)}\n`);
}
