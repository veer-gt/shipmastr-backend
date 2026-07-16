import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import http from "node:http";

const databaseUrl = process.env.DATABASE_URL ?? "";
const parsedDatabaseUrl = new URL(databaseUrl);
const scratchName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
if (!/^shipmastr_scratch_h2b2_final3_[a-z0-9_]+$/.test(scratchName)
  || !["127.0.0.1", "localhost"].includes(parsedDatabaseUrl.hostname)) {
  throw new Error("H2B_SCRATCH_DATABASE_GUARD_FAILED");
}

const { prisma } = await import("../dist/lib/prisma.js");
const { createApp } = await import("../dist/server.js");
const { createH2BEndpoint, getH2BEndpointStatus, resolveH2BEndpoint, rotateH2BEndpoint, revokeH2BEndpoint } = await import("../dist/modules/h2b/h2b-endpoint.service.js");
const { claimOneH2BOutbox, failClaimedH2BOutbox, processClaimedH2BOutbox, runH2BOutboxOnce } = await import("../dist/modules/h2b/h2b-worker.js");
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

async function createBareConnection(merchantId, platform = "SHOPIFY", status = "ACTIVE") {
  const connection = await prisma.platformConnection.create({ data: {
    merchantId, platform, storeName: `${fixtureMarker}-${platform}-BARE`, storeUrl: `https://${fixtureMarker.toLowerCase()}.example/bare`, status, syncDirection: "IMPORT_ONLY"
  } });
  createdConnections.push(connection.id);
  return connection;
}

async function createPendingEvent(merchantId, connectionId, platform, topic, externalOrderId, fields, receivedAt = new Date()) {
  const envelope = { externalOrderId, externalOrderName: `#${externalOrderId}`, ...fields };
  const admission = await prisma.h2BWebhookAdmission.create({ data: {
    merchantId, connectionId, platform, topic, deliveryId: `${fixtureMarker}-${externalOrderId}-${randomBytes(4).toString("hex")}`,
    payloadSha256: `${fixtureMarker}-${externalOrderId}-${randomBytes(4).toString("hex")}`, safeEnvelope: envelope, status: "ACCEPTED", acceptedAt: receivedAt, receivedAt
  } });
  await prisma.h2BWebhookOutbox.create({ data: { admissionId: admission.id, merchantId, connectionId, platform, topic, envelope, status: "PENDING" } });
  return admission;
}

async function claimPair(now = new Date()) {
  const [first, second] = await Promise.all([claimOneH2BOutbox(prisma, now), claimOneH2BOutbox(prisma, now)]);
  assert.ok(first && second);
  return [first, second];
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

  const rejectedConnections = [];
  for (const status of ["DRAFT", "ERROR", "DISABLED"]) {
    const rejected = await createBareConnection(merchantA.id, "SHOPIFY", status);
    rejectedConnections.push(rejected.id);
    await assert.rejects(() => createH2BEndpoint(merchantA.id, rejected.id), (error) => error?.status === 409);
    await assert.rejects(() => rotateH2BEndpoint(merchantA.id, rejected.id), (error) => error?.status === 409);
  }

  for (const status of ["DRAFT", "ERROR", "DISABLED"]) {
    const statusConnection = await createBareConnection(merchantA.id);
    await createH2BEndpoint(merchantA.id, statusConnection.id);
    await prisma.platformConnection.update({ where: { id: statusConnection.id }, data: { status } });
    assert.equal((await getH2BEndpointStatus(merchantA.id, statusConnection.id))?.status, "ACTIVE");
    assert.equal((await revokeH2BEndpoint(merchantA.id, statusConnection.id))?.status, "REVOKED");
  }

  const lifecycleFixture = await createConnection(merchantA.id, "SHOPIFY");
  const lifecycleRotated = await rotateH2BEndpoint(merchantA.id, lifecycleFixture.connection.id);
  await prisma.platformConnection.update({ where: { id: lifecycleFixture.connection.id }, data: { status: "DISABLED" } });
  const disabledStatus = await getH2BEndpointStatus(merchantA.id, lifecycleFixture.connection.id);
  assert.equal(disabledStatus?.status, "ACTIVE");
  const disabledRevoke = await revokeH2BEndpoint(merchantA.id, lifecycleFixture.connection.id);
  assert.equal(disabledRevoke?.status, "REVOKED");
  await prisma.platformConnection.update({ where: { id: lifecycleFixture.connection.id }, data: { status: "ACTIVE" } });
  assert.equal((await getH2BEndpointStatus(merchantA.id, lifecycleFixture.connection.id))?.status, "REVOKED");
  const lifecycleBefore = await countFor(merchantA.id, lifecycleFixture.connection.id);
  for (const token of [lifecycleFixture.endpoint, lifecycleRotated.endpoint]) {
    const reenableFixture = fixture("SHOPIFY", "orders/create", `reenable-${token.length}`, generatedSecrets.get(lifecycleFixture.connection.id).current);
    const safe404 = await request(server, `/api/public/provider-webhooks/${token}`, reenableFixture.headers, reenableFixture.payload);
    assert.equal(safe404.status, 404);
    assert.deepEqual(JSON.parse(safe404.body), { error: "H2B_ROUTE_NOT_FOUND" });
  }
  assert.deepEqual(await countFor(merchantA.id, lifecycleFixture.connection.id), lifecycleBefore);

  let rotateRevokePasses = 0;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const raceConnection = await createBareConnection(merchantA.id);
    const raceEndpoint = await createH2BEndpoint(merchantA.id, raceConnection.id);
    const [rotated, revoked] = await Promise.allSettled([
      rotateH2BEndpoint(merchantA.id, raceConnection.id),
      revokeH2BEndpoint(merchantA.id, raceConnection.id)
    ]);
    assert.equal(revoked.status, "fulfilled");
    const row = await prisma.h2BConnectionEndpoint.findUnique({ where: { connectionId: raceConnection.id }, include: { tokens: true } });
    assert.equal(row?.status, "REVOKED");
    assert.equal(row?.tokens.filter((token) => !token.revokedAt && (!token.validUntil || token.validUntil > new Date())).length, 0);
    for (const token of [raceEndpoint.endpoint, rotated.status === "fulfilled" ? rotated.value.endpoint : null].filter((value) => value)) {
      await assert.rejects(() => resolveH2BEndpoint(token), (error) => error?.status === 404);
    }
    assert.deepEqual(await countFor(merchantA.id, raceConnection.id), { admissions: 0, outboxes: 0, aggregates: 0 });
    rotateRevokePasses += 1;
  }

  const tokenOwner = await prisma.h2BConnectionEndpoint.findUnique({ where: { connectionId: fixturesA.SHOPIFY.connection.id }, include: { tokens: true } });
  const tokenOwnerCurrent = tokenOwner.tokens.find((token) => token.role === "CURRENT");
  assert.ok(tokenOwnerCurrent);
  const uniquenessConnectionA = await createBareConnection(merchantA.id);
  const uniquenessConnectionB = await createBareConnection(merchantA.id);
  const uniquenessEndpointA = await createH2BEndpoint(merchantA.id, uniquenessConnectionA.id);
  const uniquenessEndpointB = await createH2BEndpoint(merchantA.id, uniquenessConnectionB.id);
  const endpointA = await prisma.h2BConnectionEndpoint.findUnique({ where: { connectionId: uniquenessConnectionA.id }, include: { tokens: true } });
  const endpointB = await prisma.h2BConnectionEndpoint.findUnique({ where: { connectionId: uniquenessConnectionB.id }, include: { tokens: true } });
  assert.ok(endpointA && endpointB);
  await assert.rejects(() => prisma.h2BConnectionEndpointToken.update({ where: { id: endpointB.tokens.find((token) => token.role === "CURRENT").id }, data: { digest: tokenOwnerCurrent.digest } }));
  await assert.rejects(() => prisma.h2BConnectionEndpointToken.create({ data: { endpointId: endpointB.id, digest: tokenOwnerCurrent.digest, role: "PREVIOUS", platform: "SHOPIFY", generation: 1, activatedAt: new Date(), safeFingerprint: tokenOwnerCurrent.safeFingerprint } }));
  const concurrentDigest = createHash("sha256").update(`${fixtureMarker}-concurrent-digest`).digest("hex");
  const conflicting = await Promise.allSettled([endpointA, endpointB].map((endpoint) => prisma.h2BConnectionEndpointToken.create({ data: { endpointId: endpoint.id, digest: concurrentDigest, role: "PREVIOUS", platform: "SHOPIFY", generation: 1, activatedAt: new Date(), safeFingerprint: concurrentDigest.slice(0, 16) } })));
  assert.equal(conflicting.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(conflicting.filter((result) => result.status === "rejected").length, 1);

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
  assert.deepEqual(JSON.parse(unknown.body), JSON.parse(malformed.body));
  assert.deepEqual(await countFor(merchantA.id, shopifyId), beforeUnknown);

  const wrongTenant = fixture("SHOPIFY", "orders/create", "wrong-tenant", generatedSecrets.get(fixtureB.connection.id).current);
  assert.equal((await request(server, shopifyPath, wrongTenant.headers, wrongTenant.payload)).status, 401);
  assert.equal((await request(server, `/api/public/provider-webhooks/${fixtureB.endpoint}`, { ...wrongTenant.headers, "x-shopify-hmac-sha256": hmac(generatedSecrets.get(shopifyId).current, wrongTenant.payload) }, wrongTenant.payload)).status, 401);

  const oldEndpoint = fixturesA.SHOPIFY.endpoint;
  const rotatedEndpoint = await rotateH2BEndpoint(merchantA.id, shopifyId);
  fixturesA.SHOPIFY.endpoint = rotatedEndpoint.endpoint;
  const rotatedPayload = fixture("SHOPIFY", "orders/create", "rotated-endpoint", generatedSecrets.get(shopifyId).current);
  assert.equal((await request(server, `/api/public/provider-webhooks/${oldEndpoint}`, rotatedPayload.headers, rotatedPayload.payload)).status, 202);
  await prisma.h2BConnectionEndpointToken.updateMany({ where: { endpoint: { connectionId: shopifyId }, role: "PREVIOUS" }, data: { validUntil: new Date(0) } });
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

  const workerConnection = await createBareConnection(merchantA.id, "SHOPIFY");
  const staleAdmission = await createPendingEvent(merchantA.id, workerConnection.id, "SHOPIFY", "orders/create", "stale-worker", { totalMinor: "100" });
  const staleA = await claimOneH2BOutbox(prisma, new Date());
  assert.ok(staleA);
  await prisma.h2BWebhookOutbox.update({ where: { id: staleA.id }, data: { leaseUntil: new Date(0) } });
  const staleB = await claimOneH2BOutbox(prisma, new Date());
  assert.ok(staleB && staleB.claimVersion > staleA.claimVersion);
  assert.equal(await processClaimedH2BOutbox(staleB), "PROCESSED");
  const staleBefore = await countFor(merchantA.id, workerConnection.id);
  assert.equal(await processClaimedH2BOutbox(staleA), "FENCED");
  assert.equal(await failClaimedH2BOutbox(staleA, "STALE_FAILURE"), "FENCED");
  assert.deepEqual(await countFor(merchantA.id, workerConnection.id), staleBefore);
  assert.equal((await prisma.h2BWebhookAdmission.findUnique({ where: { id: staleAdmission.id }, select: { status: true } }))?.status, "PROCESSED");

  const ownerAdmission = await createPendingEvent(merchantA.id, workerConnection.id, "SHOPIFY", "orders/create", "single-owner", { totalMinor: "200" });
  const [ownerA, ownerB] = await Promise.all([claimOneH2BOutbox(prisma, new Date()), claimOneH2BOutbox(prisma, new Date())]);
  assert.equal([ownerA, ownerB].filter(Boolean).length, 1);
  const owner = ownerA ?? ownerB;
  assert.ok(owner);
  assert.equal(await processClaimedH2BOutbox(owner), "PROCESSED");
  assert.equal((await prisma.h2BExternalOrderAggregate.count({ where: { merchantId: merchantA.id, connectionId: workerConnection.id, externalOrderId: "single-owner" } })), 1);
  assert.equal((await prisma.h2BWebhookAdmission.findUnique({ where: { id: ownerAdmission.id }, select: { status: true } }))?.status, "PROCESSED");

  const retryAdmission = await createPendingEvent(merchantA.id, workerConnection.id, "SHOPIFY", "orders/create", "retryable", { totalMinor: "300" });
  const retryClaim = await claimOneH2BOutbox(prisma, new Date());
  assert.ok(retryClaim);
  assert.equal(await failClaimedH2BOutbox(retryClaim, "RETRYABLE_TEST"), "FAILED");
  assert.equal((await prisma.h2BWebhookAdmission.findUnique({ where: { id: retryAdmission.id }, select: { status: true } }))?.status, "ACCEPTED");
  await prisma.h2BWebhookOutbox.update({ where: { admissionId: retryAdmission.id }, data: { nextAttemptAt: new Date(0) } });
  const retryClaim2 = await claimOneH2BOutbox(prisma, new Date());
  assert.ok(retryClaim2);
  assert.equal(await processClaimedH2BOutbox(retryClaim2), "PROCESSED");
  assert.equal((await prisma.h2BWebhookAdmission.findUnique({ where: { id: retryAdmission.id }, select: { status: true } }))?.status, "PROCESSED");

  const terminalAdmission = await createPendingEvent(merchantA.id, workerConnection.id, "SHOPIFY", "orders/create", "terminal", { totalMinor: "400" });
  await prisma.h2BWebhookOutbox.update({ where: { admissionId: terminalAdmission.id }, data: { attemptCount: 4 } });
  const terminalClaim = await claimOneH2BOutbox(prisma, new Date());
  assert.ok(terminalClaim);
  assert.equal(await failClaimedH2BOutbox(terminalClaim, "TERMINAL_TEST"), "DEAD_LETTER");
  assert.equal((await prisma.h2BWebhookAdmission.findUnique({ where: { id: terminalAdmission.id }, select: { status: true } }))?.status, "FAILED");
  assert.equal((await prisma.h2BWebhookOutbox.findUnique({ where: { admissionId: terminalAdmission.id }, select: { status: true } }))?.status, "DEAD_LETTER");

  const convergenceConnection = await createBareConnection(merchantA.id, "WOOCOMMERCE");
  async function assertProcessed(admissionId) {
    assert.equal((await prisma.h2BWebhookAdmission.findUnique({ where: { id: admissionId }, select: { status: true } }))?.status, "PROCESSED");
    assert.equal((await prisma.h2BWebhookOutbox.findUnique({ where: { admissionId }, select: { status: true } }))?.status, "PROCESSED");
  }

  async function processPair(externalOrderId, first, second, processMode = "PARALLEL_CONCURRENT_RACE") {
    const receivedAt = new Date("2026-07-16T12:00:00.000Z");
    const firstAdmission = await createPendingEvent(merchantA.id, convergenceConnection.id, "WOOCOMMERCE", first.topic, externalOrderId, first.fields, receivedAt);
    const secondAdmission = await createPendingEvent(merchantA.id, convergenceConnection.id, "WOOCOMMERCE", second.topic, externalOrderId, second.fields, receivedAt);
    const claims = await claimPair(new Date());
    const firstClaim = claims.find((claim) => claim.admissionId === firstAdmission.id);
    const secondClaim = claims.find((claim) => claim.admissionId === secondAdmission.id);
    assert.ok(firstClaim && secondClaim);
    if (processMode === "FORCED_FORWARD_SEQUENTIAL") {
      assert.equal(await processClaimedH2BOutbox(firstClaim), "PROCESSED");
      await assertProcessed(firstAdmission.id);
      assert.equal(await processClaimedH2BOutbox(secondClaim), "PROCESSED");
      await assertProcessed(secondAdmission.id);
    } else if (processMode === "FORCED_REVERSE_SEQUENTIAL") {
      assert.equal(await processClaimedH2BOutbox(secondClaim), "PROCESSED");
      await assertProcessed(secondAdmission.id);
      assert.equal(await processClaimedH2BOutbox(firstClaim), "PROCESSED");
      await assertProcessed(firstAdmission.id);
    } else {
      assert.equal(processMode, "PARALLEL_CONCURRENT_RACE");
      const results = await Promise.all([processClaimedH2BOutbox(firstClaim), processClaimedH2BOutbox(secondClaim)]);
      assert.deepEqual(results.sort(), ["PROCESSED", "PROCESSED"]);
      await assertProcessed(firstAdmission.id);
      await assertProcessed(secondAdmission.id);
    }
    const aggregate = await prisma.h2BExternalOrderAggregate.findUnique({ where: { merchantId_connectionId_externalOrderId: { merchantId: merchantA.id, connectionId: convergenceConnection.id, externalOrderId } } });
    assert.ok(aggregate);
    assert.equal("admissionIds" in aggregate, false);
    assert.equal(JSON.stringify(aggregate.safeState).includes("admissionIds"), false);
    assert.equal(await prisma.h2BExternalOrderAdmissionReference.count({ where: { aggregateId: aggregate.id } }), 2);
    assert.equal(await prisma.h2BExternalOrderAdmissionReference.count({ where: { admissionId: { in: [firstAdmission.id, secondAdmission.id] } } }), 2);
    assert.equal(aggregate.latestSeenSequence, aggregate.latestUpdateSequence > aggregate.latestCreateSequence ? aggregate.latestUpdateSequence : aggregate.latestCreateSequence);
    assert.equal((await prisma.h2BWebhookAdmission.count({ where: { id: { in: [firstAdmission.id, secondAdmission.id] }, status: "PROCESSED" } })), 2);
    return { aggregate, firstAdmission, secondAdmission };
  }
  const forcedForward = await processPair("forced-forward-sequential", { topic: "order.created", fields: { externalOrderName: "#CREATE-NAME", totalMinor: "800", createOnly: "c", nested: { populated: "yes" } } }, { topic: "order.updated", fields: { externalOrderName: "#UPDATE-NAME", totalMinor: "900", updateOnly: "u", nested: { added: "yes" } } }, "FORCED_FORWARD_SEQUENTIAL");
  const forcedReverse = await processPair("forced-reverse-sequential", { topic: "order.created", fields: { externalOrderName: "#CREATE-NAME", totalMinor: "800", createOnly: "c", nested: { populated: "yes" } } }, { topic: "order.updated", fields: { externalOrderName: "#UPDATE-NAME", totalMinor: "900", updateOnly: "u", nested: { added: "yes" } } }, "FORCED_REVERSE_SEQUENTIAL");
  function normalizedProjection(result) {
    const scrub = (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const copy = { ...value };
      delete copy.externalOrderId;
      return Object.fromEntries(Object.entries(copy).map(([key, item]) => [key, scrub(item)]));
    };
    return { safeState: scrub(result.aggregate.safeState), createState: scrub(result.aggregate.createState), updateState: scrub(result.aggregate.updateState), externalOrderName: result.aggregate.externalOrderName };
  }
  assert.equal(forcedForward.aggregate.externalOrderName, "#UPDATE-NAME");
  assert.equal(forcedReverse.aggregate.externalOrderName, "#UPDATE-NAME");
  assert.deepEqual(normalizedProjection(forcedForward), normalizedProjection(forcedReverse));
  assert.equal(forcedForward.aggregate.safeState.nested.populated, "yes");
  assert.equal(forcedForward.aggregate.safeState.nested.added, "yes");

  const updateBeforeCreate = await processPair("woo-update-before-create", { topic: "order.updated", fields: { externalOrderName: "#UPDATE-NAME", totalMinor: "800", updateOnly: "u" } }, { topic: "order.created", fields: { externalOrderName: "#CREATE-NAME", totalMinor: "700", createOnly: "c" } }, "FORCED_REVERSE_SEQUENTIAL");
  assert.equal(updateBeforeCreate.aggregate.safeState.totalMinor, "800");
  assert.equal(updateBeforeCreate.aggregate.safeState.updateOnly, "u");
  assert.equal(updateBeforeCreate.aggregate.safeState.createOnly, "c");
  assert.equal(updateBeforeCreate.aggregate.externalOrderName, "#UPDATE-NAME");
  const createBeforeUpdate = await processPair("woo-create-before-update", { topic: "order.created", fields: { externalOrderName: "#CREATE-NAME", totalMinor: "900", createOnly: "c2" } }, { topic: "order.updated", fields: { externalOrderName: "#UPDATE-NAME", totalMinor: "950", updateOnly: "u2" } }, "FORCED_FORWARD_SEQUENTIAL");
  assert.equal(createBeforeUpdate.aggregate.safeState.totalMinor, "950");
  assert.equal(createBeforeUpdate.aggregate.safeState.updateOnly, "u2");
  assert.equal(createBeforeUpdate.aggregate.safeState.createOnly, "c2");
  assert.equal(createBeforeUpdate.aggregate.externalOrderName, "#UPDATE-NAME");
  const orderIndependentForward = await processPair("woo-order-independent-forward", { topic: "order.created", fields: { externalOrderName: "#CREATE-NAME", totalMinor: "990", stableCreate: "yes" } }, { topic: "order.updated", fields: { externalOrderName: "#UPDATE-NAME", totalMinor: "995", stableUpdate: "yes" } }, "FORCED_FORWARD_SEQUENTIAL");
  const orderIndependentReverse = await processPair("woo-order-independent-reverse", { topic: "order.created", fields: { externalOrderName: "#CREATE-NAME", totalMinor: "990", stableCreate: "yes" } }, { topic: "order.updated", fields: { externalOrderName: "#UPDATE-NAME", totalMinor: "995", stableUpdate: "yes" } }, "FORCED_REVERSE_SEQUENTIAL");
  assert.deepEqual(normalizedProjection(orderIndependentForward), normalizedProjection(orderIndependentReverse));
  const nullSafe = await processPair("woo-null-safe", { topic: "order.created", fields: { externalOrderName: "#CREATE-NAME", totalMinor: "1000", nested: { populated: "yes" } } }, { topic: "order.updated", fields: { externalOrderName: null, totalMinor: null, nested: { populated: null, added: "yes" } } }, "PARALLEL_CONCURRENT_RACE");
  assert.equal(nullSafe.aggregate.safeState.totalMinor, "1000");
  assert.equal(nullSafe.aggregate.safeState.nested.populated, "yes");
  assert.equal(nullSafe.aggregate.safeState.nested.added, "yes");
  assert.equal(nullSafe.aggregate.externalOrderName, "#CREATE-NAME");

  const olderUpdateAdmission = await createPendingEvent(merchantA.id, convergenceConnection.id, "WOOCOMMERCE", "order.updated", "woo-older-update", { totalMinor: "1100" });
  const newerUpdateAdmission = await createPendingEvent(merchantA.id, convergenceConnection.id, "WOOCOMMERCE", "order.updated", "woo-older-update", { totalMinor: "1200" });
  const olderNewerClaims = await claimPair(new Date());
  const olderClaim = olderNewerClaims.find((claim) => claim.admissionId === olderUpdateAdmission.id);
  const newerClaim = olderNewerClaims.find((claim) => claim.admissionId === newerUpdateAdmission.id);
  assert.ok(olderClaim && newerClaim);
  await processClaimedH2BOutbox(newerClaim);
  await processClaimedH2BOutbox(olderClaim);
  const updateAggregate = await prisma.h2BExternalOrderAggregate.findUnique({ where: { merchantId_connectionId_externalOrderId: { merchantId: merchantA.id, connectionId: convergenceConnection.id, externalOrderId: "woo-older-update" } } });
  assert.equal(updateAggregate?.safeState.totalMinor, "1200");
  assert.equal(await prisma.h2BExternalOrderAdmissionReference.count({ where: { aggregateId: updateAggregate.id } }), 2);
  assert.equal((await prisma.h2BWebhookAdmission.count({ where: { id: { in: [olderUpdateAdmission.id, newerUpdateAdmission.id] }, status: "PROCESSED" } })), 2);

  let concurrentInitialAggregatePasses = 0;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const aggregate = await processPair(`woo-concurrent-${iteration}`, { topic: "order.created", fields: { totalMinor: "1300" } }, { topic: "order.updated", fields: { totalMinor: "1350" } }, "PARALLEL_CONCURRENT_RACE");
    assert.equal(aggregate.aggregate.safeState.totalMinor, "1350");
    concurrentInitialAggregatePasses += 1;
  }

  const referenceGrowthId = "woo-reference-growth";
  let referenceGrowthAggregate;
  for (let iteration = 0; iteration < 101; iteration += 1) {
    const admission = await createPendingEvent(merchantA.id, convergenceConnection.id, "WOOCOMMERCE", "order.updated", referenceGrowthId, { externalOrderName: "#UPDATE-NAME", totalMinor: "1400" }, new Date("2026-07-16T12:01:00.000Z"));
    const claim = await claimOneH2BOutbox(prisma, new Date());
    assert.ok(claim);
    assert.equal(await processClaimedH2BOutbox(claim), "PROCESSED");
    await assertProcessed(admission.id);
    referenceGrowthAggregate = await prisma.h2BExternalOrderAggregate.findUnique({ where: { merchantId_connectionId_externalOrderId: { merchantId: merchantA.id, connectionId: convergenceConnection.id, externalOrderId: referenceGrowthId } } });
    assert.ok(referenceGrowthAggregate);
  }
  assert.equal("admissionIds" in referenceGrowthAggregate, false);
  assert.equal(JSON.stringify(referenceGrowthAggregate.safeState).includes("admissionIds"), false);
  assert.equal(await prisma.h2BExternalOrderAdmissionReference.count({ where: { aggregateId: referenceGrowthAggregate.id } }), 101);
  const replayClaim = await prisma.h2BWebhookOutbox.findFirst({ where: { admission: { merchantId: merchantA.id, connectionId: convergenceConnection.id, deliveryId: { startsWith: `${fixtureMarker}-${referenceGrowthId}` } } }, include: { admission: true } });
  assert.ok(replayClaim);
  assert.equal(await processClaimedH2BOutbox({ ...replayClaim, claimVersion: replayClaim.claimVersion }), "FENCED");
  assert.equal(await prisma.h2BExternalOrderAdmissionReference.count({ where: { aggregateId: referenceGrowthAggregate.id } }), 101);

  const aggregateCascade = await processPair("reference-cascade", { topic: "order.created", fields: { externalOrderName: "#CREATE-NAME", totalMinor: "1500" } }, { topic: "order.updated", fields: { externalOrderName: "#UPDATE-NAME", totalMinor: "1550" } }, "FORCED_FORWARD_SEQUENTIAL");
  assert.equal(await prisma.h2BExternalOrderAdmissionReference.count({ where: { aggregateId: aggregateCascade.aggregate.id } }), 2);
  await prisma.h2BExternalOrderAggregate.delete({ where: { id: aggregateCascade.aggregate.id } });
  assert.equal(await prisma.h2BExternalOrderAdmissionReference.count({ where: { aggregateId: aggregateCascade.aggregate.id } }), 0);
  const admissionCascade = await createPendingEvent(merchantA.id, convergenceConnection.id, "WOOCOMMERCE", "order.created", "admission-cascade", { externalOrderName: "#CREATE-NAME", totalMinor: "1600" });
  const admissionCascadeClaim = await claimOneH2BOutbox(prisma, new Date());
  assert.ok(admissionCascadeClaim);
  assert.equal(await processClaimedH2BOutbox(admissionCascadeClaim), "PROCESSED");
  const admissionCascadeAggregate = await prisma.h2BExternalOrderAggregate.findUnique({ where: { merchantId_connectionId_externalOrderId: { merchantId: merchantA.id, connectionId: convergenceConnection.id, externalOrderId: "admission-cascade" } } });
  assert.ok(admissionCascadeAggregate);
  assert.equal(await prisma.h2BExternalOrderAdmissionReference.count({ where: { admissionId: admissionCascade.id } }), 1);
  await prisma.h2BWebhookAdmission.delete({ where: { id: admissionCascade.id } });
  assert.equal(await prisma.h2BExternalOrderAdmissionReference.count({ where: { admissionId: admissionCascade.id } }), 0);

  const secondConnection = await createBareConnection(merchantA.id, "WOOCOMMERCE");
  const merchantBConnection = await createBareConnection(merchantB.id, "WOOCOMMERCE");
  const isolatedA = await createPendingEvent(merchantA.id, secondConnection.id, "WOOCOMMERCE", "order.created", "same-external", { totalMinor: "1400" });
  const isolatedB = await createPendingEvent(merchantB.id, merchantBConnection.id, "WOOCOMMERCE", "order.created", "same-external", { totalMinor: "1500" });
  const [isolatedClaimA, isolatedClaimB] = await claimPair(new Date());
  await Promise.all([processClaimedH2BOutbox(isolatedClaimA), processClaimedH2BOutbox(isolatedClaimB)]);
  assert.equal(await prisma.h2BExternalOrderAggregate.count({ where: { externalOrderId: "same-external" } }), 2);
  assert.equal((await prisma.h2BWebhookAdmission.count({ where: { id: { in: [isolatedA.id, isolatedB.id] }, status: "PROCESSED" } })), 2);

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
  console.log(JSON.stringify({ scratch: "PASS", merchants: 2, providers: 3, duplicateRace: "PASS", endpointConcurrency: "PASS", rotateRevokeRaceIterations: rotateRevokePasses, concurrentInitialAggregateIterations: concurrentInitialAggregatePasses, forcedForwardSequential: "PASS", forcedReverseSequential: "PASS", parallelConcurrentRace: "PASS", normalizedOrderIndependent: "PASS", externalOrderName: "PASS", admissionReferences: "PASS", referenceRows: 101, referenceIdempotency: "PASS", referenceForeignKeys: "PASS", tokenUniqueness: "PASS", rollback: "PASS", leakage: "PASS", worker: "PASS", staleWorker: "FENCED", retryableFailure: "ACCEPTED", retrySuccess: "PROCESSED", terminalFailure: "FAILED" }));
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
