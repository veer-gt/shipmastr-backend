import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  serializeCourierTrackingCertificationAdmin,
  serializeCourierTrackingCertificationLiveRead,
  serializeCourierTrackingCertificationSellerSafe
} from "../courier-tracking-certification.serializer.js";
import {
  providerTrackingStatusMap,
  runCourierTrackingCertificationDryRun,
  runCourierTrackingCertificationLiveReadOneShot
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

function liveReady(overrides: Record<string, unknown> = {}) {
  return liveReadiness({
    status: "READY",
    ready: true,
    shiprocket: {
      oneShotEnabled: true,
      oneShotApprovalPresent: true,
      allowedMerchantMatched: true,
      allowedShipmentMatched: true,
      credentialId: "credential_1",
      credentialRef: "vault://credential_1",
      credentialRefConfigured: true,
      credentialResolved: true
    },
    blockers: [],
    warnings: [],
    ...overrides
  });
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
  allowMutations?: boolean;
} = {}) {
  const state = {
    shipment: {
      id: "shipment_1",
      sellerId: "merchant_1",
      pickupLocationId: "pickup_1",
      awbNumber: "SM123456",
      trackingUrl: null,
      metadata: { phase6: {}, phase42p: { awbCertified: true }, phase42q: { labelCertified: true, publicLabelReady: true } },
      status: "label_generated",
      createdAt: now,
      updatedAt: now,
      ...input.shipment
    },
    providerRef: input.providerRef === null ? null : {
      id: "provider_ref_1",
      shipmentId: "shipment_1",
      courierPartnerId: "courier_partner_1",
      providerAwb: "190123456789",
      providerOrderId: "987654321",
      providerShipmentId: "987654321",
      metadata: {},
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
      update: async ({ where, data }: any) => {
        calls.shipmentUpdate += 1;
        if (!input.allowMutations) throw new Error("MUTATION_NOT_ALLOWED");
        assert.equal(where.id, state.shipment.id);
        Object.assign(state.shipment, data, { updatedAt: now });
        return state.shipment;
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
      create: async ({ data }: any) => {
        calls.trackingEventCreate += 1;
        if (!input.allowMutations) throw new Error("MUTATION_NOT_ALLOWED");
        assert.equal(data.shipmentId, state.shipment.id);
        assert.equal(data.metadata.rawProviderPayloadStored, false);
        assert.equal(data.metadata.rawProviderHeadersStored, false);
        return { id: `tracking_event_${calls.trackingEventCreate}`, ...data, createdAt: now };
      }
    }
  } as any;
  return { state, calls, client };
}

function fakeAdapter(input: { trackingFails?: boolean; unsafeMessage?: boolean; emptyEvents?: boolean } = {}) {
  const calls = {
    trackOrder: 0,
    manifestOrder: 0,
    getLabel: 0,
    createDraftOrder: 0
  };
  return {
    calls,
    adapter: {
      code: "shiprocket",
      login: async () => ({ token: "test", expiresAt: now }),
      ensureToken: async () => ({ token: "test", expiresAt: now }),
      createPickupLocation: async () => {
        throw new Error("NOT_USED");
      },
      createDraftOrder: async () => {
        calls.createDraftOrder += 1;
        throw new Error("DRAFT_NOT_ALLOWED");
      },
      getRates: async () => {
        throw new Error("NOT_USED");
      },
      manifestOrder: async () => {
        calls.manifestOrder += 1;
        throw new Error("MANIFEST_NOT_ALLOWED");
      },
      getLabel: async () => {
        calls.getLabel += 1;
        throw new Error("LABEL_NOT_ALLOWED");
      },
      trackOrder: async () => {
        calls.trackOrder += 1;
        if (input.trackingFails) throw new Error("provider tracking failed");
        return {
          awb: "190123456789",
          trackingNumber: "190123456789",
          status: "in_transit",
          publicStatus: "in_transit",
          latestEvent: input.unsafeMessage ? "Shiprocket raw tracking token secret" : "Shipment moved",
          events: input.emptyEvents ? [] : [{
            status: "manifested",
            publicStatus: "manifested",
            location: "Noida",
            message: "Shipment created",
            checkpointTime: now
          }, {
            status: "in_transit",
            publicStatus: "in_transit",
            location: "Mumbai",
            message: input.unsafeMessage ? "Shiprocket raw tracking token secret" : "Shipment in transit",
            checkpointTime: new Date(now.getTime() + 60_000)
          }],
          providerMetadata: { stored: false }
        };
      },
      cancelOrder: async () => ({ cancelled: true, status: "cancelled", message: "safe", providerMetadata: {} })
    } as any
  };
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

async function liveOneShot(input: {
  fake?: ReturnType<typeof fakeClient>;
  live?: any;
  cert?: any;
  adapter?: ReturnType<typeof fakeAdapter>;
  source?: Record<string, unknown>;
  trackingAdapterReady?: boolean;
  trackingMapperReady?: boolean;
} = {}) {
  const fake = input.fake ?? fakeClient({ allowMutations: true });
  const provider = input.adapter ?? fakeAdapter();
  const result = await runCourierTrackingCertificationLiveReadOneShot("merchant_1", "SHIPROCKET", {
    shipmentId: "shipment_1",
    operatorNote: "Pilot Run 6H live tracking certification"
  }, {
    client: fake.client,
    adapter: provider.adapter,
    source: {
      SHIPMASTR_LIVE_TRACKING_ENABLED: "true",
      SHIPMASTR_LIVE_TRACKING_MODE: "LIVE",
      SHIPMASTR_LIVE_TRACKING_PILOT_ONLY: "true",
      SHIPMASTR_ENABLE_LIVE_SHIPROCKET_TRACKING: "1",
      SHIPMASTR_LIVE_SHIPROCKET_ALLOWED_MERCHANT_ID: "merchant_1",
      SHIPMASTR_LIVE_SHIPROCKET_ALLOWED_SHIPMENT_ID: "shipment_1",
      SHIPMASTR_LIVE_SHIPROCKET_TRACKING_ONE_SHOT_TOKEN: "approval-token",
      SHIPMASTR_LIVE_SHIPROCKET_TRACKING_ONE_SHOT_HEADER: "approval-token",
      ...(input.source ?? {})
    },
    liveReadinessProvider: async () => input.live ?? liveReady(),
    certificationProvider: async () => input.cert ?? certification(),
    trackingAdapterReady: input.trackingAdapterReady ?? true,
    trackingMapperReady: input.trackingMapperReady ?? true
  });
  return { result, fake, provider };
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
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED"));
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
    assert.match(JSON.stringify(adminSafe), /SHIPROCKET|TRACKING_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED/);
  });

  it("live-read blocks without approval header and does not call the provider", async () => {
    const provider = fakeAdapter();
    const { result } = await liveOneShot({
      adapter: provider,
      source: { SHIPMASTR_LIVE_SHIPROCKET_TRACKING_ONE_SHOT_HEADER: "" }
    });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED"));
    assert.deepEqual(provider.calls, { trackOrder: 0, manifestOrder: 0, getLabel: 0, createDraftOrder: 0 });
  });

  it("live-read blocks when AWB is missing", async () => {
    const fake = fakeClient({ allowMutations: true, shipment: { awbNumber: null } });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({ fake, adapter: provider });
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_AWB_MISSING"));
    assert.deepEqual(provider.calls, { trackOrder: 0, manifestOrder: 0, getLabel: 0, createDraftOrder: 0 });
  });

  it("live-read blocks when provider refs are missing", async () => {
    const fake = fakeClient({ allowMutations: true, providerRef: null });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({ fake, adapter: provider });
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_REF_MISSING"));
    assert.deepEqual(provider.calls, { trackOrder: 0, manifestOrder: 0, getLabel: 0, createDraftOrder: 0 });
  });

  it("live-read blocks when allowed shipment does not match", async () => {
    const provider = fakeAdapter();
    const { result } = await liveOneShot({
      adapter: provider,
      source: { SHIPMASTR_LIVE_SHIPROCKET_ALLOWED_SHIPMENT_ID: "other_shipment" }
    });
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH"));
    assert.deepEqual(provider.calls, { trackOrder: 0, manifestOrder: 0, getLabel: 0, createDraftOrder: 0 });
  });

  it("live-read blocks when credentials are not ready", async () => {
    const provider = fakeAdapter();
    const { result } = await liveOneShot({
      adapter: provider,
      live: liveReady({
        shiprocket: {
          oneShotEnabled: true,
          oneShotApprovalPresent: true,
          allowedMerchantMatched: true,
          allowedShipmentMatched: true,
          credentialId: null,
          credentialRefConfigured: false,
          credentialResolved: false
        }
      })
    });
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_CREDENTIALS_NOT_READY"));
    assert.deepEqual(provider.calls, { trackOrder: 0, manifestOrder: 0, getLabel: 0, createDraftOrder: 0 });
  });

  it("live-read blocks when public mapping is missing", async () => {
    const provider = fakeAdapter();
    const { result } = await liveOneShot({
      adapter: provider,
      trackingMapperReady: false
    });
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_MAPPER_MISSING"));
    assert.deepEqual(provider.calls, { trackOrder: 0, manifestOrder: 0, getLabel: 0, createDraftOrder: 0 });
  });

  it("live-read success stores safe normalized tracking events using mocked provider", async () => {
    const { result, fake, provider } = await liveOneShot();
    assert.equal(result.success, true);
    assert.equal(result.tracking_status, "CERTIFIED");
    assert.equal(result.public_tracking_status, "READY");
    assert.equal(result.normalized_events_count, 2);
    assert.equal(result.latest_public_status, "in_transit");
    assert.equal((fake.state.shipment.metadata as any).phase42r.trackingCertified, true);
    assert.equal((fake.state.shipment.metadata as any).phase42r.publicTrackingReady, true);
    assert.equal((fake.state.shipment.metadata as any).phase42r.rawProviderPayloadStored, false);
    assert.equal(fake.calls.trackingEventCreate, 2);
    assert.deepEqual(provider.calls, { trackOrder: 1, manifestOrder: 0, getLabel: 0, createDraftOrder: 0 });
  });

  it("provider failure does not mark tracking ready", async () => {
    const provider = fakeAdapter({ trackingFails: true });
    const { result, fake } = await liveOneShot({ adapter: provider });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_PROVIDER_CALL_FAILED"));
    assert.equal((fake.state.shipment.metadata as any).phase42r, undefined);
    assert.equal(fake.calls.trackingEventCreate, 0);
  });

  it("unsafe provider tracking response does not mark tracking ready", async () => {
    const provider = fakeAdapter({ unsafeMessage: true });
    const { result, fake } = await liveOneShot({ adapter: provider });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("TRACKING_CERTIFICATION_PROVIDER_RESPONSE_INVALID"));
    assert.equal((fake.state.shipment.metadata as any).phase42r, undefined);
    assert.equal(fake.calls.trackingEventCreate, 0);
  });

  it("already certified tracking is idempotent and does not call provider", async () => {
    const fake = fakeClient({
      allowMutations: true,
      shipment: {
        metadata: {
          phase42r: {
            trackingCertified: true,
            publicTrackingReady: true,
            normalizedEventsCount: 1,
            latestPublicStatus: "manifested"
          }
        }
      }
    });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({ fake, adapter: provider });
    assert.equal(result.tracking_status, "ALREADY_CERTIFIED");
    assert.equal(result.latest_public_status, "manifested");
    assert.deepEqual(provider.calls, { trackOrder: 0, manifestOrder: 0, getLabel: 0, createDraftOrder: 0 });
  });

  it("live-read serializer hides provider names, ids, secrets, and raw tracking URL from seller-safe output", async () => {
    const result = serializeCourierTrackingCertificationLiveRead({
      success: false,
      provider_key: "SHIPROCKET",
      public_network_name: "Shipmastr Courier Network",
      shipment_id: "shipment_1",
      tracking_status: "BLOCKED",
      public_tracking_status: "NOT_READY",
      normalized_events_count: 0,
      latest_public_status: null,
      certification_status: "BLOCKED",
      blockers: ["TRACKING_CERTIFICATION_PROVIDER_RESPONSE_INVALID"],
      warnings: ["Shiprocket providerShipmentId rawPayload Authorization Bearer secret https://provider.example/track"],
      seller_safe_message: "Tracking is not ready yet.",
      admin_next_actions: ["Review Shiprocket providerShipmentId rawPayload Authorization Bearer secret"]
    });
    const sellerSafe = JSON.stringify(result.seller_safe);
    assert.doesNotMatch(sellerSafe, /Shiprocket|SHIPROCKET|Bigship|Shipmozo|987654321|190123456789|providerOrderId|providerShipmentId|providerCourierId|rawPayload|rawHeaders|Authorization|Bearer|token|secret|provider\.example|raw tracking|tracking token/i);
  });

  it("routes expose live-read one-shot behind admin and tracking approval header while dry-run remains non-mutating", () => {
    const routes = readFileSync("src/modules/courierPartners/trackingCertification/courier-tracking-certification.routes.ts", "utf8");
    const service = readFileSync("src/modules/courierPartners/trackingCertification/courier-tracking-certification.service.ts", "utf8");
    assert.match(routes, /post\("\/tracking-certification\/providers\/:providerKey\/shipments\/:shipmentId\/dry-run"/);
    assert.match(routes, /post\("\/tracking-certification\/providers\/:providerKey\/shipments\/:shipmentId\/live-read-one-shot"/);
    assert.match(routes, /TRACKING_CERTIFICATION_ADMIN_ONLY/);
    assert.match(routes, /x-shipmastr-live-tracking-approval/);
    assert.doesNotMatch(`${routes}\n${service}`, /shipNowShipment|manifestShipment|createLabel|getLabel|generateLabel|assignAwb|fetchShipmentTracking|ShipmentProviderRef\.create|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });
});
