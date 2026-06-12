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
    shipmentId: "shipment_1",
    publicServiceCode: "shipmastr_smart",
    publicServiceName: "Shipmastr Smart",
    amountPaise: 7200,
    rateBreakup: {
      phase6: {
        livePilotRatesMode: "LIVE",
        livePilotRatesReady: true,
        pickupAvailable: true,
        deliveryAvailable: true,
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
  shipments?: any[];
  pickups?: any[];
} = {}) {
  const state = {
    credentials: input.credentials ?? [],
    rates: input.rates ?? [],
    probes: input.probes ?? [],
    shipments: input.shipments ?? [],
    pickups: input.pickups ?? [{
      id: "pickup_1",
      sellerId: "merchant_1",
      label: "Noida Warehouse",
      city: "Noida",
      state: "UP",
      pincode: "201301",
      status: "active",
      createdAt: now()
    }]
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
        if (where?.shipmentId) rows = rows.filter((row) => row.shipmentId === where.shipmentId);
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return take ? rows.slice(0, take) : rows;
      }
    },
    shipment: {
      findFirst: async ({ where }: any = {}) => state.shipments.find((row) => (
        (!where?.id || row.id === where.id)
        && (!where?.sellerId || row.sellerId === where.sellerId)
      )) ?? null
    },
    pickupLocation: {
      findFirst: async ({ where }: any = {}) => state.pickups.find((row) => (
        (!where?.id || row.id === where.id)
        && (!where?.sellerId || row.sellerId === where.sellerId)
      )) ?? null,
      findMany: async ({ where, orderBy }: any = {}) => {
        let rows = [...state.pickups];
        if (where?.sellerId) rows = rows.filter((row) => row.sellerId === where.sellerId);
        if (where?.status) rows = rows.filter((row) => row.status === where.status);
        if (orderBy?.createdAt === "asc") rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return rows;
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
  selectedContext: "shipment_pickup",
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

  it("keeps Shiprocket rates failed when latest refresh has no eligible rates", async () => {
    const result = await getCourierCertificationProvider("merchant_1", "SHIPROCKET", {
      shipmentId: "shipment_1",
      client: makeClient({
        credentials: [activeCredential()],
        rates: [{
          ...smartLiveRate({ pickupAvailable: false }),
          shipmentId: "shipment_1"
        }],
        shipments: [{
          id: "shipment_1",
          sellerId: "merchant_1",
          pickupLocationId: "pickup_1",
          fromPincode: "201301",
          toPincode: "400001",
          paymentMode: "prepaid",
          metadata: {
            phase6: {
              latestRateRefresh: {
                status: "NO_ELIGIBLE_SHIPPING_RATES",
                selected_pickup_pincode: "201301",
                delivery_pincode: "400001",
                live_provider_checked: true,
                live_serviceability_returned_count: 3,
                live_rate_candidates_count: 3,
                eligible_rate_count: 0,
                rejected_rate_reasons: [{ safe_reason: "PICKUP_UNAVAILABLE", count: 3 }],
                provider_pickup_available_any: false,
                provider_delivery_available_any: true,
                stale_selected_rate_ignored: true,
                checked_at: now().toISOString()
              }
            }
          }
        }],
        probes: [{
          providerKey: "SHIPROCKET",
          merchantId: "merchant_1",
          probeType: "RATE_SERVICEABILITY",
          status: "PASS",
          testedAt: now()
        }]
      }),
      pickupDiagnostics: pickupAligned
    });
    const rates = result.provider.dimensions.find((dimension) => dimension.key === "RATES")!;
    const json = JSON.stringify(result.provider);

    assert.equal(rates.status, "FAIL");
    assert.ok(result.provider.blockers.includes("PROVIDER_LATEST_RATE_REFRESH_NO_ELIGIBLE_RATES"));
    assert.equal(rates.safe_summary.latest_refresh_status, "NO_ELIGIBLE_SHIPPING_RATES");
    assert.equal(rates.safe_summary.eligible_rate_count, 0);
    assert.equal(rates.safe_summary.stale_selected_rate_ignored, true);
    assert.equal(rates.safe_summary.pickup_serviceability_status, "PICKUP_UNAVAILABLE");
    assert.equal(rates.safe_summary.pickup_available_count, 0);
    assert.equal(rates.safe_summary.delivery_available_count, 1);
    assert.equal(rates.safe_summary.numeric_courier_id_count, 1);
    assert.equal(rates.safe_summary.recommended_action, "SAFE_REVIEW");
    assert.equal(rates.safe_summary.pickup_learning_status, "UNAVAILABLE");
    assert.equal(rates.safe_summary.pickup_learning_availability_score, 0);
    assert.equal(rates.safe_summary.pickup_learning_recommendation, "TRY_ALTERNATE_PICKUP");
    assert.doesNotMatch(json, /Bigship|Shipmozo|providerCourierId|providerServiceId|rawPayload|rawHeaders|rawResponse|Authorization|Bearer/i);
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

  it("filters provider certification summaries by provider, status, and capability", async () => {
    const summary = await getCourierCertificationSummary("merchant_1", {
      client: makeClient(),
      checkedAt: now().toISOString(),
      providerKey: "BIGSHIP",
      status: "READY_FOR_DRY_RUN",
      capability: "PUBLIC_SAFETY"
    });
    assert.equal(summary.providers.length, 1);
    assert.equal(summary.providers[0]?.provider_key, "BIGSHIP");
    assert.equal(summary.counts.total, 1);
    assert.equal(summary.counts.dry_run_ready, 1);
    assert.equal(summary.counts.blocked, 0);
  });

  it("redacts unsafe camelCase admin summary fields", async () => {
    const result = await getCourierCertificationProvider("merchant_1", "SHIPROCKET", {
      client: makeClient({
        credentials: [activeCredential()],
        rates: [smartLiveRate()]
      }),
      pickupDiagnostics: {
        ...pickupAligned,
        warnings: ["safe warning"],
        pickups: [],
        matchedProviderPickup: {
          providerPayload: { Authorization: "Bearer unsafe" },
          providerResponse: { token: "unsafe" },
          providerRef: "unsafe"
        }
      } as any
    });
    const json = JSON.stringify(result);
    assert.doesNotMatch(json, /providerPayload|providerResponse|providerRef|Authorization|Bearer|token|secret|api_key|password/i);
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
    const certificationValidation = readFileSync("src/modules/courierPartners/certification/courier-certification.validation.ts", "utf8");
    const readinessValidation = readFileSync("src/modules/courierPartners/liveReadiness/courier-live-readiness.validation.ts", "utf8");
    assert.match(indexRoutes, /apiRouter\.use\("\/shipping", requireJwtAuth, shippingNetworkRouter\);/);
    assert.match(shippingRoutes, /courierCertificationRouter/);
    assert.match(certificationRoutes, /\/courier-certification\/providers/);
    assert.match(certificationRoutes, /\/courier-certification\/summary/);
    assert.match(certificationRoutes, /shipmentId: query\.shipment_id/);
    assert.match(certificationRoutes, /pickupLocationId: query\.pickup_location_id/);
    assert.match(certificationRoutes, /providerKey: routeProvider\(query\.provider_key\)/);
    assert.match(certificationRoutes, /status: query\.status/);
    assert.match(certificationRoutes, /capability: query\.capability/);
    assert.match(certificationValidation, /shipment_id/);
    assert.match(certificationValidation, /pickup_location_id/);
    assert.match(certificationValidation, /provider_key/);
    assert.match(certificationValidation, /status/);
    assert.match(certificationValidation, /capability/);
    assert.match(readinessValidation, /pickup_location_id/);
    assert.doesNotMatch(indexRoutes, /shipping\/seller-api.*courier-certification/);
  });
});
