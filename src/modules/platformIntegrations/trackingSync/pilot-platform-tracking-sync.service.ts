import {
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformTrackingSyncStatus,
  Prisma,
  type PlatformConnection,
  type PlatformImportConversion,
  type PlatformImportItem,
  type Shipment
} from "@prisma/client";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { getLivePilotReadinessSnapshot } from "../../livePilot/live-pilot.service.js";
import { toPrismaJson } from "../../shippingNetwork/shipping-public-serializers.js";
import { serializePlatformTrackingSync } from "../platform-integrations.serializers.js";

type Db = Prisma.TransactionClient | typeof prisma;
type Source = Record<string, unknown>;

export type PlatformTrackingSyncMode = "DRY_RUN" | "LIVE";

export type PlatformTrackingSyncRuntime = {
  enabled: boolean;
  mode: PlatformTrackingSyncMode;
  pilotOnly: boolean;
};

export type PlatformTrackingSyncReadiness = {
  status: "DISABLED" | "DRY_RUN" | "READY" | "BLOCKED";
  ready: boolean;
  runtime: PlatformTrackingSyncRuntime;
  pilot: {
    merchantId: string;
    allowlisted: boolean;
    trackingSyncCapabilityEnabled: boolean;
  };
  shipment: {
    shipmentId: string;
    status: string;
    hasAwb: boolean;
    hasTracking: boolean;
  };
  connection?: {
    connectionId: string;
    platform: string;
    credentialsReady: boolean;
  };
  blockers: string[];
  warnings: string[];
  message: string;
};

function boolValue(source: Source, key: string, fallback = false) {
  const value = source[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "enabled", "live"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disabled", ""].includes(normalized)) return false;
  }
  return fallback;
}

function stringValue(source: Source, key: string, fallback = "") {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

function credentialIdFromRef(value: string | null | undefined) {
  const ref = String(value || "");
  return ref.startsWith("platform-credential:") ? ref.replace(/^platform-credential:/, "") : null;
}

function providerForPlatform(platform: PlatformConnection["platform"]) {
  return platform as unknown as PlatformCredentialProvider;
}

export function getPlatformTrackingSyncRuntime(source: Source = env): PlatformTrackingSyncRuntime {
  const mode = stringValue(source, "SHIPMASTR_PLATFORM_TRACKING_SYNC_MODE", "DRY_RUN").toUpperCase() === "LIVE"
    ? "LIVE"
    : "DRY_RUN";
  return {
    enabled: boolValue(source, "SHIPMASTR_PLATFORM_TRACKING_SYNC_ENABLED", false),
    mode,
    pilotOnly: boolValue(source, "SHIPMASTR_PLATFORM_TRACKING_SYNC_PILOT_ONLY", true)
  };
}

async function findShipment(merchantId: string, shipmentId: string, client: Db) {
  const shipment = await client.shipment.findFirst({
    where: { id: shipmentId, sellerId: merchantId }
  });
  if (!shipment) throw new HttpError(404, "SHIPMENT_NOT_FOUND");
  return shipment;
}

async function findConversionForShipment(merchantId: string, shipmentId: string, client: Db) {
  return client.platformImportConversion.findFirst({
    where: { merchantId, shipmentId },
    orderBy: { createdAt: "desc" }
  });
}

async function findImportItem(
  merchantId: string,
  conversion: PlatformImportConversion | null,
  client: Db
) {
  if (!conversion?.importItemId) return null;
  return client.platformImportItem.findFirst({
    where: { id: conversion.importItemId, merchantId }
  });
}

async function findConnection(
  merchantId: string,
  item: PlatformImportItem | null,
  client: Db
) {
  if (!item?.connectionId) return null;
  return client.platformConnection.findFirst({
    where: { id: item.connectionId, merchantId }
  });
}

async function connectionCredentialsReady(
  merchantId: string,
  connection: PlatformConnection | null,
  client: Db
) {
  if (!connection?.credentialsRef) return false;
  const credentialId = credentialIdFromRef(connection.credentialsRef);
  if (!credentialId) return true;
  const credential = await client.platformCredential.findFirst({
    where: {
      id: credentialId,
      merchantId,
      platform: providerForPlatform(connection.platform)
    }
  });
  return Boolean(credential && credential.status === PlatformCredentialStatus.ACTIVE);
}

export async function getPlatformTrackingSyncReadiness(
  merchantId: string,
  shipmentId: string,
  options: {
    client?: Db;
    source?: Source;
  } = {}
): Promise<PlatformTrackingSyncReadiness> {
  const client = options.client ?? prisma;
  const runtime = getPlatformTrackingSyncRuntime(options.source ?? env);
  const pilot = await getLivePilotReadinessSnapshot(merchantId, client);
  const trackingSyncCapabilityEnabled = pilot.enabledCapabilities.includes("LIVE_PLATFORM_TRACKING_SYNC");
  const shipment = await findShipment(merchantId, shipmentId, client);
  const conversion = await findConversionForShipment(merchantId, shipment.id, client);
  const item = await findImportItem(merchantId, conversion, client);
  const connection = await findConnection(merchantId, item, client);
  const credentialsReady = await connectionCredentialsReady(merchantId, connection, client);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!shipment.awbNumber) blockers.push("SHIPMENT_TRACKING_NOT_READY");
  if (!shipment.trackingUrl && !shipment.trackingPublicUrl && !shipment.awbNumber) blockers.push("SHIPMENT_TRACKING_URL_NOT_READY");
  if (!conversion || !item || !connection) blockers.push("PLATFORM_IMPORT_LINK_NOT_FOUND");
  if (connection && !credentialsReady) blockers.push("PLATFORM_CONNECTION_CREDENTIAL_NOT_READY");

  if (!runtime.enabled) {
    warnings.push("Pilot platform tracking sync is disabled. Dry-run checks can still verify readiness without updating a store.");
  } else {
    if (!runtime.pilotOnly) blockers.push("PLATFORM_TRACKING_SYNC_NOT_PILOT_ONLY");
    if (runtime.mode === "LIVE" && !pilot.allowlisted) blockers.push("LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
    if (runtime.mode === "LIVE" && !trackingSyncCapabilityEnabled) blockers.push("LIVE_PLATFORM_TRACKING_SYNC_CAPABILITY_REQUIRED");
    if (runtime.mode === "DRY_RUN") warnings.push("Platform tracking sync is in dry-run mode; no store update is allowed.");
  }

  const ready = runtime.enabled
    && runtime.pilotOnly
    && runtime.mode === "LIVE"
    && pilot.allowlisted
    && trackingSyncCapabilityEnabled
    && Boolean(shipment.awbNumber)
    && Boolean(conversion && item && connection && credentialsReady);
  const status = !runtime.enabled
    ? "DISABLED"
    : blockers.length
      ? "BLOCKED"
      : runtime.mode === "DRY_RUN"
        ? "DRY_RUN"
        : "READY";

  return {
    status,
    ready,
    runtime,
    pilot: {
      merchantId,
      allowlisted: pilot.allowlisted,
      trackingSyncCapabilityEnabled
    },
    shipment: {
      shipmentId: shipment.id,
      status: String(shipment.status),
      hasAwb: Boolean(shipment.awbNumber),
      hasTracking: Boolean(shipment.trackingUrl || shipment.trackingPublicUrl || shipment.awbNumber)
    },
    ...(connection ? {
      connection: {
        connectionId: connection.id,
        platform: String(connection.platform),
        credentialsReady
      }
    } : {}),
    blockers: Array.from(new Set(blockers)),
    warnings,
    message: ready
      ? "Pilot platform tracking sync is ready for this shipment. Only tracking fields are eligible for update."
      : "Pilot platform tracking sync is not ready. No store update has been performed."
  };
}

function safeMeta(input: {
  mode: PlatformTrackingSyncMode;
  dryRun: boolean;
  liveDispatchDeferred: boolean;
  readiness: PlatformTrackingSyncReadiness;
}) {
  return toPrismaJson({
    mode: input.mode,
    dry_run: input.dryRun,
    live_dispatch_deferred: input.liveDispatchDeferred,
    platform_write_scope: "tracking_only",
    external_call_performed: false,
    readiness_status: input.readiness.status,
    blockers: input.readiness.blockers,
    warnings: input.readiness.warnings
  });
}

async function existingAttempt(
  merchantId: string,
  input: {
    shipmentId: string;
    connectionId: string;
    mode: PlatformTrackingSyncMode;
    trackingNumber: string | null;
  },
  client: Db
) {
  return client.platformTrackingSync.findFirst({
    where: {
      merchantId,
      shipmentId: input.shipmentId,
      connectionId: input.connectionId,
      mode: input.mode,
      trackingNumber: input.trackingNumber,
      status: { in: [PlatformTrackingSyncStatus.PENDING, PlatformTrackingSyncStatus.SYNCED, PlatformTrackingSyncStatus.SKIPPED] }
    },
    orderBy: { createdAt: "desc" }
  });
}

export function serializePlatformTrackingSyncReadiness(readiness: PlatformTrackingSyncReadiness) {
  return {
    status: readiness.status,
    ready: readiness.ready,
    runtime: {
      enabled: readiness.runtime.enabled,
      mode: readiness.runtime.mode,
      pilot_only: readiness.runtime.pilotOnly
    },
    pilot: {
      merchant_id: readiness.pilot.merchantId,
      allowlisted: readiness.pilot.allowlisted,
      tracking_sync_capability_enabled: readiness.pilot.trackingSyncCapabilityEnabled
    },
    shipment: {
      shipment_id: readiness.shipment.shipmentId,
      status: readiness.shipment.status,
      has_awb: readiness.shipment.hasAwb,
      has_tracking: readiness.shipment.hasTracking
    },
    ...(readiness.connection ? {
      connection: {
        connection_id: readiness.connection.connectionId,
        platform: readiness.connection.platform,
        credentials_ready: readiness.connection.credentialsReady
      }
    } : {}),
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    message: readiness.message
  };
}

export async function listShipmentPlatformTrackingSyncAttempts(
  merchantId: string,
  shipmentId: string,
  client: Db = prisma
) {
  await findShipment(merchantId, shipmentId, client);
  const attempts = await client.platformTrackingSync.findMany({
    where: { merchantId, shipmentId },
    orderBy: { createdAt: "desc" },
    take: 20
  });
  return {
    tracking_syncs: attempts.map(serializePlatformTrackingSync)
  };
}

export async function runShipmentPlatformTrackingSyncDryRun(
  merchantId: string,
  shipmentId: string,
  client: Db = prisma,
  source: Source = env
) {
  const readiness = await getPlatformTrackingSyncReadiness(merchantId, shipmentId, { client, source });
  if (!readiness.connection) throw new HttpError(409, "PLATFORM_IMPORT_LINK_NOT_FOUND");
  if (!readiness.shipment.hasAwb || !readiness.shipment.hasTracking) throw new HttpError(409, "SHIPMENT_TRACKING_NOT_READY");
  if (!readiness.connection.credentialsReady) throw new HttpError(409, "PLATFORM_CONNECTION_CREDENTIAL_NOT_READY");

  const shipment = await findShipment(merchantId, shipmentId, client);
  const existing = await existingAttempt(merchantId, {
    shipmentId,
    connectionId: readiness.connection.connectionId,
    mode: "DRY_RUN",
    trackingNumber: shipment.awbNumber ?? null
  }, client);
  if (existing) return serializePlatformTrackingSync(existing);

  const record = await client.platformTrackingSync.create({
    data: {
      connectionId: readiness.connection.connectionId,
      merchantId,
      shipmentId,
      platform: readiness.connection.platform as any,
      externalOrderId: shipment.externalOrderId,
      trackingNumber: shipment.awbNumber,
      trackingUrl: shipment.trackingPublicUrl ?? shipment.trackingUrl,
      status: PlatformTrackingSyncStatus.SKIPPED,
      mode: "DRY_RUN",
      lastAttemptAt: new Date(),
      errorMessage: "Dry-run only. No platform store update was performed.",
      safeMeta: safeMeta({
        mode: "DRY_RUN",
        dryRun: true,
        liveDispatchDeferred: false,
        readiness
      })
    }
  });
  return serializePlatformTrackingSync(record);
}

export async function runShipmentPlatformTrackingSync(
  merchantId: string,
  shipmentId: string,
  client: Db = prisma,
  source: Source = env
) {
  const readiness = await getPlatformTrackingSyncReadiness(merchantId, shipmentId, { client, source });
  if (!readiness.runtime.enabled) throw new HttpError(409, "PLATFORM_TRACKING_SYNC_DISABLED");
  if (!readiness.runtime.pilotOnly) throw new HttpError(409, "PLATFORM_TRACKING_SYNC_NOT_PILOT_ONLY");
  if (readiness.runtime.mode !== "LIVE") throw new HttpError(409, "PLATFORM_TRACKING_SYNC_LIVE_MODE_REQUIRED");
  if (!readiness.pilot.allowlisted) throw new HttpError(409, "LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
  if (!readiness.pilot.trackingSyncCapabilityEnabled) throw new HttpError(409, "LIVE_PLATFORM_TRACKING_SYNC_CAPABILITY_REQUIRED");
  if (!readiness.connection) throw new HttpError(409, "PLATFORM_IMPORT_LINK_NOT_FOUND");
  if (!readiness.connection.credentialsReady) throw new HttpError(409, "PLATFORM_CONNECTION_CREDENTIAL_NOT_READY");
  if (!readiness.shipment.hasAwb || !readiness.shipment.hasTracking) throw new HttpError(409, "SHIPMENT_TRACKING_NOT_READY");

  const shipment = await findShipment(merchantId, shipmentId, client);
  const existing = await existingAttempt(merchantId, {
    shipmentId,
    connectionId: readiness.connection.connectionId,
    mode: "LIVE",
    trackingNumber: shipment.awbNumber ?? null
  }, client);
  if (existing) return serializePlatformTrackingSync(existing);

  const now = new Date();
  const record = await client.platformTrackingSync.create({
    data: {
      connectionId: readiness.connection.connectionId,
      merchantId,
      shipmentId,
      platform: readiness.connection.platform as any,
      externalOrderId: shipment.externalOrderId,
      trackingNumber: shipment.awbNumber,
      trackingUrl: shipment.trackingPublicUrl ?? shipment.trackingUrl,
      status: PlatformTrackingSyncStatus.PENDING,
      mode: "LIVE",
      lastAttemptAt: now,
      errorMessage: null,
      safeMeta: safeMeta({
        mode: "LIVE",
        dryRun: false,
        liveDispatchDeferred: true,
        readiness
      })
    }
  });
  await client.platformConnection.update({
    where: { id: readiness.connection.connectionId },
    data: { lastTrackingSyncAt: now }
  });
  return serializePlatformTrackingSync(record);
}
