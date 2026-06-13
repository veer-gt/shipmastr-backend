import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  serializeCourierTrackingCertificationAdmin,
  serializeCourierTrackingCertificationSellerSafe
} from "../courier-tracking-certification.serializer.js";
import {
  providerTrackingStatusMap,
  runCourierTrackingCertificationDryRun
} from "../courier-tracking-certification.service.js";

const now = new Date("2026-06-13T10:00:00.000Z");

function liveReadiness(overrides: Record<string, unknown> = {}) {
  return {
    status: "BLOCKED",
    ready: false,
    runtime: { enabled: true, mode: "LIVE", pilotOnly: true },
    pilot: {
      merchantId: "merchant_1",
      allowlisted: true,
      liveRatesCapabilityEnabled: true,
      awbLabelCapabilityEnabled: true
    },
    providerReadiness: {
      hasActiveProvider: true,
      activeProviderCount: 1
    },
    shiprocket: {
      oneShotEnabled: true,
      oneShotApprovalPresent: false,
      allowedMerchantMatched: true,
      allowedShipmentMatched: true,
      credentialId: "credential_1",
      credentialRefConfigured: true,
      credentialResolved: true
    },
    blockers: ["LIVE_SHIPROCKET_ONE_SHOT_APPROVAL_REQUIRED"],
    warnings: [],
    message: "safe",
    ...overrides
  } as any;
}

function certification(overrides: Record<string, unknown> = {}) {
  return {
    provider_key: "SHIPROCKET",
    provider_label_internal: "Shiprocket",
    public_network_name: "Shipmastr Courier Network",
    status: "READY_FOR_PILOT",
    live_ready: false,
    can_use_for_rates: true,
    can_use_for_awb: false,
    can_use_for_label: false,
    can_use_for_tracking: false,
    dimensions: [
      { key: "PUBLIC_SAFETY", status: "PASS", blockers: [], warnings: [], safe_summary: {} },
      { key: "TRACKING", status: "NOT_RUN", blockers: ["PROVIDER_TRACKING_NOT_CERTIFIED"], warnings: [], safe_summary: { sandbox_status: "AVAILABLE" } }
    ],
    blockers: ["PROVIDER_TRACKING_NOT_CERTIFIED"],
    warnings: [],
    next_actions: [],
    checked_at: now.toISOString(),
    ...overrides
  } as any;
}

function fakeClient(input: {
  shipment?: Record<string, unknown>;
  providerRef?: Record<string, unknown> | null;
} = {}) {
  const state = {
    shipment: {
      id: "shipment_1",
      sellerId: "merchant_1",
      pickupLocationId: "pickup_1",
      awbNumber: "SM123456",
      trackingUrl: null,
      metadata: { phase6: {} },
      status: "label_generated",
      createdAt: now,
      updatedAt: now,
      ...input.shipment
    },
    providerRef: input.providerRef === null ? null : {
      id: "provider_ref_1",
      shipmentId: "shipment_1",
      providerAwb: "190123456789",
      providerOrderId: "987654321",
      providerShipmentId: "987654321",
      createdAt: now,
      updatedAt: now,
      ...input.providerRef
    }
  };
  const calls = {
    shipmentUpdate: 0,
    trackingEventCreate: 0,
    providerRefCreate: 0,
    providerRefUpdate: 0
  };
  const client = {
    shipment: {
      findFirst: async ({ where }: any) => where.id === state.shipment.id && where.sellerId === state.shipment.sellerId ? state.shipment : null,
      update: async () => {
        calls.shipmentUpdate += 1;
        throw new Error("MUTATION_NOT_ALLOWED");
      }
    },
    shipmentProviderRef: {
      findFirst: async ({ where }: any) => where.shipmentId === state.shipment.id ? state.providerRef : null,
      create: async () => {
        calls.providerRefCreate += 1;
        throw new Error("MUTATION_NOT_ALLOWED");
      },
      update: async () => {
        calls.providerRefUpdate += 1;
        throw new Error("MUTATION_NOT_ALLOWED");
      }
    },
    shipmentTrackingEvent: {
      create: async () => {
        calls.trackingEventCreate += 1;
        throw new Error("MUTATION_NOT_ALLOWED");
      }
    }
  } as any;
  return { state, calls, client };
}

async function dryRun(input: {
  client?: any;
  live?: any;
  cert?: any;
  trackingAdapterReady?: boolean;
  trackingMapperReady?: boolean;
} = {}) {
  const fake = input.client ? { client: input.client, state: null, calls: null } : fakeClient();
  const result = await runCourierTrackingCertificationDryRun("merchant_1", "SHIPROCKET", {
    shipmentId: "shipment_1"
  }, {
    client: fake.client,
    liveReadinessProvider: async () => input.live ?? liveReadiness(),
    certificationProvider: async () => input.cert ?? certification(),
    ...(input.trackingAdapterReady === undefined ? {} : { trackingAdapterReady: input.trackingAdapterReady }),
    ...(input.trackingMapperReady === undefined ? {} : { trackingMapperReady: input.trackingMapperReady })
  });
  return { result, fake };
}

describe("courier tracking certification foundation", () => {
  it("blocks tracking dry-run when AWB is missing", async () => {
    const fake = fakeClient({ shipment: { awbNumber: null } });
    const { result } = await dryRun({ client: fake.client, trackingAdapterReady: true });
    assert.equal(result.dry_run_ready, false);
    assert.equal(result.status, "MISSING_AWB");
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_AWB_MISSING"));
  });

  it("blocks tracking dry-run when AWB exists but tracking ref is missing", async () => {
    const fake = fakeClient({ providerRef: null });
    const { result } = await dryRun({ client: fake.client, trackingAdapterReady: true });
    assert.equal(result.dry_run_ready, false);
    assert.equal(result.status, "MISSING_TRACKING_REF");
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_REF_MISSING"));
  });

  it("blocks tracking dry-run when the tracking adapter is missing", async () => {
    const { result } = await dryRun();
    assert.equal(result.dry_run_ready, false);
    assert.equal(result.status, "ADAPTER_MISSING");
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_ADAPTER_MISSING"));
  });

  it("blocks tracking dry-run when mapper readiness is missing", async () => {
    const { result } = await dryRun({ trackingAdapterReady: true, trackingMapperReady: false });
    assert.equal(result.dry_run_ready, false);
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_MAPPER_MISSING"));
  });

  it("returns dry-run ready when payload is ready but live approval is missing", async () => {
    const { result } = await dryRun({ trackingAdapterReady: true });
    assert.equal(result.dry_run_ready, true);
    assert.equal(result.live_read_ready, false);
    assert.equal(result.status, "DRY_RUN_ONLY");
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_APPROVAL_REQUIRED"));
  });

  it("returns live-read ready when all gates are satisfied but does not call live tracking or write events", async () => {
    const fake = fakeClient();
    const { result } = await dryRun({
      client: fake.client,
      trackingAdapterReady: true,
      live: liveReadiness({
        status: "READY",
        ready: true,
        shiprocket: {
          oneShotEnabled: true,
          oneShotApprovalPresent: true,
          allowedMerchantMatched: true,
          allowedShipmentMatched: true,
          credentialId: "credential_1",
          credentialRefConfigured: true,
          credentialResolved: true
        },
        blockers: []
      })
    });
    assert.equal(result.dry_run_ready, true);
    assert.equal(result.live_read_ready, true);
    assert.equal(result.status, "READY_FOR_LIVE_READ");
    assert.deepEqual(fake.calls, { shipmentUpdate: 0, trackingEventCreate: 0, providerRefCreate: 0, providerRefUpdate: 0 });
  });

  it("blocks raw provider tracking leakage risk without exposing the URL", async () => {
    const fake = fakeClient({
      shipment: {
        trackingUrl: "https://shiprocket.example/raw-tracking?token=secret"
      }
    });
    const { result } = await dryRun({ client: fake.client, trackingAdapterReady: true });
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_RAW_PROVIDER_PAYLOAD_BLOCKED"));
    const sellerSafe = serializeCourierTrackingCertificationSellerSafe(result);
    assert.doesNotMatch(JSON.stringify(sellerSafe), /shiprocket|raw-tracking|token|secret/i);
  });

  it("maps provider tracking statuses into Shipmastr public statuses", () => {
    assert.equal(providerTrackingStatusMap.created, "created");
    assert.equal(providerTrackingStatusMap.awb_assigned, "manifested");
    assert.equal(providerTrackingStatusMap.pickup_scheduled, "pickup_pending");
    assert.equal(providerTrackingStatusMap.delivered, "delivered");
    assert.equal(providerTrackingStatusMap.rto_in_transit, "rto_initiated");
    assert.equal(providerTrackingStatusMap.unknown, "unknown");
  });

  it("seller-safe output hides provider names, ids, secrets, and raw fields", async () => {
    const { result } = await dryRun({
      trackingAdapterReady: true,
      cert: certification({
        warnings: ["Shiprocket providerShipmentId rawPayload Authorization Bearer secret"]
      })
    });
    const sellerSafe = serializeCourierTrackingCertificationSellerSafe(result);
    const adminSafe = serializeCourierTrackingCertificationAdmin(result);
    assert.doesNotMatch(JSON.stringify(sellerSafe), /Shiprocket|SHIPROCKET|Bigship|BIGSHIP|Shipmozo|SHIPMOZO|987654321|190123456789|providerOrderId|providerShipmentId|providerCourierId|rawPayload|rawHeaders|Authorization|Bearer|token|secret|trackingUrl/i);
    assert.match(JSON.stringify(adminSafe), /SHIPROCKET|TRACKING_CERTIFICATION_APPROVAL_REQUIRED/);
  });

  it("route and service remain dry-run only without Ship Now, provider tracking endpoint, AWB writes, labels, or provider ref writes", () => {
    const routes = readFileSync("src/modules/courierPartners/trackingCertification/courier-tracking-certification.routes.ts", "utf8");
    const service = readFileSync("src/modules/courierPartners/trackingCertification/courier-tracking-certification.service.ts", "utf8");
    assert.match(routes, /post\("\/tracking-certification\/providers\/:providerKey\/shipments\/:shipmentId\/dry-run"/);
    assert.doesNotMatch(`${routes}\n${service}`, /shipNowShipment|manifestShipment|createLabel|getLabel|generateLabel|assignAwb|trackOrder|fetchShipmentTracking|shipmentTrackingEvent\.create|createDraftOrder|ShipmentProviderRef\.create|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });
});
