import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";

import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { errorHandler } from "../../middleware/error.js";
import { requireMasterAdminJwt } from "../../middleware/jwtAuth.js";
import { createAdminCheckoutAddressNetworkRouter } from "./admin-checkout-address-network.routes.js";
import {
  ADDRESS_NETWORK_DEFAULT_CONFIG,
  CheckoutAddressNetworkService,
  getAddressNetworkConfig,
  type AddressNetworkConfig
} from "./checkout-address-network.service.js";

const baseTime = new Date("2026-07-07T16:00:00.000Z");
const originalUserFindUnique = prisma.user.findUnique.bind(prisma.user);

type Row = Record<string, any>;

afterEach(() => {
  Object.defineProperty(prisma.user, "findUnique", {
    configurable: true,
    value: originalUserFindUnique
  });
});

function clone<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function mockUserFindUnique(role: "MASTER_ADMIN" | "ADMIN") {
  Object.defineProperty(prisma.user, "findUnique", {
    configurable: true,
    value: async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: role === "MASTER_ADMIN" ? "indraveer.chauhan@gmail.com" : "ops-admin@shipmastr.test",
      userType: "INTERNAL_SHIPMASTR",
      role
    })
  });
}

function signRole(role: string) {
  return jwt.sign({
    userId: "user_1",
    merchantId: "merchant_1",
    role
  }, env.JWT_SECRET);
}

function matchesWhere(row: Row, where: Row = {}) {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "createdAt" && condition?.gte) {
      if (row.createdAt < condition.gte) return false;
      continue;
    }
    if (row[key] !== condition) return false;
  }
  return true;
}

function makeNetworkHarness(input: {
  config?: Partial<AddressNetworkConfig>;
  graphRecorderThrows?: boolean;
  finderThrows?: boolean;
} = {}) {
  const state = {
    now: new Date(baseTime),
    identities: [
      { id: "shopper_a", phoneHash: "phone_hash_a", phoneLast2: "43" }
    ] as any[],
    consents: [
      {
        id: "consent_network",
        shopperId: "shopper_a",
        merchantId: "merchant_a",
        scope: "network",
        revokedAt: null,
        expiresAt: null,
        grantedAt: new Date(baseTime.getTime() - 5_000)
      }
    ] as any[],
    addresses: [
      {
        id: "address_network",
        shopperId: "shopper_a",
        firstMerchantId: "merchant_a",
        line1: "Private Lane",
        pincode: "110001",
        lastUsedAt: new Date(baseTime.getTime() - 1_000)
      }
    ] as any[],
    shadowTelemetry: [] as any[],
    addressEvents: [] as any[]
  };

  const client: any = {
    shopperIdentity: {
      findUnique: async ({ where }: any) => clone(state.identities.find((row) => row.phoneHash === where.phoneHash) ?? null)
    },
    addressEvent: {
      count: async ({ where }: any = {}) => state.addressEvents.filter((row) => matchesWhere(row, where)).length
    }
  };

  const networkEligibleAddressFinder = async (shopperId: string, currentMerchantId: string) => {
    if (input.finderThrows) throw new Error("NETWORK_LOOKUP_DOWN");
    const consent = state.consents
      .filter((row) => row.shopperId === shopperId)
      .filter((row) => row.scope === "network")
      .filter((row) => row.revokedAt === null)
      .filter((row) => !row.expiresAt || row.expiresAt > state.now)
      .sort((left, right) => right.grantedAt.getTime() - left.grantedAt.getTime())[0];
    if (!consent || consent.merchantId === currentMerchantId) return [];
    return clone(state.addresses
      .filter((row) => row.shopperId === shopperId)
      .filter((row) => row.firstMerchantId !== currentMerchantId)
      .sort((left, right) => right.lastUsedAt.getTime() - left.lastUsedAt.getTime()));
  };

  const record = (event: string) => async (payload: Row) => {
    if (input.graphRecorderThrows) throw new Error("TELEMETRY_DOWN");
    state.shadowTelemetry.push(clone({ event, ...payload }));
  };

  const service = new CheckoutAddressNetworkService({
    client,
    now: () => state.now,
    config: input.config,
    networkEligibleAddressFinder,
    graphHitNetworkRecorder: record("graph_hit_network"),
    graphMissRecorder: record("graph_miss")
  });

  return { state, service };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withAdminAddressNetworkApp<T>(
  service: CheckoutAddressNetworkService,
  callback: (baseUrl: string) => Promise<T>
) {
  const app = express();
  app.use(
    "/admin/checkout-address-network",
    requireMasterAdminJwt,
    createAdminCheckoutAddressNetworkRouter(service)
  );
  app.use(errorHandler);
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ADDRESS_NETWORK_TEST_SERVER_ADDRESS_UNAVAILABLE");

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

describe("Checkout Address A6 config", () => {
  it("keeps network shadow on, buyer network prefill off, threshold 8, and window 30 by default", () => {
    assert.deepEqual(ADDRESS_NETWORK_DEFAULT_CONFIG, {
      shadowEnabled: true,
      displayEnabled: false,
      activationThresholdPercent: 8,
      metricsWindowDays: 30
    });
    assert.deepEqual(getAddressNetworkConfig(ADDRESS_NETWORK_DEFAULT_CONFIG), ADDRESS_NETWORK_DEFAULT_CONFIG);

    const envSource = readFileSync("src/config/env.ts", "utf8");
    assert.match(envSource, /ADDRESS_NETWORK_SHADOW_ENABLED:\s*envBoolean\(true\)/);
    assert.match(envSource, /ADDRESS_NETWORK_PREFILL_ENABLED:\s*envBoolean\(false\)/);
    assert.match(envSource, /ADDRESS_NETWORK_MIN_HIT_RATE_PERCENT:[\s\S]*default\(8\)/);
    assert.match(envSource, /ADDRESS_NETWORK_METRICS_WINDOW_DAYS:[\s\S]*default\(30\)/);
  });
});

describe("Checkout Address A6 network shadow lookup", () => {
  it("records graph_hit_network for active network consent on a different merchant", async () => {
    const { state, service } = makeNetworkHarness();
    const result = await service.runAddressNetworkShadowLookupForVerifiedSession({
      sessionId: "session_a",
      merchantId: "merchant_b",
      phoneHash: "phone_hash_a",
      phoneLast2: "43"
    });

    assert.deepEqual(result, { checked: true, hit: true, count: 1 });
    assert.equal(state.shadowTelemetry.length, 1);
    assert.equal(state.shadowTelemetry[0].event, "graph_hit_network");
    assert.deepEqual(state.shadowTelemetry[0].meta, { count: 1, status: "hit" });
    assert.equal(/address_|phoneHash|Private Lane|shopper_/i.test(JSON.stringify(state.shadowTelemetry)), false);
  });

  it("excludes merchant-scope, revoked network consent, same merchant, and missing shopper", async () => {
    const merchantScope = makeNetworkHarness();
    merchantScope.state.consents[0].scope = "merchant";
    assert.deepEqual(await merchantScope.service.runAddressNetworkShadowLookupForVerifiedSession({
      sessionId: "session_merchant_scope",
      merchantId: "merchant_b",
      phoneHash: "phone_hash_a",
      phoneLast2: "43"
    }), { checked: true, hit: false, count: 0 });
    assert.equal(merchantScope.state.shadowTelemetry[0].event, "graph_miss");

    const revoked = makeNetworkHarness();
    revoked.state.consents[0].revokedAt = baseTime;
    assert.deepEqual(await revoked.service.runAddressNetworkShadowLookupForVerifiedSession({
      sessionId: "session_revoked",
      merchantId: "merchant_b",
      phoneHash: "phone_hash_a",
      phoneLast2: "43"
    }), { checked: true, hit: false, count: 0 });
    assert.equal(revoked.state.shadowTelemetry[0].event, "graph_miss");

    const sameMerchant = makeNetworkHarness();
    assert.deepEqual(await sameMerchant.service.runAddressNetworkShadowLookupForVerifiedSession({
      sessionId: "session_same_merchant",
      merchantId: "merchant_a",
      phoneHash: "phone_hash_a",
      phoneLast2: "43"
    }), { checked: true, hit: false, count: 0 });
    assert.equal(sameMerchant.state.shadowTelemetry[0].event, "graph_miss");

    const missingShopper = makeNetworkHarness();
    assert.deepEqual(await missingShopper.service.runAddressNetworkShadowLookupForVerifiedSession({
      sessionId: "session_missing",
      merchantId: "merchant_b",
      phoneHash: "phone_hash_missing",
      phoneLast2: "99"
    }), { checked: true, hit: false, count: 0 });
    assert.deepEqual(missingShopper.state.shadowTelemetry[0].meta, {
      count: 0,
      status: "miss",
      reason: "shopper_not_found"
    });
  });

  it("fails closed when network lookup or telemetry fails", async () => {
    const finderDown = makeNetworkHarness({ finderThrows: true });
    assert.deepEqual(await finderDown.service.runAddressNetworkShadowLookupForVerifiedSession({
      sessionId: "session_finder_down",
      merchantId: "merchant_b",
      phoneHash: "phone_hash_a",
      phoneLast2: "43"
    }), { checked: false, hit: false, count: 0 });

    const telemetryDown = makeNetworkHarness({ graphRecorderThrows: true });
    assert.deepEqual(await telemetryDown.service.runAddressNetworkShadowLookupForVerifiedSession({
      sessionId: "session_telemetry_down",
      merchantId: "merchant_b",
      phoneHash: "phone_hash_a",
      phoneLast2: "43"
    }), { checked: true, hit: true, count: 1 });
  });
});

describe("Checkout Address A6 metrics", () => {
  it("returns zero-data metrics without divide-by-zero", async () => {
    const { service } = makeNetworkHarness();
    const metrics = await service.getAddressNetworkMetrics();

    assert.deepEqual(metrics, {
      windowDays: 30,
      shadowEnabled: true,
      displayEnabled: false,
      activationThresholdPercent: 8,
      networkLookupCount: 0,
      graphHitNetworkCount: 0,
      graphMissCount: 0,
      networkHitRatePercent: 0,
      eligibleForDisplay: false,
      t1: {
        graphHitMerchantCount: 0,
        prefillOfferedCount: 0,
        prefillAcceptedCount: 0,
        prefillEditedCount: 0,
        acceptRatePercent: 0
      }
    });
  });

  it("computes trailing-window network hit rate and display eligibility gates", async () => {
    const { state, service } = makeNetworkHarness({ config: { displayEnabled: false, activationThresholdPercent: 50 } });
    state.addressEvents.push(
      { event: "graph_hit_network", createdAt: new Date(baseTime.getTime() - 60_000) },
      { event: "graph_hit_network", createdAt: new Date(baseTime.getTime() - 120_000) },
      { event: "graph_miss", createdAt: new Date(baseTime.getTime() - 180_000) },
      { event: "graph_hit_merchant", createdAt: new Date(baseTime.getTime() - 180_000) },
      { event: "prefill_offered", createdAt: new Date(baseTime.getTime() - 180_000) },
      { event: "prefill_offered", createdAt: new Date(baseTime.getTime() - 180_000) },
      { event: "prefill_accepted", createdAt: new Date(baseTime.getTime() - 180_000) },
      { event: "prefill_edited", createdAt: new Date(baseTime.getTime() - 180_000) },
      { event: "graph_hit_network", createdAt: new Date(baseTime.getTime() - 40 * 24 * 60 * 60 * 1000) }
    );

    const metrics = await service.getAddressNetworkMetrics({ windowDays: 30 });
    assert.equal(metrics.networkLookupCount, 3);
    assert.equal(metrics.graphHitNetworkCount, 2);
    assert.equal(metrics.graphMissCount, 1);
    assert.equal(metrics.networkHitRatePercent, 66.67);
    assert.equal(metrics.eligibleForDisplay, false);
    assert.equal(metrics.t1.acceptRatePercent, 50);

    const enabled = new CheckoutAddressNetworkService({
      client: {
        addressEvent: {
          count: async ({ where }: any = {}) => state.addressEvents.filter((row) => matchesWhere(row, where)).length
        }
      },
      now: () => baseTime,
      config: { displayEnabled: true, activationThresholdPercent: 50 }
    });
    assert.equal((await enabled.getAddressNetworkMetrics({ windowDays: 30 })).eligibleForDisplay, true);
  });

  it("keeps metrics aggregate and PII-free", async () => {
    const { state, service } = makeNetworkHarness({ config: { displayEnabled: true, activationThresholdPercent: 1 } });
    state.addressEvents.push(
      { event: "graph_hit_network", createdAt: baseTime, shopperId: "shopper_private", phoneHash: "hash_private", addressId: "address_private" },
      { event: "graph_miss", createdAt: baseTime }
    );

    const metrics = await service.getAddressNetworkMetrics();
    assert.equal(/shopper|address_|phone|hash|line1|fullName|name/i.test(JSON.stringify(metrics)), false);
  });
});

describe("Checkout Address A6 admin route", () => {
  it("mounts metrics under MASTER_ADMIN-only admin route, not public checkout", () => {
    const indexRoutes = readFileSync("src/routes/index.ts", "utf8");
    const checkoutRoutes = readFileSync("src/modules/checkout/checkout.routes.ts", "utf8");

    assert.match(indexRoutes, /apiRouter\.use\("\/admin\/checkout-address-network", requireMasterAdminJwt, adminCheckoutAddressNetworkRouter\)/);
    assert.doesNotMatch(checkoutRoutes, /checkout-address-network|adminCheckoutAddressNetworkRouter|AddressNetwork/);
  });

  it("rejects unauthenticated and non-master requests, while MASTER_ADMIN gets aggregate metrics", async () => {
    const { state, service } = makeNetworkHarness();
    state.addressEvents.push({ event: "graph_hit_network", createdAt: baseTime });

    await withAdminAddressNetworkApp(service, async (baseUrl) => {
      const unauthenticated = await fetch(`${baseUrl}/admin/checkout-address-network/metrics`);
      assert.equal(unauthenticated.status, 401);

      mockUserFindUnique("ADMIN");
      const nonMaster = await fetch(`${baseUrl}/admin/checkout-address-network/metrics`, {
        headers: { authorization: `Bearer ${signRole("ADMIN")}` }
      });
      assert.equal(nonMaster.status, 403);

      mockUserFindUnique("MASTER_ADMIN");
      const master = await fetch(`${baseUrl}/admin/checkout-address-network/metrics?windowDays=7`, {
        headers: { authorization: `Bearer ${signRole("MASTER_ADMIN")}` }
      });
      assert.equal(master.status, 200);
      const body = await master.json();
      assert.equal(body.windowDays, 7);
      assert.equal(body.graphHitNetworkCount, 1);
      assert.equal(/shopper|address_|phone|hash|line1|fullName|name/i.test(JSON.stringify(body)), false);
    });
  });
});

describe("Checkout Address A6 safety boundaries", () => {
  it("does not add buyer display wiring, external calls, or public network metrics routes", () => {
    const sources = [
      "src/modules/checkout/checkout-address-network.service.ts",
      "src/modules/checkout/admin-checkout-address-network.routes.ts"
    ].map((file) => readFileSync(file, "utf8")).join("\n");

    assert.equal(/fetch\s*\(|axios|https?:\/\//i.test(sources), false);
    const checkoutRoutes = readFileSync("src/modules/checkout/checkout.routes.ts", "utf8");
    assert.equal(/address-network|network\/metrics/i.test(checkoutRoutes), false);
  });
});
