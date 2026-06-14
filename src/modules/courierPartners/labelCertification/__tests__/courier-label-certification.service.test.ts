import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  serializeCourierLabelCertificationAdmin,
  serializeCourierLabelCertificationLiveOneShot,
  serializeCourierLabelCertificationSellerSafe
} from "../courier-label-certification.serializer.js";
import {
  runCourierLabelCertificationDryRun,
  runCourierLabelCertificationLiveOneShot
} from "../courier-label-certification.service.js";

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
      { key: "LABEL", status: "WARN", blockers: ["PROVIDER_LABEL_NOT_CERTIFIED"], warnings: [], safe_summary: { sandbox_status: "AVAILABLE" } }
    ],
    blockers: ["PROVIDER_LABEL_NOT_CERTIFIED"],
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
      metadata: {
        phase6: {},
        phase42p: {
          awbCertified: true
        }
      },
      status: "rates_fetched",
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
      providerPickupId: "pickup_provider_1",
      metadata: {},
      createdAt: now,
      updatedAt: now,
      ...input.providerRef
    }
  };
  const calls = {
    shipmentUpdate: 0,
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
    }
  } as any;
  return { state, calls, client };
}

function fakeAdapter(input: { labelFails?: boolean; unsafeUrl?: boolean; nullUrl?: boolean } = {}) {
  const calls = {
    getLabel: 0,
    manifestOrder: 0,
    createDraftOrder: 0,
    trackOrder: 0
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
        if (input.labelFails) throw new Error("provider label failed");
        return {
          labelUrl: input.nullUrl ? null : input.unsafeUrl ? "https://provider.example/label.pdf?token=secret" : "https://safe-label.example/label.pdf",
          trackingUrl: null,
          status: "label_generated",
          message: "safe",
          providerMetadata: { stored: false }
        };
      },
      trackOrder: async () => {
        calls.trackOrder += 1;
        throw new Error("TRACKING_NOT_ALLOWED");
      },
      cancelOrder: async () => ({ cancelled: true, status: "cancelled", message: "safe", providerMetadata: {} })
    } as any
  };
}

async function dryRun(input: {
  client?: any;
  live?: any;
  cert?: any;
  labelAdapterReady?: boolean;
} = {}) {
  const fake = input.client ? { client: input.client, state: null, calls: null } : fakeClient();
  const result = await runCourierLabelCertificationDryRun("merchant_1", "SHIPROCKET", {
    shipmentId: "shipment_1"
  }, {
    client: fake.client,
    liveReadinessProvider: async () => input.live ?? liveReadiness(),
    certificationProvider: async () => input.cert ?? certification(),
    ...(input.labelAdapterReady === undefined ? {} : { labelAdapterReady: input.labelAdapterReady })
  });
  return { result, fake };
}

async function liveOneShot(input: {
  client?: any;
  live?: any;
  cert?: any;
  adapter?: any;
  labelAdapterReady?: boolean;
} = {}) {
  const fake = input.client ? { client: input.client, state: null, calls: null } : fakeClient({ allowMutations: true });
  const provider = input.adapter ?? fakeAdapter();
  const result = await runCourierLabelCertificationLiveOneShot("merchant_1", "SHIPROCKET", {
    shipmentId: "shipment_1",
    operatorNote: "Pilot Run 6H live label certification"
  }, {
    client: fake.client,
    adapter: provider.adapter,
    source: {
      SHIPMASTR_ENABLE_LIVE_SHIPROCKET_LABEL: "1",
      SHIPMASTR_LIVE_SHIPROCKET_LABEL_ONE_SHOT_TOKEN: "approval-token",
      SHIPMASTR_LIVE_SHIPROCKET_LABEL_ONE_SHOT_HEADER: "approval-token"
    },
    liveReadinessProvider: async () => input.live ?? liveReady(),
    certificationProvider: async () => input.cert ?? certification(),
    ...(input.labelAdapterReady === undefined ? {} : { labelAdapterReady: input.labelAdapterReady })
  });
  return { result, fake, provider };
}

describe("courier label certification sandbox", () => {
  it("blocks label dry-run when AWB is missing", async () => {
    const fake = fakeClient({ shipment: { awbNumber: null } });
    const { result } = await dryRun({ client: fake.client });
    assert.equal(result.dry_run_ready, false);
    assert.equal(result.status, "MISSING_AWB");
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_AWB_MISSING"));
  });

  it("blocks label dry-run when AWB exists but provider refs are missing", async () => {
    const fake = fakeClient({ providerRef: null });
    const { result } = await dryRun({ client: fake.client });
    assert.equal(result.dry_run_ready, false);
    assert.equal(result.status, "MISSING_PROVIDER_REFS");
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_PROVIDER_REFS_MISSING"));
  });

  it("blocks label dry-run when the label adapter is missing", async () => {
    const { result } = await dryRun({ labelAdapterReady: false });
    assert.equal(result.dry_run_ready, false);
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_ADAPTER_MISSING"));
  });

  it("returns dry-run ready when payload is ready but one-shot gate is missing", async () => {
    const { result } = await dryRun();
    assert.equal(result.dry_run_ready, true);
    assert.equal(result.live_one_shot_ready, false);
    assert.equal(result.status, "DRY_RUN_ONLY");
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED"));
  });

  it("returns one-shot ready when all gates are satisfied but does not generate a label", async () => {
    const fake = fakeClient();
    const { result } = await dryRun({
      client: fake.client,
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
    assert.equal(result.live_one_shot_ready, true);
    assert.equal(result.status, "READY_FOR_ONE_SHOT");
    assert.equal((fake.state.shipment.metadata as any).phase6.labelUrl, undefined);
    assert.deepEqual(fake.calls, { shipmentUpdate: 0, providerRefCreate: 0, providerRefUpdate: 0 });
  });

  it("live one-shot blocks without label approval and does not call the provider", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter();
    const result = await runCourierLabelCertificationLiveOneShot("merchant_1", "SHIPROCKET", {
      shipmentId: "shipment_1"
    }, {
      client: fake.client,
      adapter: provider.adapter,
      source: {
        SHIPMASTR_ENABLE_LIVE_SHIPROCKET_LABEL: "1",
        SHIPMASTR_LIVE_SHIPROCKET_LABEL_ONE_SHOT_TOKEN: "approval-token"
      },
      liveReadinessProvider: async () => liveReady(),
      certificationProvider: async () => certification()
    });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED"));
    assert.deepEqual(provider.calls, { getLabel: 0, manifestOrder: 0, createDraftOrder: 0, trackOrder: 0 });
  });

  it("live one-shot blocks when AWB is missing", async () => {
    const fake = fakeClient({ allowMutations: true, shipment: { awbNumber: null } });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({ client: fake.client, adapter: provider });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_AWB_MISSING"));
    assert.deepEqual(provider.calls, { getLabel: 0, manifestOrder: 0, createDraftOrder: 0, trackOrder: 0 });
  });

  it("live one-shot blocks when provider refs are missing", async () => {
    const fake = fakeClient({ allowMutations: true, providerRef: null });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({ client: fake.client, adapter: provider });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_PROVIDER_REFS_MISSING"));
    assert.deepEqual(provider.calls, { getLabel: 0, manifestOrder: 0, createDraftOrder: 0, trackOrder: 0 });
  });

  it("live one-shot blocks when allowed shipment does not match", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({
      client: fake.client,
      adapter: provider,
      live: liveReady({
        ready: false,
        shiprocket: {
          oneShotEnabled: true,
          oneShotApprovalPresent: true,
          allowedMerchantMatched: true,
          allowedShipmentMatched: false,
          credentialId: "credential_1",
          credentialRef: "vault://credential_1",
          credentialRefConfigured: true,
          credentialResolved: true
        },
        blockers: ["LIVE_SHIPROCKET_ALLOWED_SHIPMENT_MISMATCH"]
      })
    });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH"));
    assert.deepEqual(provider.calls, { getLabel: 0, manifestOrder: 0, createDraftOrder: 0, trackOrder: 0 });
  });

  it("live one-shot blocks when credentials are not ready", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({
      client: fake.client,
      adapter: provider,
      live: liveReady({
        ready: false,
        shiprocket: {
          oneShotEnabled: true,
          oneShotApprovalPresent: true,
          allowedMerchantMatched: true,
          allowedShipmentMatched: true,
          credentialId: null,
          credentialRef: null,
          credentialRefConfigured: false,
          credentialResolved: false
        },
        blockers: ["LIVE_SHIPPING_PROVIDER_NOT_READY"]
      })
    });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_CREDENTIALS_NOT_READY"));
    assert.deepEqual(provider.calls, { getLabel: 0, manifestOrder: 0, createDraftOrder: 0, trackOrder: 0 });
  });

  it("live one-shot blocks when public safety fails", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({
      client: fake.client,
      adapter: provider,
      cert: certification({
        dimensions: [
          { key: "PUBLIC_SAFETY", status: "FAIL", blockers: ["PROVIDER_PUBLIC_SAFETY_NOT_READY"], warnings: [], safe_summary: {} }
        ]
      })
    });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_PUBLIC_SAFETY_NOT_READY"));
    assert.deepEqual(provider.calls, { getLabel: 0, manifestOrder: 0, createDraftOrder: 0, trackOrder: 0 });
  });

  it("live one-shot success stores safe label metadata and does not mark tracking certified", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({ client: fake.client, adapter: provider });
    assert.equal(result.success, true);
    assert.equal(result.label_status, "CERTIFIED");
    assert.equal(result.public_label_status, "READY");
    assert.match(result.shipmastr_label_ref ?? "", /^SMLABEL-/);
    assert.equal(result.tracking_ready, false);
    assert.equal((fake.state.shipment.metadata as any).phase42q.labelCertified, true);
    assert.equal((fake.state.shipment.metadata as any).phase42q.publicLabelReady, true);
    assert.equal((fake.state.shipment.metadata as any).phase42q.trackingCertified, false);
    assert.equal((fake.state.shipment.metadata as any).phase42q.rawProviderUrlStored, false);
    assert.equal(JSON.stringify(fake.state.shipment.metadata).includes("safe-label.example"), false);
    assert.deepEqual(provider.calls, { getLabel: 1, manifestOrder: 0, createDraftOrder: 0, trackOrder: 0 });
  });

  it("provider failure does not mark label ready", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter({ labelFails: true });
    const { result } = await liveOneShot({ client: fake.client, adapter: provider });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_PROVIDER_CALL_FAILED"));
    assert.equal((fake.state.shipment.metadata as any).phase42q, undefined);
    assert.deepEqual(provider.calls, { getLabel: 1, manifestOrder: 0, createDraftOrder: 0, trackOrder: 0 });
  });

  it("unsafe provider label response does not mark label ready", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter({ unsafeUrl: true });
    const { result } = await liveOneShot({ client: fake.client, adapter: provider });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_PROVIDER_RESPONSE_INVALID"));
    assert.equal((fake.state.shipment.metadata as any).phase42q, undefined);
  });

  it("already certified label is idempotent and does not call provider", async () => {
    const fake = fakeClient({
      allowMutations: true,
      shipment: {
        metadata: {
          phase6: {},
          phase42p: { awbCertified: true },
          phase42q: {
            labelCertified: true,
            publicLabelReady: true,
            labelRef: "SMLABEL-SHIPMENT1"
          }
        }
      }
    });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({ client: fake.client, adapter: provider });
    assert.equal(result.success, false);
    assert.equal(result.label_status, "ALREADY_CERTIFIED");
    assert.equal(result.public_label_status, "READY");
    assert.equal(result.shipmastr_label_ref, "SMLABEL-SHIPMENT1");
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_EXISTING_LABEL_READY"));
    assert.deepEqual(provider.calls, { getLabel: 0, manifestOrder: 0, createDraftOrder: 0, trackOrder: 0 });
  });

  it("blocks raw provider label URL leakage risk without exposing the URL", async () => {
    const fake = fakeClient({
      shipment: {
        metadata: { phase6: { labelUrl: "https://shiprocket.example/raw-label.pdf?token=secret" } }
      }
    });
    const { result } = await dryRun({ client: fake.client });
    assert.ok(result.blockers.includes("LABEL_CERTIFICATION_RAW_PROVIDER_URL_BLOCKED"));
    const sellerSafe = serializeCourierLabelCertificationSellerSafe(result);
    assert.doesNotMatch(JSON.stringify(sellerSafe), /shiprocket|raw-label|token|secret/i);
  });

  it("seller-safe output hides provider names, ids, secrets, and raw fields", async () => {
    const { result } = await dryRun({
      cert: certification({
        warnings: ["Shiprocket providerShipmentId rawPayload Authorization Bearer secret"]
      })
    });
    const sellerSafe = serializeCourierLabelCertificationSellerSafe(result);
    const adminSafe = serializeCourierLabelCertificationAdmin(result);
    assert.doesNotMatch(JSON.stringify(sellerSafe), /Shiprocket|SHIPROCKET|Bigship|BIGSHIP|Shipmozo|SHIPMOZO|987654321|190123456789|providerOrderId|providerShipmentId|providerCourierId|rawPayload|rawHeaders|Authorization|Bearer|token|secret|labelUrl/i);
    assert.match(JSON.stringify(adminSafe), /SHIPROCKET|LABEL_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED/);
  });

  it("live one-shot serializer hides provider names, ids, secrets, and raw label URL from seller-safe output", async () => {
    const { result } = await liveOneShot();
    const serialized = serializeCourierLabelCertificationLiveOneShot({
      ...result,
      warnings: ["Shiprocket providerShipmentId rawPayload Authorization Bearer secret https://provider.example/label.pdf"]
    });
    assert.equal(serialized.provider_key, "SHIPROCKET");
    const sellerSafe = JSON.stringify(serialized.seller_safe);
    assert.doesNotMatch(sellerSafe, /Shiprocket|SHIPROCKET|Bigship|Shipmozo|987654321|190123456789|providerOrderId|providerShipmentId|providerCourierId|rawPayload|rawHeaders|Authorization|Bearer|token|secret|provider\.example|label\.pdf/i);
    assert.match(sellerSafe, /Shipmastr Courier Network/);
  });

  it("routes expose live one-shot behind admin and label approval header while dry-run stays non-mutating", () => {
    const routes = readFileSync("src/modules/courierPartners/labelCertification/courier-label-certification.routes.ts", "utf8");
    assert.match(routes, /post\("\/label-certification\/providers\/:providerKey\/shipments\/:shipmentId\/dry-run"/);
    assert.match(routes, /post\("\/label-certification\/providers\/:providerKey\/shipments\/:shipmentId\/live-one-shot"/);
    assert.match(routes, /requireInternalAdminRole/);
    assert.match(routes, /x-shipmastr-live-label-approval/);
    assert.doesNotMatch(routes, /shipNowShipment|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });
});
