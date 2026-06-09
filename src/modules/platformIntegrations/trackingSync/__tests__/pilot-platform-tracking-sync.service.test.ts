import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformTrackingSyncStatus,
  ShipmentStatus,
  StorePlatform
} from "@prisma/client";
import { HttpError } from "../../../../lib/httpError.js";
import {
  getPlatformTrackingSyncReadiness,
  listShipmentPlatformTrackingSyncAttempts,
  runShipmentPlatformTrackingSync,
  runShipmentPlatformTrackingSyncDryRun,
  serializePlatformTrackingSyncReadiness
} from "../pilot-platform-tracking-sync.service.js";

function now() {
  return new Date("2026-06-08T17:00:00.000Z");
}

function createState(overrides: {
  allowlisted?: boolean;
  trackingCapability?: boolean;
  awb?: string | null;
  credentialsReady?: boolean;
} = {}) {
  const state = {
    shipments: [{
      id: "shipment_1",
      sellerId: "merchant_1",
      status: ShipmentStatus.manifested,
      awbNumber: overrides.awb === undefined ? "SM123456789" : overrides.awb,
      trackingUrl: "/tracking/?awb=SM123456789",
      trackingPublicUrl: "/t/public-token",
      externalOrderId: "order_1001",
      createdAt: now(),
      updatedAt: now()
    }],
    conversions: [{
      id: "conversion_1",
      merchantId: "merchant_1",
      importItemId: "item_1",
      shipmentId: "shipment_1",
      status: "CONVERTED",
      createdAt: now(),
      updatedAt: now()
    }],
    items: [{
      id: "item_1",
      merchantId: "merchant_1",
      connectionId: "connection_1",
      platform: StorePlatform.SHOPIFY,
      externalOrderId: "order_1001"
    }],
    connections: [{
      id: "connection_1",
      merchantId: "merchant_1",
      platform: StorePlatform.SHOPIFY,
      credentialsRef: "platform-credential:credential_1",
      lastTrackingSyncAt: null
    }],
    credentials: [{
      id: "credential_1",
      merchantId: "merchant_1",
      platform: PlatformCredentialProvider.SHOPIFY,
      status: overrides.credentialsReady === false ? PlatformCredentialStatus.REVOKED : PlatformCredentialStatus.ACTIVE
    }],
    livePilotMerchants: overrides.allowlisted ? [{
      id: "pilot_1",
      merchantId: "merchant_1",
      status: "ENABLED"
    }] : [],
    livePilotCapabilities: overrides.trackingCapability ? [{
      id: "capability_1",
      merchantId: "merchant_1",
      capability: "LIVE_PLATFORM_TRACKING_SYNC",
      status: "ENABLED"
    }] : [],
    trackingSyncs: [] as any[]
  };

  const client = {
    shipment: {
      findFirst: async ({ where }: any) => state.shipments.find((row) => row.id === where.id && row.sellerId === where.sellerId) ?? null
    },
    platformImportConversion: {
      findFirst: async ({ where }: any) => state.conversions.find((row) => row.merchantId === where.merchantId && row.shipmentId === where.shipmentId) ?? null
    },
    platformImportItem: {
      findFirst: async ({ where }: any) => state.items.find((row) => row.id === where.id && row.merchantId === where.merchantId) ?? null
    },
    platformConnection: {
      findFirst: async ({ where }: any) => state.connections.find((row) => row.id === where.id && row.merchantId === where.merchantId) ?? null,
      update: async ({ where, data }: any) => {
        const record = state.connections.find((row) => row.id === where.id);
        if (!record) throw new Error("connection missing");
        Object.assign(record, data);
        return record;
      }
    },
    platformCredential: {
      findFirst: async ({ where }: any) => state.credentials.find((row) => (
        row.id === where.id
        && row.merchantId === where.merchantId
        && row.platform === where.platform
      )) ?? null
    },
    platformTrackingSync: {
      findFirst: async ({ where }: any) => state.trackingSyncs.find((row) => (
        row.merchantId === where.merchantId
        && row.shipmentId === where.shipmentId
        && row.connectionId === where.connectionId
        && row.mode === where.mode
        && row.trackingNumber === where.trackingNumber
        && where.status.in.includes(row.status)
      )) ?? null,
      findMany: async ({ where }: any) => state.trackingSyncs.filter((row) => row.merchantId === where.merchantId && row.shipmentId === where.shipmentId),
      create: async ({ data }: any) => {
        const record = {
          id: `sync_${state.trackingSyncs.length + 1}`,
          createdAt: now(),
          updatedAt: now(),
          syncedAt: null,
          ...data
        };
        state.trackingSyncs.push(record);
        return record;
      }
    },
    livePilotMerchant: {
      findUnique: async ({ where }: any) => state.livePilotMerchants.find((row) => row.merchantId === where.merchantId) ?? null
    },
    livePilotCapability: {
      findMany: async ({ where }: any) => state.livePilotCapabilities.filter((row) => row.merchantId === where.merchantId)
    }
  };

  return { state, client: client as any };
}

const disabledSource = {
  SHIPMASTR_PLATFORM_TRACKING_SYNC_ENABLED: "false",
  SHIPMASTR_PLATFORM_TRACKING_SYNC_MODE: "DRY_RUN",
  SHIPMASTR_PLATFORM_TRACKING_SYNC_PILOT_ONLY: "true"
};

const dryRunSource = {
  SHIPMASTR_PLATFORM_TRACKING_SYNC_ENABLED: "true",
  SHIPMASTR_PLATFORM_TRACKING_SYNC_MODE: "DRY_RUN",
  SHIPMASTR_PLATFORM_TRACKING_SYNC_PILOT_ONLY: "true"
};

const liveSource = {
  SHIPMASTR_PLATFORM_TRACKING_SYNC_ENABLED: "true",
  SHIPMASTR_PLATFORM_TRACKING_SYNC_MODE: "LIVE",
  SHIPMASTR_PLATFORM_TRACKING_SYNC_PILOT_ONLY: "true"
};

describe("pilot platform tracking sync foundation", () => {
  it("keeps live platform tracking sync disabled by default", async () => {
    const { client } = createState();
    const readiness = await getPlatformTrackingSyncReadiness("merchant_1", "shipment_1", { client, source: disabledSource });
    assert.equal(readiness.status, "DISABLED");
    assert.equal(readiness.ready, false);
    await assert.rejects(
      () => runShipmentPlatformTrackingSync("merchant_1", "shipment_1", client, disabledSource),
      (error) => error instanceof HttpError && error.message === "PLATFORM_TRACKING_SYNC_DISABLED"
    );
  });

  it("records dry-run tracking sync attempts without store updates and stays idempotent", async () => {
    const { state, client } = createState();
    const first = await runShipmentPlatformTrackingSyncDryRun("merchant_1", "shipment_1", client, dryRunSource);
    const second = await runShipmentPlatformTrackingSyncDryRun("merchant_1", "shipment_1", client, dryRunSource);
    assert.equal(first.sync_id, second.sync_id);
    assert.equal(state.trackingSyncs.length, 1);
    assert.equal(first.status, PlatformTrackingSyncStatus.SKIPPED);
    assert.equal(first.mode, "DRY_RUN");
    const meta = first.safe_meta as Record<string, unknown>;
    assert.equal(meta.external_call_performed, false);
  });

  it("blocks live sync without merchant allowlist and tracking capability", async () => {
    const { client } = createState();
    const readiness = await getPlatformTrackingSyncReadiness("merchant_1", "shipment_1", { client, source: liveSource });
    assert.equal(readiness.status, "BLOCKED");
    assert.ok(readiness.blockers.includes("LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED"));
    assert.ok(readiness.blockers.includes("LIVE_PLATFORM_TRACKING_SYNC_CAPABILITY_REQUIRED"));
    await assert.rejects(
      () => runShipmentPlatformTrackingSync("merchant_1", "shipment_1", client, liveSource),
      (error) => error instanceof HttpError && error.message === "LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED"
    );
  });

  it("blocks tracking sync when AWB or platform credentials are missing", async () => {
    const missingAwb = createState({ allowlisted: true, trackingCapability: true, awb: null });
    await assert.rejects(
      () => runShipmentPlatformTrackingSync("merchant_1", "shipment_1", missingAwb.client, liveSource),
      (error) => error instanceof HttpError && error.message === "SHIPMENT_TRACKING_NOT_READY"
    );

    const revokedCredential = createState({ allowlisted: true, trackingCapability: true, credentialsReady: false });
    await assert.rejects(
      () => runShipmentPlatformTrackingSync("merchant_1", "shipment_1", revokedCredential.client, liveSource),
      (error) => error instanceof HttpError && error.message === "PLATFORM_CONNECTION_CREDENTIAL_NOT_READY"
    );
  });

  it("records a live pilot tracking-only attempt without raw platform responses and remains idempotent", async () => {
    const { state, client } = createState({ allowlisted: true, trackingCapability: true });
    const first = await runShipmentPlatformTrackingSync("merchant_1", "shipment_1", client, liveSource);
    const second = await runShipmentPlatformTrackingSync("merchant_1", "shipment_1", client, liveSource);
    const attempts = await listShipmentPlatformTrackingSyncAttempts("merchant_1", "shipment_1", client);
    assert.equal(first.sync_id, second.sync_id);
    assert.equal(attempts.tracking_syncs.length, 1);
    assert.equal(state.trackingSyncs.length, 1);
    assert.equal(first.status, PlatformTrackingSyncStatus.PENDING);
    assert.equal(first.mode, "LIVE");
    const meta = first.safe_meta as Record<string, unknown>;
    assert.equal(meta.platform_write_scope, "tracking_only");
    assert.equal(meta.external_call_performed, false);
    assert.equal(meta.live_dispatch_deferred, true);
    assert.ok(state.connections[0]?.lastTrackingSyncAt);

    const json = JSON.stringify(first);
    assert.doesNotMatch(json, /rawPayload|rawHeaders|rawResponse|credentialHash|secretHash|Authorization|Bearer|accessToken|consumerSecret|Bigship|providerName|courier/i);
  });

  it("serializes readiness without exposing credentials or provider internals", async () => {
    const { client } = createState({ allowlisted: true, trackingCapability: true });
    const readiness = await getPlatformTrackingSyncReadiness("merchant_1", "shipment_1", { client, source: liveSource });
    const serialized = serializePlatformTrackingSyncReadiness(readiness);
    assert.equal(serialized.ready, true);
    assert.equal(serialized.connection?.credentials_ready, true);
    assert.doesNotMatch(JSON.stringify(serialized), /secretRef|encryptedValue|credentialHash|secretHash|Authorization|Bearer|Bigship|providerName|courier/i);
  });
});
