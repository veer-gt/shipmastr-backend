import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import express from "express";

import { errorHandler } from "../../../middleware/error.js";
import { createGrowthNetworkRouter } from "../growth-network.routes.js";
import type { GrowthNetworkRuntimeConfig } from "../growth-network-runtime.js";

type TestAuth = NonNullable<Express.Request["auth"]>;

const baseRuntime: GrowthNetworkRuntimeConfig = {
  enabled: false,
  audience: "MERCHANT_SELLER_ONLY",
  externalAdsEnabled: false,
  billingEnabled: false,
  partnerRoutingEnabled: false,
  messagingEnabled: false,
  paymentEnabled: false,
  buyerExportEnabled: false,
  publicTrackingEnabled: false
};

const merchantAuth: TestAuth = {
  userId: "merchant_user_1",
  merchantId: "merchant_1",
  role: "MERCHANT_OWNER"
};

const sellerAuth: TestAuth = {
  userId: "seller_user_1",
  merchantId: "merchant_1",
  role: "SELLER"
};

async function makeApp(input: {
  runtime?: GrowthNetworkRuntimeConfig;
  auth?: TestAuth | null;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (input.auth) req.auth = input.auth;
    next();
  });
  app.use("/growth-network", createGrowthNetworkRouter({
    enforceRuntimeGuard: true,
    runtime: input.runtime ?? baseRuntime
  }));
  app.use(errorHandler);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

async function request(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

describe("growth network runtime guard routes", () => {
  const servers: Array<() => Promise<void>> = [];

  after(async () => {
    await Promise.all(servers.map((close) => close()));
  });

  it("blocks capabilities safely when the growth network is disabled", async () => {
    const app = await makeApp({ auth: merchantAuth });
    servers.push(app.close);

    const result = await request(app.baseUrl, "/growth-network/offers");

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.message, "This Growth Network capability is currently disabled.");
    assert.equal(result.body.data.enabled, false);
  });

  it("allows authenticated merchant status when enabled", async () => {
    const app = await makeApp({ auth: merchantAuth, runtime: { ...baseRuntime, enabled: true } });
    servers.push(app.close);

    const result = await request(app.baseUrl, "/growth-network/status");

    assert.equal(result.status, 200);
    assert.equal(result.body.data.enabled, true);
    assert.equal(result.body.data.audience, "MERCHANT_SELLER_ONLY");
    assert.equal(
      result.body.data.message,
      "Growth Network is available for authenticated Shipmastr merchants and sellers."
    );
  });

  it("allows authenticated seller status when enabled", async () => {
    const app = await makeApp({ auth: sellerAuth, runtime: { ...baseRuntime, enabled: true } });
    servers.push(app.close);

    const result = await request(app.baseUrl, "/growth-network/status");

    assert.equal(result.status, 200);
    assert.equal(result.body.data.enabled, true);
  });

  it("blocks buyer, anonymous, courier, and external contexts", async () => {
    const runtime = { ...baseRuntime, enabled: true };
    const blockedAuths: Array<TestAuth | null> = [
      null,
      { userId: "buyer_1", merchantId: "merchant_1", role: "BUYER" },
      { userId: "courier_1", merchantId: "merchant_1", courierId: "courier_1", role: "COURIER" },
      { userId: "external_1", merchantId: "", role: "EXTERNAL_PARTNER" }
    ];

    for (const auth of blockedAuths) {
      const app = await makeApp({ auth, runtime });
      servers.push(app.close);

      const result = await request(app.baseUrl, "/growth-network/status");
      assert.equal(result.status, 403);
      assert.equal(result.body.error, "GROWTH_NETWORK_MERCHANT_SELLER_ONLY");
    }
  });

  it("keeps safety-disabled modules false when enabled", async () => {
    const app = await makeApp({ auth: merchantAuth, runtime: { ...baseRuntime, enabled: true } });
    servers.push(app.close);

    const result = await request(app.baseUrl, "/growth-network/status");

    assert.deepEqual(result.body.data.modules, {
      billing: false,
      externalAds: false,
      partnerRouting: false,
      messaging: false,
      payments: false,
      buyerExport: false,
      publicTracking: false
    });
  });

  it("does not leak provider, payment, secret, or credential details", async () => {
    const app = await makeApp({ auth: merchantAuth, runtime: { ...baseRuntime, enabled: true } });
    servers.push(app.close);

    const result = await request(app.baseUrl, "/growth-network/status");
    const payload = JSON.stringify(result.body).toLowerCase();

    for (const forbidden of [
      "shiprocket",
      "shipmozo",
      "bigship",
      "provider",
      "payment gateway",
      "secret",
      "credential",
      "database_url",
      "token"
    ]) {
      assert.equal(payload.includes(forbidden), false, forbidden);
    }
  });
});
