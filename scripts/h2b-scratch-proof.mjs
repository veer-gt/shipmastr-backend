import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";

const databaseUrl = process.env.DATABASE_URL ?? "";
const parsedDatabaseUrl = new URL(databaseUrl);
const scratchName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
if (!/^shipmastr_scratch_h2b2_[a-z0-9_]+$/.test(scratchName)
  || !["127.0.0.1", "localhost"].includes(parsedDatabaseUrl.hostname)) {
  throw new Error("H2B_SCRATCH_DATABASE_GUARD_FAILED");
}

const { prisma } = await import("../dist/lib/prisma.js");
const { createApp } = await import("../dist/server.js");
const { createH2BEndpoint, resolveH2BEndpoint, rotateH2BEndpoint, revokeH2BEndpoint } = await import("../dist/modules/h2b/h2b-endpoint.service.js");
const { runH2BOutboxOnce } = await import("../dist/modules/h2b/h2b-worker.js");
const { configurePlatformWebhookCredential, rotatePlatformWebhookCredential } = await import("../dist/modules/credentialVault/platform-webhook-credential.service.js");
const { PLATFORM_WEBHOOK_SIGNATURE_PURPOSE } = await import("../dist/modules/credentialVault/platform-webhook-credential.crypto.js");
const { resetH2BRateLimitForTests } = await import("../dist/modules/h2b/h2b-rate-limit.js");

const fixtureMarker = `h2b-scratch-${Date.now()}-${randomBytes(4).toString("hex")}`;
const createdMerchants = [];
const createdConnections = [];
const createdEndpoints = [];
const generatedSecrets = new Map();

function hmac(secret, body) {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function request(server, path, headers, body, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (!chunked) requestHeaders["content-length"] = Buffer.byteLength(body);
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("H2B_LOOPBACK_SERVER_ADDRESS_MISSING"));
    const client = http.request({ hostname: "127.0.0.1", port: address.port, method: "POST", path, headers: requestHeaders }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    client.on("error", reject);
    if (chunked) {
      client.write(body.slice(0, Math.floor(body.length / 2)));
      client.end(body.slice(Math.floor(body.length / 2)));
    } else {
      client.end(body);
    }
  });
}

function fixture(provider, topic, externalOrderId, secret) {
  const total = provider === "SHOPIFY" ? "598.94" : provider === "WOOCOMMERCE" ? "1499.00" : "2500.50";
  const payload = JSON.stringify({
    id: externalOrderId,
    name: `#${externalOrderId}`,
    total_price: total,
    currency: "INR",
    updated_at: "2026-07-16T12:00:00Z",
    customer: { email: "buyer@example.invalid", phone: "0000000000" },
    shipping_address: { address1: "private address" },
    line_items: [{ product_id: "product-1", variant_id: "variant-1", sku: "sku-1", quantity: 1 }]
  });
  const deliveryId = `${provider.toLowerCase()}-${externalOrderId}-${randomBytes(3).toString("hex")}`;
  const headers = provider === "SHOPIFY"
    ? {
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": "scratch.example",
      "x-shopify-webhook-id": deliveryId,
      "x-shopify-hmac-sha256": hmac(secret, payload)
    }
    : provider === "WOOCOMMERCE"
      ? {
        "x-wc-webhook-topic": topic,
        "x-wc-webhook-source": "https://scratch.example",
        "x-wc-webhook-id": deliveryId,
        "x-wc-webhook-signature": hmac(secret, payload)
      }
      : {
        "x-magento-topic": topic,
        "x-magento-event": "order_committed",
        "x-magento-webhook-id": deliveryId,
        "x-magento-signature": hmac(secret, payload)
      };
  return { payload, headers, deliveryId };
}

async function createMerchant(label) {
  const merchant = await prisma.merchant.create({ data: { name: `${fixtureMarker}-${label}`, email: `${fixtureMarker}-${label}@example.invalid` } });
  createdMerchants.push(merchant.id);
  return merchant;
}

async function createConnection(merchantId, platform) {
  const connection = await prisma.platformConnection.create({
    data: {
      merchantId,
      platform,
      storeName: `${fixtureMarker}-${platform}`,
      storeUrl: `https://${fixtureMarker.toLowerCase()}.example/${platform.toLowerCase()}`,
      status: "ACTIVE",
      syncDirection: "IMPORT_ONLY"
    }
  });
  createdConnections.push(connection.id);
  const secret = `${fixtureMarker}-${platform}-${randomBytes(16).toString("hex")}`;
  generatedSecrets.set(connection.id, { current: secret, previous: null });
  await configurePlatformWebhookCredential(merchantId, connection.id, { platform, secret });
  const endpoint = await createH2BEndpoint(merchantId, connection.id);
  assert.equal(endpoint.rawEndpointReturned, true);
  assert.equal(typeof endpoint.endpoint, "string");
  assert.equal(endpoint.endpoint.length, 47);
  assert.equal(JSON.stringify(endpoint.status).includes(endpoint.endpoint), false);
  createdEndpoints.push({ merchantId, connectionId: connection.id, token: endpoint.endpoint });
  return { connection, endpoint: endpoint.endpoint };
}

async function countFor(merchantId, connectionId) {
  const [admissions, outboxes, aggregates] = await Promise.all([
    prisma.h2BWebhookAdmission.count({ where: { merchantId, connectionId } }),
    prisma.h2BWebhookOutbox.count({ where: { merchantId, connectionId } }),
    prisma.h2BExternalOrderAggregate.count({ where: { merchantId, connectionId } })
  ]);
  return { admissions, outboxes, aggregates };
}

const app = await createApp({ h2bEnabled: true });
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const merchantA = await createMerchant("merchant-a");
  const merchantB = await createMerchant("merchant-b");
  const fixturesA = {};
  for (const platform of ["SHOPIFY", "WOOCOMMERCE", "MAGENTO"]) {
    fixturesA[platform] = await createConnection(merchantA.id, platform);
  }
  const fixtureB = await createConnection(merchantB.id, "SHOPIFY");

  const concurrentConnection = await prisma.platformConnection.create({ data: { merchantId: merchantA.id, platform: "SHOPIFY", storeName: `${fixtureMarker}-CONCURRENT`, storeUrl: `https://${fixtureMarker.toLowerCase()}.example/concurrent`, status: "ACTIVE", syncDirection: "IMPORT_ONLY" } });
  createdConnections.push(concurrentConnection.id);
  const createRace = await Promise.allSettled(Array.from({ length: 16 }, () => createH2BEndpoint(merchantA.id, concurrentConnection.id)));
  assert.equal(createRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(createRace.filter((result) => result.status === "rejected").length, 15);
  const committedEndpoint = createRace.find((result) => result.status === "fulfilled").value.endpoint;
  await resolveH2BEndpoint(committedEndpoint);
  const rotateRace = await Promise.allSettled(Array.from({ length: 16 }, () => rotateH2BEndpoint(merchantA.id, concurrentConnection.id)));
  assert.equal(rotateRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(rotateRace.filter((result) => result.status === "rejected").length, 15);
  const concurrentRotatedEndpoint = rotateRace.find((result) => result.status === "fulfilled").value.endpoint;
  await resolveH2BEndpoint(concurrentRotatedEndpoint);
  await revokeH2BEndpoint(merchantA.id, concurrentConnection.id);
  assert.equal((await prisma.h2BConnectionEndpoint.findUnique({ where: { connectionId: concurrentConnection.id }, select: { status: true } }))?.status, "REVOKED");

  for (const [provider, topic] of [["SHOPIFY", "orders/create"], ["WOOCOMMERCE", "order.created"], ["MAGENTO", "shipmastr.order.committed.v1"]]) {
    const connectionId = fixturesA[provider].connection.id;
    const secret = generatedSecrets.get(connectionId).current;
    const payload = fixture(provider, topic, `${provider.toLowerCase()}-order-1`, secret);
    const path = `/api/public/provider-webhooks/${fixturesA[provider].endpoint}`;
    const accepted = await request(server, path, payload.headers, payload.payload);
    assert.equal(accepted.status, 202);
    const duplicate = await request(server, path, payload.headers, payload.payload);
    assert.equal(duplicate.status, 200);
  }

  const shopifyId = fixturesA.SHOPIFY.connection.id;
  const shopifyPath = `/api/public/provider-webhooks/${fixturesA.SHOPIFY.endpoint}`;
  const unsupported = fixture("SHOPIFY", "products/create", "unsupported-order", generatedSecrets.get(shopifyId).current);
  assert.equal((await request(server, shopifyPath, unsupported.headers, unsupported.payload)).status, 202);
  assert.equal((await request(server, shopifyPath, { ...unsupported.headers, "x-shopify-hmac-sha256": hmac("wrong", unsupported.payload) }, unsupported.payload)).status, 401);

  const beforeRace = await countFor(merchantA.id, shopifyId);
  const raced = fixture("SHOPIFY", "orders/updated", "race-order", generatedSecrets.get(shopifyId).current);
  const raceResults = await Promise.all(Array.from({ length: 16 }, () => request(server, shopifyPath, raced.headers, raced.payload)));
  assert.equal(raceResults.filter((result) => result.status === 202 || result.status === 200).length, 16);
  const afterRace = await countFor(merchantA.id, shopifyId);
  assert.equal(afterRace.admissions - beforeRace.admissions, 1);
  assert.equal(afterRace.outboxes - beforeRace.outboxes, 1);
  const collisionPayload = JSON.stringify({ id: "collision-order", total_price: "1.00", currency: "INR" });
  const collisionHeaders = { ...raced.headers, "x-shopify-hmac-sha256": hmac(generatedSecrets.get(shopifyId).current, collisionPayload) };
  assert.equal((await request(server, shopifyPath, collisionHeaders, collisionPayload)).status, 409);
  const afterCollision = await countFor(merchantA.id, shopifyId);
  assert.deepEqual(afterCollision, afterRace);

  const chunked = fixture("SHOPIFY", "orders/updated", "chunked-order", generatedSecrets.get(shopifyId).current);
  assert.equal((await request(server, shopifyPath, chunked.headers, chunked.payload, { chunked: true })).status, 202);
  const oversizedBody = JSON.stringify({ id: "oversized", padding: "x".repeat(262_144) });
  const oversizedHeaders = { "x-shopify-topic": "orders/create", "x-shopify-shop-domain": "scratch.example", "x-shopify-webhook-id": "oversized", "x-shopify-hmac-sha256": hmac(generatedSecrets.get(shopifyId).current, oversizedBody) };
  assert.equal((await request(server, shopifyPath, oversizedHeaders, oversizedBody)).status, 413);
  const malformed = await request(server, "/api/public/provider-webhooks/not-an-endpoint", {}, "not-json");
  assert.equal(malformed.status, 404);
  assert.deepEqual(JSON.parse(malformed.body), { error: "H2B_ROUTE_NOT_FOUND" });
  const unknownToken = `shp_${randomBytes(32).toString("base64url")}`;
  const beforeUnknown = await countFor(merchantA.id, shopifyId);
  const unknown = await request(server, `/api/public/provider-webhooks/${unknownToken}`, raced.headers, raced.payload);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await countFor(merchantA.id, shopifyId), beforeUnknown);

  const wrongTenant = fixture("SHOPIFY", "orders/create", "wrong-tenant", generatedSecrets.get(fixtureB.connection.id).current);
  assert.equal((await request(server, shopifyPath, wrongTenant.headers, wrongTenant.payload)).status, 401);
  assert.equal((await request(server, `/api/public/provider-webhooks/${fixtureB.endpoint}`, { ...wrongTenant.headers, "x-shopify-hmac-sha256": hmac(generatedSecrets.get(shopifyId).current, wrongTenant.payload) }, wrongTenant.payload)).status, 401);

  const oldEndpoint = fixturesA.SHOPIFY.endpoint;
  const rotatedEndpoint = await rotateH2BEndpoint(merchantA.id, shopifyId);
  fixturesA.SHOPIFY.endpoint = rotatedEndpoint.endpoint;
  const rotatedPayload = fixture("SHOPIFY", "orders/create", "rotated-endpoint", generatedSecrets.get(shopifyId).current);
  assert.equal((await request(server, `/api/public/provider-webhooks/${oldEndpoint}`, rotatedPayload.headers, rotatedPayload.payload)).status, 202);
  await prisma.h2BConnectionEndpoint.update({ where: { connectionId: shopifyId }, data: { previousValidUntil: new Date(0) } });
  assert.equal((await request(server, `/api/public/provider-webhooks/${oldEndpoint}`, rotatedPayload.headers, rotatedPayload.payload)).status, 404);
  await revokeH2BEndpoint(merchantA.id, shopifyId);
  assert.equal((await request(server, `/api/public/provider-webhooks/${rotatedEndpoint.endpoint}`, rotatedPayload.headers, rotatedPayload.payload)).status, 404);

  const wooId = fixturesA.WOOCOMMERCE.connection.id;
  const oldWooSecret = generatedSecrets.get(wooId).current;
  const newWooSecret = `${fixtureMarker}-woo-rotated-${randomBytes(8).toString("hex")}`;
  await rotatePlatformWebhookCredential(merchantA.id, wooId, { replacementSecret: newWooSecret, gracePeriodSeconds: 3600 });
  generatedSecrets.set(wooId, { current: newWooSecret, previous: oldWooSecret });
  const previousPayload = fixture("WOOCOMMERCE", "order.updated", "previous-secret", oldWooSecret);
  assert.equal((await request(server, `/api/public/provider-webhooks/${fixturesA.WOOCOMMERCE.endpoint}`, previousPayload.headers, previousPayload.payload)).status, 202);
  const oldAfterExpiry = fixture("WOOCOMMERCE", "order.updated", "expired-secret", oldWooSecret);
  await prisma.platformWebhookCredential.update({ where: { connectionId_purpose: { connectionId: wooId, purpose: PLATFORM_WEBHOOK_SIGNATURE_PURPOSE } }, data: { previousValidUntil: new Date(0) } });
  assert.equal((await request(server, `/api/public/provider-webhooks/${fixturesA.WOOCOMMERCE.endpoint}`, oldAfterExpiry.headers, oldAfterExpiry.payload)).status, 401);

  // Expire one claimed lease before the worker runs; it must be recoverable.
  const recoverable = await prisma.h2BWebhookOutbox.findFirst({ where: { merchantId: merchantA.id, status: "PENDING" } });
  assert.ok(recoverable);
  await prisma.h2BWebhookOutbox.update({ where: { id: recoverable.id }, data: { status: "CLAIMED", leaseUntil: new Date(0) } });
  await runH2BOutboxOnce({ maxBatch: 100, now: new Date() });
  assert.equal((await prisma.h2BWebhookOutbox.findUnique({ where: { id: recoverable.id }, select: { status: true } }))?.status, "PROCESSED");
  const processed = await prisma.h2BWebhookOutbox.count({ where: { merchantId: merchantA.id, status: "PROCESSED" } });
  assert.ok(processed >= 4);
  // The fixture helper prefixes the provider name in its synthetic order ID.
  const wooAggregateCount = await prisma.h2BExternalOrderAggregate.count({ where: { merchantId: merchantA.id, connectionId: wooId, externalOrderId: "woocommerce-order-1" } });
  assert.equal(wooAggregateCount, 1);
  const wooAggregate = await prisma.h2BExternalOrderAggregate.findFirst({ where: { merchantId: merchantA.id, connectionId: wooId, externalOrderId: "woocommerce-order-1" }, select: { safeState: true } });
  assert.equal(wooAggregate?.safeState && typeof wooAggregate.safeState === "object" && wooAggregate.safeState.totalMinor, "149900");

  const rollbackFixture = fixture("WOOCOMMERCE", "order.created", "rollback-trigger", generatedSecrets.get(wooId).current);
  const rollbackPath = `/api/public/provider-webhooks/${fixturesA.WOOCOMMERCE.endpoint}`;
  const beforeRollback = await countFor(merchantA.id, wooId);
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION h2b_scratch_fail_outbox() RETURNS trigger AS $$ BEGIN IF NEW.envelope->>'externalOrderId' = 'rollback-trigger' THEN RAISE EXCEPTION 'H2B_SCRATCH_OUTBOX_FAILURE'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER h2b_scratch_fail_outbox BEFORE INSERT ON h2b_webhook_outbox FOR EACH ROW EXECUTE FUNCTION h2b_scratch_fail_outbox()`);
  assert.equal((await request(server, rollbackPath, rollbackFixture.headers, rollbackFixture.payload)).status, 500);
  assert.deepEqual(await countFor(merchantA.id, wooId), beforeRollback);
  await prisma.$executeRawUnsafe(`DROP TRIGGER h2b_scratch_fail_outbox ON h2b_webhook_outbox`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION h2b_scratch_fail_outbox()`);
  assert.equal((await request(server, rollbackPath, rollbackFixture.headers, rollbackFixture.payload)).status, 202);

  let rolledBack = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.h2BWebhookAdmission.create({ data: { merchantId: merchantA.id, connectionId: wooId, platform: "WOOCOMMERCE", topic: "order.updated", deliveryId: `${fixtureMarker}-rollback`, payloadSha256: "rollback", safeEnvelope: { schemaVersion: "test" } } });
      throw new Error("ROLLBACK_TEST");
    });
  } catch {
    rolledBack = true;
  }
  assert.equal(rolledBack, true);
  assert.equal(await prisma.h2BWebhookAdmission.count({ where: { deliveryId: `${fixtureMarker}-rollback` } }), 0);

  const persisted = await prisma.h2BWebhookAdmission.findMany({ where: { merchantId: merchantA.id }, select: { safeEnvelope: true, payloadSha256: true } });
  const serialized = JSON.stringify(persisted);
  for (const forbidden of ["buyer@example.invalid", "0000000000", "private address", generatedSecrets.get(wooId).current]) assert.equal(serialized.includes(forbidden), false);
  resetH2BRateLimitForTests();
  console.log(JSON.stringify({ scratch: "PASS", merchants: 2, providers: 3, duplicateRace: "PASS", endpointConcurrency: "PASS", rollback: "PASS", leakage: "PASS", worker: "PASS" }));
} finally {
  server.close();
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS h2b_scratch_fail_outbox ON h2b_webhook_outbox`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS h2b_scratch_fail_outbox()`);
  for (const connectionId of createdConnections) {
    await prisma.h2BWebhookOutbox.deleteMany({ where: { connectionId } });
    await prisma.h2BWebhookAdmission.deleteMany({ where: { connectionId } });
    await prisma.h2BExternalOrderAggregate.deleteMany({ where: { connectionId } });
    await prisma.h2BConnectionEndpoint.deleteMany({ where: { connectionId } });
    await prisma.platformWebhookCredential.deleteMany({ where: { connectionId } });
    await prisma.platformConnection.deleteMany({ where: { id: connectionId } });
  }
  for (const merchantId of createdMerchants) await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.$disconnect();
}
