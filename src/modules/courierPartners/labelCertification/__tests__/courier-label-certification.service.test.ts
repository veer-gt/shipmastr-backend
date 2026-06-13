import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { serializeCourierLabelCertificationAdmin, serializeCourierLabelCertificationSellerSafe } from "../courier-label-certification.serializer.js";
import { runCourierLabelCertificationDryRun } from "../courier-label-certification.service.js";

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
} = {}) {
  const state = {
    shipment: {
      id: "shipment_1",
      sellerId: "merchant_1",
      pickupLocationId: "pickup_1",
      awbNumber: "SM123456",
      metadata: { phase6: {} },
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
    }
  } as any;
  return { state, calls, client };
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

  it("route and service remain dry-run only without Ship Now, provider label endpoint, AWB writes, or provider ref writes", () => {
    const routes = readFileSync("src/modules/courierPartners/labelCertification/courier-label-certification.routes.ts", "utf8");
    const service = readFileSync("src/modules/courierPartners/labelCertification/courier-label-certification.service.ts", "utf8");
    assert.match(routes, /post\("\/label-certification\/providers\/:providerKey\/shipments\/:shipmentId\/dry-run"/);
    assert.doesNotMatch(`${routes}\n${service}`, /shipNowShipment|manifestShipment|createLabel|getLabel|generateLabel|assignAwb|createDraftOrder|ShipmentProviderRef\.create|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });
});
