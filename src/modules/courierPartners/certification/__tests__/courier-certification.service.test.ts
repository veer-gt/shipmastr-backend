import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  getCourierCertificationProvider,
  getCourierCertificationSummary
} from "../courier-certification.service.js";
import { sellerSafeCourierAvailability } from "../courier-certification.serializer.js";

function now() {
  return new Date("2026-06-12T08:00:00.000Z");
}

function activeCredential(providerKey = "SHIPROCKET") {
  return {
    id: `credential_${providerKey.toLowerCase()}`,
    merchantId: "merchant_1",
    providerKey,
    mode: "LIVE",
    status: "ACTIVE",
    credentialRef: `vault:${providerKey.toLowerCase()}/live/merchant_1`,
    requiredFields: null,
    safeMeta: {
      required_fields_present: providerKey === "SHIPROCKET"
        ? ["email", "password"]
        : providerKey === "SHIPMOZO"
          ? ["publicKey", "privateKey"]
          : ["clientId", "clientSecret", "accessKey"]
    },
    lastTestedAt: now(),
    lastTestStatus: "PASS",
    lastTestSummary: { probeType: "RATE_SERVICEABILITY", status: "PASS", testedAt: now().toISOString() },
    createdAt: now(),
    updatedAt: now()
  };
}

function smartLiveRate(overrides: Record<string, unknown> = {}) {
  return {
    id: "rate_1",
    sellerId: "merchant_1",
    publicServiceCode: "shipmastr_smart",
    publicServiceName: "Shipmastr Smart",
    rateBreakup: {
      phase6: {
        livePilotRatesMode: "LIVE",
        livePilotRatesReady: true,
        pickupAvailable: true,
        providerCourierId: "123",
        ...overrides
      }
    },
    createdAt: now()
  };
}

function makeClient(input: {
  credentials?: any[];
  rates?: any[];
  probes?: any[];
} = {}) {
  const state = {
    credentials: input.credentials ?? [],
    rates: input.rates ?? [],
    probes: input.probes ?? []
  };
  return {
    courierProviderCredential: {
      findMany: async ({ where, orderBy, take }: any = {}) => {
        let rows = [...state.credentials];
        if (Object.prototype.hasOwnProperty.call(where ?? {}, "merchantId")) {
          rows = rows.filter((row) => row.merchantId === where.merchantId);
        }
        if (where?.providerKey) rows = rows.filter((row) => row.providerKey === where.providerKey);
        if (where?.mode) rows = rows.filter((row) => row.mode === where.mode);
        if (where?.status) rows = rows.filter((row) => row.status === where.status);
        if (where?.credentialRef?.not === null) rows = rows.filter((row) => row.credentialRef !== null);
        if (where?.lastTestStatus) rows = rows.filter((row) => row.lastTestStatus === where.lastTestStatus);
        if (where?.lastTestedAt?.not === null) rows = rows.filter((row) => row.lastTestedAt !== null);
        if (orderBy?.updatedAt === "desc") rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        if (orderBy?.lastTestedAt === "desc") rows.sort((a, b) => b.lastTestedAt.getTime() - a.lastTestedAt.getTime());
        return take ? rows.slice(0, take) : rows;
      }
    },
    courierProviderReadinessProbe: {
      findMany: async ({ where, orderBy, take }: any = {}) => {
        let rows = [...state.probes];
        if (where?.merchantId) rows = rows.filter((row) => row.merchantId === where.merchantId);
        if (where?.providerKey) rows = rows.filter((row) => row.providerKey === where.providerKey);
        if (orderBy?.testedAt === "desc") rows.sort((a, b) => b.testedAt.getTime() - a.testedAt.getTime());
        return take ? rows.slice(0, take) : rows;
      }
    },
    shipmentRate: {
      findMany: async ({ where, orderBy, take }: any = {}) => {
        let rows = [...state.rates];
        if (where?.sellerId) rows = rows.filter((row) => row.sellerId === where.sellerId);
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return take ? rows.slice(0, take) : rows;
      }
    }
  } as any;
}

const pickupAligned = {
  merchantId: "merchant_1",
  checkedAt: now().toISOString(),
  credentialReady: true,
  shipmastrPickupCount: 1,
  providerPickupCount: 1,
  selectedPickup: {
    pickupLocationId: "pickup_1",
    name: "Warehouse",
    city: "Delhi",
    state: "Delhi",
    pincode: "110001",
    active: true
  },
  liveRate: { found: true, pickupAvailable: true },
  matchedProviderPickup: {
    providerPickupIdPresent: true,
    providerPickupIdSuffix: "99",
    pickupName: "Warehouse",
    city: "Delhi",
    state: "Delhi",
    pincode: "110001",
    active: true,
    verified: true,
    statusFlags: []
  },
  providerPickupPincodeMatch: true,
  status: "SHIPROCKET_PICKUP_ALIGNED_READY",
  anyUsableProviderPickup: true,
  blockers: [],
  warnings: [],
  pickups: []
} as any;

describe("courier partner certification layer", () => {
  it("blocks Shiprocket certification when live rates report pickup unavailable", async () => {
    const result = await getCourierCertificationProvider("merchant_1", "SHIPROCKET", {
      client: makeClient({
        credentials: [activeCredential()],
        rates: [smartLiveRate({ pickupAvailable: false })],
        probes: [{
          providerKey: "SHIPROCKET",
          merchantId: "merchant_1",
          probeType: "RATE_SERVICEABILITY",
          status: "PASS",
          testedAt: now()
        }]
      }),
      pickupDiagnostics: {
        ...pickupAligned,
        liveRate: { found: true, pickupAvailable: false },
        blockers: ["SHIPROCKET_LIVE_PICKUP_UNAVAILABLE"],
        status: "SHIPROCKET_PICKUP_ALIGNED_BUT_UNAVAILABLE"
      }
    });

    assert.equal(result.provider.status, "BLOCKED");
    assert.equal(result.provider.can_use_for_awb, false);
    assert.ok(result.provider.blockers.includes("PROVIDER_PICKUP_UNAVAILABLE"));
  });

  it("marks Shiprocket ready for pilot rates but not live AWB/label before one-shot certification", async () => {
    const result = await getCourierCertificationProvider("merchant_1", "SHIPROCKET", {
      client: makeClient({
        credentials: [activeCredential()],
        rates: [smartLiveRate()],
        probes: [{
          providerKey: "SHIPROCKET",
          merchantId: "merchant_1",
          probeType: "PINCODE_SERVICEABILITY",
          status: "PASS",
          testedAt: now()
        }]
      }),
      pickupDiagnostics: pickupAligned
    });

    assert.equal(result.provider.status, "READY_FOR_PILOT");
    assert.equal(result.provider.can_use_for_rates, true);
    assert.equal(result.provider.can_use_for_awb, false);
    assert.equal(result.provider.live_ready, false);
    assert.ok(result.provider.blockers.includes("PROVIDER_AWB_NOT_CERTIFIED"));
    assert.ok(result.provider.blockers.includes("PROVIDER_LABEL_NOT_CERTIFIED"));
  });

  it("keeps mock-only providers dry-run ready and not live-ready", async () => {
    const summary = await getCourierCertificationSummary("merchant_1", {
      client: makeClient(),
      checkedAt: now().toISOString()
    });
    const bigship = summary.providers.find((provider) => provider.provider_key === "BIGSHIP")!;
    const shipmozo = summary.providers.find((provider) => provider.provider_key === "SHIPMOZO")!;
    assert.equal(bigship.status, "READY_FOR_DRY_RUN");
    assert.equal(shipmozo.status, "READY_FOR_DRY_RUN");
    assert.equal(bigship.live_ready, false);
    assert.equal(shipmozo.live_ready, false);
  });

  it("reports missing Shiprocket credential as not configured", async () => {
    const result = await getCourierCertificationProvider("merchant_1", "SHIPROCKET", {
      client: makeClient(),
      pickupDiagnostics: null as any
    });
    assert.equal(result.provider.status, "NOT_CONFIGURED");
    assert.ok(result.provider.blockers.includes("PROVIDER_CREDENTIALS_MISSING"));
  });

  it("does not expose secret-like values, raw responses, or provider refs in certification serialization", async () => {
    const result = await getCourierCertificationProvider("merchant_1", "SHIPROCKET", {
      client: makeClient({
        credentials: [{
          ...activeCredential(),
          safeMeta: {
            required_fields_present: ["email", "password"],
            rawPayload: { unsafe: true },
            credentialHash: "hash",
            public_note: "safe"
          },
          lastTestSummary: {
            rawResponse: { unsafe: true },
            Authorization: "Bearer token",
            safe: true
          }
        }],
        rates: [smartLiveRate({ providerCourierId: "123" })],
        probes: []
      }),
      pickupDiagnostics: pickupAligned
    });
    const json = JSON.stringify(result);
    assert.doesNotMatch(json, /password|token|secret|credential value|raw provider response|Authorization|Bearer|rawPayload|rawResponse|credentialHash|provider pickup id|provider courier id/i);
  });

  it("seller-safe helper hides provider names and provider ids", () => {
    const blocked = sellerSafeCourierAvailability({ pickupIssue: true });
    const checking = sellerSafeCourierAvailability({ checking: true });
    const json = JSON.stringify([blocked, checking]);
    assert.match(json, /Shipping option is temporarily unavailable for this pickup/);
    assert.doesNotMatch(json, /Shiprocket|Bigship|Shipmozo|provider courier id|provider pickup id|123/);
  });

  it("registers authenticated shipping certification routes without creating public seller routes", () => {
    const indexRoutes = readFileSync("src/routes/index.ts", "utf8");
    const shippingRoutes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");
    const certificationRoutes = readFileSync("src/modules/courierPartners/certification/courier-certification.routes.ts", "utf8");
    assert.match(indexRoutes, /apiRouter\.use\("\/shipping", requireJwtAuth, shippingNetworkRouter\);/);
    assert.match(shippingRoutes, /courierCertificationRouter/);
    assert.match(certificationRoutes, /\/courier-certification\/providers/);
    assert.match(certificationRoutes, /\/courier-certification\/summary/);
    assert.doesNotMatch(indexRoutes, /shipping\/seller-api.*courier-certification/);
  });
});
