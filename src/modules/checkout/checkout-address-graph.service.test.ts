import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import { describe, it } from "node:test";

import { errorHandler } from "../../middleware/error.js";
import { HttpError } from "../../lib/httpError.js";
import {
  CheckoutAddressGraphService,
  normalizeCheckoutAddressLine1
} from "./checkout-address-graph.service.js";
import { createCheckoutAddressGraphRouter } from "./checkout-address-graph.routes.js";
import type { VerifiedCheckoutSessionContext } from "./checkout-address-session.service.js";

const baseTime = new Date("2026-07-07T10:00:00.000Z");

function clone<T>(value: T): T {
  return structuredClone(value as never) as T;
}

async function assertHttpError(promise: Promise<unknown>, status: number, message: string) {
  await assert.rejects(
    promise,
    (error) => error instanceof HttpError && error.status === status && error.message === message
  );
}

function basePayload(input: Record<string, unknown> = {}) {
  return {
    fullName: "Riya Sharma",
    line1: "Flat 4B, Connaught Place",
    pincode: "110001",
    source: "manual",
    quality: 1,
    consentScope: "merchant",
    consentTextVersion: "address-save-v1",
    ...input
  };
}

function makeHarness() {
  const verifiedA: VerifiedCheckoutSessionContext = {
    sessionId: "session_a",
    merchantId: "merchant_a",
    cartId: "cart_a",
    phoneHash: "phone_hash_a",
    phoneLast2: "43",
    profileName: null
  };
  const verifiedB: VerifiedCheckoutSessionContext = {
    sessionId: "session_b",
    merchantId: "merchant_a",
    cartId: "cart_b",
    phoneHash: "phone_hash_b",
    phoneLast2: "77",
    profileName: null
  };
  const state = {
    now: new Date(baseTime),
    identitySeq: 0,
    addressSeq: 0,
    consentSeq: 0,
    identities: [] as any[],
    addresses: [] as any[],
    consents: [] as any[],
    pincodes: new Map<string, any>([
      ["110001", { city: "New Delhi", district: "Central Delhi", state: "Delhi", localities: [] }],
      ["560001", { city: "Bengaluru", district: "Bengaluru Urban", state: "Karnataka", localities: [] }]
    ])
  };

  const client: any = {
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(client),
    shopperIdentity: {
      upsert: async ({ where, create, update }: any) => {
        const existing = state.identities.find((row) => row.phoneHash === where.phoneHash);
        if (existing) {
          Object.assign(existing, update);
          return clone(existing);
        }
        const row = {
          id: `shopper_${++state.identitySeq}`,
          createdAt: state.now,
          lastSeenAt: state.now,
          ...create
        };
        state.identities.push(row);
        return clone(row);
      }
    },
    shopperAddress: {
      findMany: async ({ where }: any) => {
        let rows = state.addresses.filter((row) => row.shopperId === where.shopperId);
        if (where.pincode) rows = rows.filter((row) => row.pincode === where.pincode);
        if (where.firstMerchantId?.not) rows = rows.filter((row) => row.firstMerchantId !== where.firstMerchantId.not);
        return clone(rows.sort((left, right) => right.lastUsedAt.getTime() - left.lastUsedAt.getTime()));
      },
      create: async ({ data }: any) => {
        const row = {
          id: `address_${++state.addressSeq}`,
          createdAt: state.now,
          updatedAt: state.now,
          ...data
        };
        state.addresses.push(row);
        return clone(row);
      },
      update: async ({ where, data }: any) => {
        const row = state.addresses.find((item) => item.id === where.id);
        if (!row) throw new Error("ADDRESS_NOT_FOUND");
        const next = { ...data };
        if (data.useCount?.increment) next.useCount = row.useCount + data.useCount.increment;
        Object.assign(row, next, { updatedAt: state.now });
        return clone(row);
      }
    },
    addressConsent: {
      create: async ({ data }: any) => {
        const row = {
          id: `consent_${++state.consentSeq}`,
          grantedAt: state.now,
          expiresAt: null,
          revokedAt: null,
          ...data
        };
        state.consents.push(row);
        return clone(row);
      },
      findFirst: async ({ where }: any) => {
        const rows = state.consents
          .filter((row) => row.shopperId === where.shopperId)
          .filter((row) => row.scope === where.scope)
          .filter((row) => row.revokedAt === where.revokedAt)
          .filter((row) => !row.expiresAt || row.expiresAt.getTime() > state.now.getTime())
          .sort((left, right) => right.grantedAt.getTime() - left.grantedAt.getTime());
        return clone(rows[0] ?? null);
      }
    }
  };

  const pincodeLookup = {
    lookup: async (pin: unknown) => {
      const record = state.pincodes.get(String(pin));
      if (!record) throw new HttpError(404, "PINCODE_NOT_FOUND");
      return clone(record);
    }
  };

  const verifiedSessionResolver = async (token: string) => {
    if (token === "verified_a") return clone(verifiedA);
    if (token === "verified_b") return clone(verifiedB);
    if (token === "unverified") throw new HttpError(401, "CHECKOUT_SESSION_NOT_VERIFIED");
    if (token === "expired") throw new HttpError(401, "CHECKOUT_SESSION_EXPIRED");
    throw new HttpError(401, "CHECKOUT_SESSION_TOKEN_INVALID");
  };

  const service = new CheckoutAddressGraphService(client, verifiedSessionResolver, pincodeLookup, () => state.now);
  return { state, client, service };
}

async function createApp(service: CheckoutAddressGraphService) {
  const app = express();
  app.use(express.json());
  app.use("/checkout", createCheckoutAddressGraphRouter({ service }));
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

describe("Checkout Address A3 verified-session integration", () => {
  it("uses the A2 verified checkout session helper as the default trust boundary", () => {
    const source = readFileSync("src/modules/checkout/checkout-address-graph.service.ts", "utf8");
    assert.match(source, /import \{ requireVerifiedCheckoutSession, type VerifiedCheckoutSessionContext \}/);
    assert.match(source, /verifiedSessionResolver: VerifiedSessionResolver = requireVerifiedCheckoutSession/);
  });

  it("rejects unverified, expired, invalid, and missing sessions", async () => {
    const { service } = makeHarness();
    await assertHttpError(service.persistCheckoutAddress("unverified", basePayload()), 401, "CHECKOUT_SESSION_NOT_VERIFIED");
    await assertHttpError(service.persistCheckoutAddress("expired", basePayload()), 401, "CHECKOUT_SESSION_EXPIRED");
    await assertHttpError(service.persistCheckoutAddress("invalid", basePayload()), 401, "CHECKOUT_SESSION_TOKEN_INVALID");
    await assertHttpError(service.persistCheckoutAddress("", basePayload()), 401, "CHECKOUT_SESSION_TOKEN_INVALID");
  });

  it("accepts a verified session and persists a manual address", async () => {
    const { state, service } = makeHarness();
    const result = await service.persistCheckoutAddress("verified_a", basePayload());

    assert.deepEqual(result, { addressId: "address_1", deduped: false });
    assert.equal(state.identities.length, 1);
    assert.equal(state.identities[0].phoneHash, "phone_hash_a");
    assert.equal(state.identities[0].phoneLast2, "43");
    assert.equal(state.addresses[0].city, "New Delhi");
    assert.equal(state.addresses[0].state, "Delhi");
    assert.equal(state.addresses[0].firstMerchantId, "merchant_a");
  });
});

describe("Checkout Address A3 shopper identity and persistence", () => {
  it("reuses shopper identity for repeated verified-session persistence and stores no raw phone", async () => {
    const { state, service } = makeHarness();
    await service.persistCheckoutAddress("verified_a", basePayload({ line1: "House 1, Block A" }));
    await service.persistCheckoutAddress("verified_a", basePayload({ line1: "House 2, Block A" }));

    assert.equal(state.identities.length, 1);
    assert.equal(state.addresses.length, 2);
    assert.equal(JSON.stringify(state).includes("9876543243"), false);
    assert.equal(JSON.stringify(state).includes("+919876543243"), false);
  });

  it("validates required fields, pincode, identity fields, source, quality, and consent version", async () => {
    const { service } = makeHarness();

    await assertHttpError(service.persistCheckoutAddress("verified_a", basePayload({ fullName: "" })), 400, "CHECKOUT_ADDRESS_FULL_NAME_REQUIRED");
    await assertHttpError(service.persistCheckoutAddress("verified_a", basePayload({ line1: "" })), 400, "CHECKOUT_ADDRESS_LINE1_REQUIRED");
    await assertHttpError(service.persistCheckoutAddress("verified_a", basePayload({ pincode: "abc" })), 400, "CHECKOUT_ADDRESS_PINCODE_INVALID");
    await assertHttpError(service.persistCheckoutAddress("verified_a", basePayload({ phone: "9876543243" })), 400, "CHECKOUT_ADDRESS_IDENTITY_PAYLOAD_FORBIDDEN");
    await assertHttpError(service.persistCheckoutAddress("verified_a", basePayload({ phoneHash: "hash" })), 400, "CHECKOUT_ADDRESS_IDENTITY_PAYLOAD_FORBIDDEN");
    await assertHttpError(service.persistCheckoutAddress("verified_a", basePayload({ source: "api" })), 400, "CHECKOUT_ADDRESS_SOURCE_INVALID");
    await assertHttpError(service.persistCheckoutAddress("verified_a", basePayload({ quality: 4 })), 400, "CHECKOUT_ADDRESS_QUALITY_INVALID");
    await assertHttpError(service.persistCheckoutAddress("verified_a", basePayload({ consentTextVersion: "" })), 400, "CHECKOUT_ADDRESS_CONSENT_TEXT_VERSION_REQUIRED");
  });

  it("allows unknown pincode only when city and state are supplied manually", async () => {
    const { state, service } = makeHarness();

    await assertHttpError(service.persistCheckoutAddress("verified_a", basePayload({ pincode: "999999" })), 400, "CHECKOUT_ADDRESS_CITY_STATE_REQUIRED");
    const result = await service.persistCheckoutAddress("verified_a", basePayload({
      pincode: "999999",
      city: "Manual City",
      state: "Manual State"
    }));

    assert.deepEqual(result, { addressId: "address_1", deduped: false });
    assert.equal(state.addresses[0].city, "Manual City");
    assert.equal(state.addresses[0].state, "Manual State");
  });

  it("lets known pincode city and state remain editable", async () => {
    const { state, service } = makeHarness();
    await service.persistCheckoutAddress("verified_a", basePayload({
      city: "Edited City",
      state: "Edited State"
    }));

    assert.equal(state.addresses[0].city, "Edited City");
    assert.equal(state.addresses[0].state, "Edited State");
  });

  it("returns only address id and dedup state publicly", async () => {
    const { service } = makeHarness();
    const response = await service.persistCheckoutAddress("verified_a", basePayload());

    assert.deepEqual(Object.keys(response).sort(), ["addressId", "deduped"]);
    assert.equal("phoneHash" in response, false);
    assert.equal(JSON.stringify(response).includes("9876543243"), false);
  });
});

describe("Checkout Address A3 consent helpers", () => {
  it("creates merchant and network consents and stores consent text version exactly", async () => {
    const { state, service } = makeHarness();
    await service.persistCheckoutAddress("verified_a", basePayload({ consentScope: "merchant", consentTextVersion: "address-save-v1" }));
    await service.persistCheckoutAddress("verified_a", basePayload({ line1: "Second Line", consentScope: "network", consentTextVersion: "network-v1.2" }));

    assert.equal(state.consents.length, 2);
    assert.equal(state.consents[0].scope, "merchant");
    assert.equal(state.consents[0].consentTextVersion, "address-save-v1");
    assert.equal(state.consents[1].scope, "network");
    assert.equal(state.consents[1].consentTextVersion, "network-v1.2");
  });

  it("excludes merchant-scope, revoked, expired, and same-merchant network consent", async () => {
    const { state, service } = makeHarness();
    await service.persistCheckoutAddress("verified_a", basePayload({ consentScope: "merchant" }));
    const shopperId = state.identities[0].id;

    assert.equal(await service.isNetworkEligible(shopperId, "merchant_b"), false);

    await service.createAddressConsent({ shopperId, merchantId: "merchant_a", scope: "network", consentTextVersion: "network-v1" });
    assert.equal(await service.isNetworkEligible(shopperId, "merchant_b"), true);
    assert.equal(await service.isNetworkEligible(shopperId, "merchant_a"), false);

    state.consents[state.consents.length - 1].revokedAt = state.now;
    assert.equal(await service.getActiveNetworkConsent(shopperId), null);
    assert.equal(await service.isNetworkEligible(shopperId, "merchant_b"), false);

    const expired = await service.createAddressConsent({
      shopperId,
      merchantId: "merchant_a",
      scope: "network",
      consentTextVersion: "network-v2",
      expiresAt: new Date(baseTime.getTime() - 1000)
    });
    assert.equal(expired.expiresAt.getTime(), baseTime.getTime() - 1000);
    assert.equal(await service.getActiveNetworkConsent(shopperId), null);
  });

  it("finds network-eligible addresses only for a different merchant", async () => {
    const { state, service } = makeHarness();
    await service.persistCheckoutAddress("verified_a", basePayload({ consentScope: "network" }));
    const shopperId = state.identities[0].id;

    assert.equal((await service.findNetworkEligibleAddressesForShopper(shopperId, "merchant_b")).length, 1);
    assert.equal((await service.findNetworkEligibleAddressesForShopper(shopperId, "merchant_a")).length, 0);
  });
});

describe("Checkout Address A3 dedup", () => {
  it("normalizes line1 deterministically", () => {
    assert.equal(normalizeCheckoutAddressLine1("  Flat--4B,   Connaught... Place "), "flat 4b connaught place");
  });

  it("dedups same shopper, pincode, and normalized line1 while bumping use count and quality upward only", async () => {
    const { state, service } = makeHarness();
    const first = await service.persistCheckoutAddress("verified_a", basePayload({ quality: 1 }));
    const lower = await service.persistCheckoutAddress("verified_a", basePayload({
      line1: "Flat 4B Connaught Place",
      quality: 0,
      line2: "Updated Line 2"
    }));
    const higher = await service.persistCheckoutAddress("verified_a", basePayload({
      line1: "Flat 4B, Connaught Place",
      quality: 3
    }));

    assert.deepEqual(first, { addressId: "address_1", deduped: false });
    assert.deepEqual(lower, { addressId: "address_1", deduped: true });
    assert.deepEqual(higher, { addressId: "address_1", deduped: true });
    assert.equal(state.addresses.length, 1);
    assert.equal(state.addresses[0].useCount, 3);
    assert.equal(state.addresses[0].quality, 3);
    assert.equal(state.addresses[0].line2, "Updated Line 2");
  });

  it("inserts a new address for a different pincode", async () => {
    const { state, service } = makeHarness();
    await service.persistCheckoutAddress("verified_a", basePayload());
    const second = await service.persistCheckoutAddress("verified_a", basePayload({ pincode: "560001" }));

    assert.deepEqual(second, { addressId: "address_2", deduped: false });
    assert.equal(state.addresses.length, 2);
  });

  it("inserts a new address for a different shopper", async () => {
    const { state, service } = makeHarness();
    await service.persistCheckoutAddress("verified_a", basePayload());
    const second = await service.persistCheckoutAddress("verified_b", basePayload());

    assert.deepEqual(second, { addressId: "address_2", deduped: false });
    assert.equal(state.identities.length, 2);
    assert.equal(state.addresses.length, 2);
  });
});

describe("Checkout Address A3 route", () => {
  it("mounts POST /checkout/address under the public checkout router", () => {
    const checkoutRoutes = readFileSync("src/modules/checkout/checkout.routes.ts", "utf8");
    assert.match(checkoutRoutes, /checkoutRouter\.use\("\/", checkoutAddressGraphRouter\);/);
  });

  it("persists an address through POST /checkout/address", async () => {
    const { service } = makeHarness();
    const app = await createApp(service);
    try {
      const response = await request(app.baseUrl, "/checkout/address", {
        method: "POST",
        headers: { "x-checkout-session-token": "verified_a" },
        body: JSON.stringify(basePayload())
      });

      assert.equal(response.status, 201);
      assert.deepEqual(response.body, { addressId: "address_1", deduped: false });
      assert.equal("phoneHash" in response.body, false);
    } finally {
      await closeServer(app.server);
    }
  });

  it("returns 400 for invalid payload and 401 for missing or invalid session token", async () => {
    const { service } = makeHarness();
    const app = await createApp(service);
    try {
      const invalidPayload = await request(app.baseUrl, "/checkout/address", {
        method: "POST",
        headers: { "x-checkout-session-token": "verified_a" },
        body: JSON.stringify(basePayload({ phone: "9876543243" }))
      });
      assert.equal(invalidPayload.status, 400);
      assert.equal(invalidPayload.body.error, "VALIDATION_ERROR");

      const missingToken = await request(app.baseUrl, "/checkout/address", {
        method: "POST",
        body: JSON.stringify(basePayload())
      });
      assert.equal(missingToken.status, 401);
      assert.equal(missingToken.body.error, "CHECKOUT_SESSION_TOKEN_INVALID");

      const invalidToken = await request(app.baseUrl, "/checkout/address", {
        method: "POST",
        headers: { "x-checkout-session-token": "invalid" },
        body: JSON.stringify(basePayload())
      });
      assert.equal(invalidToken.status, 401);
      assert.equal(invalidToken.body.error, "CHECKOUT_SESSION_TOKEN_INVALID");
    } finally {
      await closeServer(app.server);
    }
  });
});

describe("Checkout Address A3 safety boundaries", () => {
  it("adds no real verification, messaging, maps, address validation, or paid API calls", () => {
    const sources = [
      "src/modules/checkout/checkout-address-graph.service.ts",
      "src/modules/checkout/checkout-address-graph.routes.ts"
    ].map((file) => readFileSync(file, "utf8")).join("\n");

    assert.equal(/twilio|msg91|gupshup|interakt|wati|aisensy|truecaller\.com|places\.googleapis|addressvalidation|fetch\s*\(|axios|https?:\/\//i.test(sources), false);
  });

  it("does not touch payment, wallet, settlement, payout, Razorpay, Cashfree, or COD ledger source paths", () => {
    const changedSurface = [
      "prisma/schema.prisma",
      "prisma/migrations/20260707123000_address_a3_address_graph_consent/migration.sql",
      "src/modules/checkout/checkout-address-graph.service.ts",
      "src/modules/checkout/checkout-address-graph.routes.ts",
      "src/modules/checkout/checkout-address-graph.service.test.ts",
      "src/modules/checkout/checkout.routes.ts"
    ].join("\n");

    assert.equal(/payment|wallet|settlement|payout|razorpay|cashfree|cod.?ledger/i.test(changedSurface), false);
  });
});
