import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import { describe, it } from "node:test";

import { errorHandler } from "../../middleware/error.js";
import { HttpError } from "../../lib/httpError.js";
import { CheckoutAddressPrefillService } from "./checkout-address-prefill.service.js";
import { createCheckoutAddressPrefillRouter } from "./checkout-address-prefill.routes.js";
import type { AddressEventInput } from "./checkout-address-telemetry.service.js";
import type { VerifiedCheckoutSessionContext } from "./checkout-address-session.service.js";

const baseTime = new Date("2026-07-07T15:00:00.000Z");

function clone<T>(value: T): T {
  return structuredClone(value as never) as T;
}

async function assertHttpError(promise: Promise<unknown>, status: number, message: string) {
  await assert.rejects(
    promise,
    (error) => error instanceof HttpError && error.status === status && error.message === message
  );
}

function makeAddress(input: Record<string, unknown>) {
  return {
    id: "address_1",
    shopperId: "shopper_a",
    firstMerchantId: "merchant_a",
    fullName: "Riya Sharma",
    line1: "Flat 4B, Connaught Place",
    line2: "Tower A",
    landmark: "Gate 2",
    pincode: "110001",
    city: "New Delhi",
    state: "Delhi",
    source: "manual",
    quality: 2,
    useCount: 1,
    lastUsedAt: new Date(baseTime.getTime() - 60_000),
    placeId: "place_private",
    lat: "28.6139000",
    lng: "77.2090000",
    ...input
  };
}

function makeHarness(input: { telemetryThrows?: boolean } = {}) {
  const contexts: Record<string, VerifiedCheckoutSessionContext> = {
    verified_a: {
      sessionId: "session_a",
      merchantId: "merchant_a",
      cartId: "cart_a",
      phoneHash: "phone_hash_a",
      phoneLast2: "43",
      profileName: null
    },
    verified_b: {
      sessionId: "session_b",
      merchantId: "merchant_a",
      cartId: "cart_b",
      phoneHash: "phone_hash_b",
      phoneLast2: "77",
      profileName: null
    },
    merchant_b: {
      sessionId: "session_c",
      merchantId: "merchant_b",
      cartId: "cart_c",
      phoneHash: "phone_hash_a",
      phoneLast2: "43",
      profileName: null
    },
    new_shopper: {
      sessionId: "session_new",
      merchantId: "merchant_a",
      cartId: "cart_new",
      phoneHash: "phone_hash_new",
      phoneLast2: "11",
      profileName: null
    }
  };
  const state = {
    now: new Date(baseTime),
    identitySeq: 2,
    identities: [
      { id: "shopper_a", phoneHash: "phone_hash_a", phoneLast2: "43" },
      { id: "shopper_b", phoneHash: "phone_hash_b", phoneLast2: "77" }
    ] as any[],
    addresses: [
      makeAddress({ id: "address_recent", lastUsedAt: new Date(baseTime.getTime() - 1_000), useCount: 3 }),
      makeAddress({ id: "address_old", line1: "House 9 Market Road", pincode: "560001", city: "Bengaluru", state: "Karnataka", lastUsedAt: new Date(baseTime.getTime() - 120_000), quality: 1 }),
      makeAddress({ id: "address_other_shopper", shopperId: "shopper_b", line1: "Other Shopper Road" }),
      makeAddress({ id: "address_cross_merchant", firstMerchantId: "merchant_x", source: "network_prefill", line1: "Network Shared Lane" })
    ] as any[],
    telemetry: [] as AddressEventInput[]
  };
  const client: any = {
    shopperAddress: {
      findMany: async ({ where, orderBy }: any) => {
        let rows = state.addresses.filter((row) => row.shopperId === where.shopperId);
        if (where.firstMerchantId) rows = rows.filter((row) => row.firstMerchantId === where.firstMerchantId);
        if (orderBy?.lastUsedAt === "desc") {
          rows = rows.sort((left, right) => right.lastUsedAt.getTime() - left.lastUsedAt.getTime());
        }
        return clone(rows);
      },
      findUnique: async ({ where }: any) => clone(state.addresses.find((row) => row.id === where.id) ?? null),
      update: async ({ where, data }: any) => {
        const row = state.addresses.find((item) => item.id === where.id);
        if (!row) throw new Error("ADDRESS_NOT_FOUND");
        const next = { ...data };
        if (data.useCount?.increment) next.useCount = row.useCount + data.useCount.increment;
        Object.assign(row, next);
        return clone(row);
      }
    }
  };
  const verifiedSessionResolver = async (token: string) => {
    const context = contexts[token];
    if (context) return clone(context);
    if (token === "unverified") throw new HttpError(401, "CHECKOUT_SESSION_NOT_VERIFIED");
    if (token === "expired") throw new HttpError(401, "CHECKOUT_SESSION_EXPIRED");
    throw new HttpError(401, "CHECKOUT_SESSION_TOKEN_INVALID");
  };
  const shopperIdentityResolver = async (ctx: VerifiedCheckoutSessionContext) => {
    const existing = state.identities.find((identity) => identity.phoneHash === ctx.phoneHash);
    if (existing) return clone(existing);
    const identity = {
      id: `shopper_${++state.identitySeq}`,
      phoneHash: ctx.phoneHash,
      phoneLast2: ctx.phoneLast2
    };
    state.identities.push(identity);
    return clone(identity);
  };
  const telemetryRecorder = async (event: AddressEventInput) => {
    if (input.telemetryThrows) throw new Error("TELEMETRY_DOWN");
    state.telemetry.push(clone(event));
  };
  const service = new CheckoutAddressPrefillService(
    client,
    verifiedSessionResolver,
    shopperIdentityResolver,
    telemetryRecorder,
    () => state.now
  );
  return { state, service };
}

async function createApp(service: CheckoutAddressPrefillService) {
  const app = express();
  app.use(express.json());
  app.use("/checkout", createCheckoutAddressPrefillRouter({ service }));
  app.use(errorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_BIND_FAILED");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

describe("Checkout Address A5 same-merchant address book", () => {
  it("returns same-merchant masked summaries for a returning shopper", async () => {
    const { service } = makeHarness();
    const result = await service.getSameMerchantAddressBook("verified_a");

    assert.equal(result.addresses.length, 2);
    assert.equal(result.addresses[0].id, "address_recent");
    assert.equal(result.addresses[0].maskedLine1, "Flat 4B, C...");
    assert.equal("line1" in result.addresses[0], false);
    assert.equal("line2" in result.addresses[0], false);
    assert.equal("landmark" in result.addresses[0], false);
    assert.equal("placeId" in result.addresses[0], false);
    assert.equal("lat" in result.addresses[0], false);
    assert.equal("lng" in result.addresses[0], false);
    assert.equal("shopperId" in result.addresses[0], false);
    assert.equal("phoneHash" in result.addresses[0], false);
    assert.equal(JSON.stringify(result).includes("9876543243"), false);
    assert.equal(JSON.stringify(result).includes("Connaught Place"), false);
  });

  it("emits graph_hit_merchant and prefill_offered when addresses are found", async () => {
    const { state, service } = makeHarness();
    await service.getSameMerchantAddressBook("verified_a");

    assert.deepEqual(state.telemetry.map((event) => event.event), ["graph_hit_merchant", "prefill_offered"]);
    assert.deepEqual(state.telemetry.map((event) => event.meta), [
      { count: 2, status: "hit" },
      { count: 2, status: "offered" }
    ]);
    assert.equal(/address_|line1|line2|landmark|fullName|phone|phoneHash|email|token|proof/i.test(JSON.stringify(state.telemetry)), false);
  });

  it("returns empty list for a new shopper and emits graph_miss", async () => {
    const { state, service } = makeHarness();
    const result = await service.getSameMerchantAddressBook("new_shopper");

    assert.deepEqual(result, { addresses: [] });
    assert.equal(state.telemetry.length, 1);
    assert.equal(state.telemetry[0]?.event, "graph_miss");
    assert.deepEqual(state.telemetry[0]?.meta, {
      count: 0,
      status: "miss",
      reason: "same_merchant_address_not_found"
    });
  });

  it("does not show different merchant, different shopper, or network/cross-merchant addresses", async () => {
    const { service } = makeHarness();
    const merchantB = await service.getSameMerchantAddressBook("merchant_b");
    const shopperB = await service.getSameMerchantAddressBook("verified_b");

    assert.deepEqual(merchantB, { addresses: [] });
    assert.equal(shopperB.addresses.length, 1);
    assert.equal(shopperB.addresses[0].id, "address_other_shopper");

    const source = readFileSync("src/modules/checkout/checkout-address-prefill.service.ts", "utf8");
    assert.equal(/findNetworkEligibleAddressesForShopper|isNetworkEligible/i.test(source), false);
    assert.match(source, /shopperId: shopper\.id/);
    assert.match(source, /firstMerchantId: ctx\.merchantId/);
  });

  it("rejects unverified, invalid, and expired sessions", async () => {
    const { service } = makeHarness();
    await assertHttpError(service.getSameMerchantAddressBook("unverified"), 401, "CHECKOUT_SESSION_NOT_VERIFIED");
    await assertHttpError(service.getSameMerchantAddressBook("expired"), 401, "CHECKOUT_SESSION_EXPIRED");
    await assertHttpError(service.getSameMerchantAddressBook("invalid"), 401, "CHECKOUT_SESSION_TOKEN_INVALID");
  });
});

describe("Checkout Address A5 select same-merchant address", () => {
  it("returns full address only after verified owner selects own same-merchant address", async () => {
    const { state, service } = makeHarness();
    const selected = await service.selectSameMerchantAddress("verified_a", "address_recent");

    assert.deepEqual(selected.address, {
      id: "address_recent",
      fullName: "Riya Sharma",
      line1: "Flat 4B, Connaught Place",
      line2: "Tower A",
      landmark: "Gate 2",
      pincode: "110001",
      city: "New Delhi",
      state: "Delhi",
      source: "manual",
      quality: 2
    });
    assert.equal("phoneHash" in selected.address, false);
    assert.equal("shopperId" in selected.address, false);
    assert.equal("placeId" in selected.address, false);
    assert.equal("lat" in selected.address, false);
    assert.equal("lng" in selected.address, false);
    assert.equal(JSON.stringify(selected).includes("9876543243"), false);

    const address = state.addresses.find((row) => row.id === "address_recent");
    assert.equal(address?.useCount, 4);
    assert.equal(address?.lastUsedAt.getTime(), baseTime.getTime());
    assert.equal(state.telemetry[0]?.event, "prefill_accepted");
    assert.deepEqual(state.telemetry[0]?.meta, { status: "accepted" });
  });

  it("rejects different shopper, different merchant, cross-merchant/network, and missing address selection", async () => {
    const { service } = makeHarness();

    await assertHttpError(service.selectSameMerchantAddress("verified_b", "address_recent"), 404, "CHECKOUT_ADDRESS_PREFILL_NOT_FOUND");
    await assertHttpError(service.selectSameMerchantAddress("merchant_b", "address_recent"), 404, "CHECKOUT_ADDRESS_PREFILL_NOT_FOUND");
    await assertHttpError(service.selectSameMerchantAddress("verified_a", "address_cross_merchant"), 404, "CHECKOUT_ADDRESS_PREFILL_NOT_FOUND");
    await assertHttpError(service.selectSameMerchantAddress("verified_a", "missing"), 404, "CHECKOUT_ADDRESS_PREFILL_NOT_FOUND");
  });

  it("rejects unverified sessions on select", async () => {
    const { service } = makeHarness();
    await assertHttpError(service.selectSameMerchantAddress("unverified", "address_recent"), 401, "CHECKOUT_SESSION_NOT_VERIFIED");
    await assertHttpError(service.selectSameMerchantAddress("expired", "address_recent"), 401, "CHECKOUT_SESSION_EXPIRED");
  });

  it("telemetry failure does not fail address-book or select endpoints", async () => {
    const { service } = makeHarness({ telemetryThrows: true });
    const list = await service.getSameMerchantAddressBook("verified_a");
    const selected = await service.selectSameMerchantAddress("verified_a", "address_recent");

    assert.equal(list.addresses.length, 2);
    assert.equal(selected.address.id, "address_recent");
  });
});

describe("Checkout Address A5 routes", () => {
  it("mounts address-book routes through the existing public checkout router", () => {
    const checkoutRoutes = readFileSync("src/modules/checkout/checkout.routes.ts", "utf8");
    assert.match(checkoutRoutes, /checkoutRouter\.use\("\/", checkoutAddressPrefillRouter\);/);
  });

  it("serves GET /checkout/address-book and POST /checkout/address-book/:addressId/select", async () => {
    const { service } = makeHarness();
    const app = await createApp(service);
    try {
      const list = await request(app.baseUrl, "/checkout/address-book", {
        method: "GET",
        headers: { "x-checkout-session-token": "verified_a" }
      });
      const selected = await request(app.baseUrl, "/checkout/address-book/address_recent/select", {
        method: "POST",
        headers: { "x-checkout-session-token": "verified_a" }
      });

      assert.equal(list.status, 200);
      assert.equal(list.body.addresses.length, 2);
      assert.equal(list.body.addresses[0].maskedLine1, "Flat 4B, C...");
      assert.equal("line1" in list.body.addresses[0], false);

      assert.equal(selected.status, 200);
      assert.equal(selected.body.address.id, "address_recent");
      assert.equal(selected.body.address.line1, "Flat 4B, Connaught Place");
      assert.equal("phoneHash" in selected.body.address, false);
    } finally {
      await closeServer(app.server);
    }
  });

  it("returns 401 for invalid session and 404 for foreign address", async () => {
    const { service } = makeHarness();
    const app = await createApp(service);
    try {
      const invalid = await request(app.baseUrl, "/checkout/address-book", {
        method: "GET",
        headers: { "x-checkout-session-token": "invalid" }
      });
      const foreign = await request(app.baseUrl, "/checkout/address-book/address_recent/select", {
        method: "POST",
        headers: { "x-checkout-session-token": "merchant_b" }
      });

      assert.equal(invalid.status, 401);
      assert.equal(invalid.body.error, "CHECKOUT_SESSION_TOKEN_INVALID");
      assert.equal(foreign.status, 404);
      assert.equal(foreign.body.error, "CHECKOUT_ADDRESS_PREFILL_NOT_FOUND");
    } finally {
      await closeServer(app.server);
    }
  });
});

describe("Checkout Address A5 safety boundaries", () => {
  it("adds no external API calls in same-merchant prefill code", () => {
    const sources = [
      "src/modules/checkout/checkout-address-prefill.service.ts",
      "src/modules/checkout/checkout-address-prefill.routes.ts"
    ].map((file) => readFileSync(file, "utf8")).join("\n");

    assert.equal(/twilio|msg91|gupshup|interakt|wati|aisensy|truecaller\.com|places\.googleapis|addressvalidation|fetch\s*\(|axios|https?:\/\//i.test(sources), false);
  });

  it("does not touch payment, wallet, settlement, payout, Razorpay, Cashfree, or COD ledger source paths", () => {
    const changedSurface = [
      "src/modules/checkout/checkout-address-prefill.service.ts",
      "src/modules/checkout/checkout-address-prefill.routes.ts",
      "src/modules/checkout/checkout-address-prefill.service.test.ts",
      "src/modules/checkout/checkout.routes.ts"
    ].join("\n");

    assert.equal(/payment|wallet|settlement|payout|razorpay|cashfree|cod.?ledger/i.test(changedSurface), false);
  });
});
