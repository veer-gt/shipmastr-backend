import crypto from "crypto";
import {
  PlatformConnectionStatus,
  PlatformOrderImportStatus,
  PlatformSyncDirection,
  PlatformTrackingSyncStatus,
  StorePlatform,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { getPlatformAdapter } from "./platform-registry.js";
import {
  buildRawPayloadPreview,
  serializeNormalizedPlatformOrder,
  serializePlatformConnection,
  serializePlatformOrderImport,
  serializePlatformTrackingSync
} from "./platform-integrations.serializers.js";
import type {
  CreatePlatformConnectionInput,
  CreatePlatformTrackingSyncInput,
  ListPlatformConnectionsQueryInput,
  ListPlatformOrderImportsQueryInput,
  ListPlatformTrackingSyncsQueryInput,
  PlatformOrderPayloadInput,
  UpdatePlatformConnectionInput
} from "./platform-integrations.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

const credentialKeyPattern = /secret|token|password|api[_-]?key|consumer[_-]?key|consumer[_-]?secret|access[_-]?key/i;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function payloadHash(payload: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload) ?? "null")
    .digest("hex");
}

function assertStoreUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "PLATFORM_STORE_URL_INVALID");
  }

  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!["https:", "http:"].includes(url.protocol) || (url.protocol !== "https:" && !local)) {
    throw new HttpError(400, "PLATFORM_STORE_URL_INVALID");
  }

  return url.toString();
}

function sanitizeCredentialsMeta(value: Record<string, unknown> | null | undefined) {
  if (!value) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (credentialKeyPattern.test(key)) continue;
    if (typeof child === "string" && /sk_|shpat_|ck_|cs_|token|secret/i.test(child)) continue;
    safe[key] = child;
  }
  return Object.keys(safe).length ? safe : null;
}

async function findConnection(merchantId: string, connectionId: string, client: Db) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId }
  });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  return connection;
}

async function findTrackingSync(merchantId: string, syncId: string, client: Db) {
  const sync = await client.platformTrackingSync.findFirst({
    where: { id: syncId, merchantId }
  });
  if (!sync) throw new HttpError(404, "PLATFORM_TRACKING_SYNC_NOT_FOUND");
  return sync;
}

export async function createConnection(
  merchantId: string,
  input: CreatePlatformConnectionInput,
  client: Db = prisma
) {
  const data: Prisma.PlatformConnectionUncheckedCreateInput = {
    merchantId,
    platform: input.platform as StorePlatform,
    storeName: input.storeName ?? null,
    storeUrl: assertStoreUrl(input.storeUrl),
    status: (input.status ?? PlatformConnectionStatus.DRAFT) as PlatformConnectionStatus,
    syncDirection: (input.syncDirection ?? PlatformSyncDirection.IMPORT_ONLY) as PlatformSyncDirection,
    credentialsRef: input.credentialsRef ?? null
  };
  const safeMeta = sanitizeCredentialsMeta(input.credentialsMeta ?? null);
  if (safeMeta) data.credentialsMeta = toJson(safeMeta);

  const connection = await client.platformConnection.create({ data });
  return serializePlatformConnection(connection);
}

export async function listConnections(
  merchantId: string,
  query: ListPlatformConnectionsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const where: Prisma.PlatformConnectionWhereInput = {
    merchantId,
    ...(query.platform ? { platform: query.platform as StorePlatform } : {}),
    ...(query.status ? { status: query.status as PlatformConnectionStatus } : {})
  };
  const [connections, total] = await Promise.all([
    client.platformConnection.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.platformConnection.count({ where })
  ]);

  return {
    connections: connections.map(serializePlatformConnection),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getConnection(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const connection = await findConnection(merchantId, connectionId, client);
  return serializePlatformConnection(connection);
}

export async function updateConnection(
  merchantId: string,
  connectionId: string,
  input: UpdatePlatformConnectionInput,
  client: Db = prisma
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const data: Prisma.PlatformConnectionUncheckedUpdateInput = {};
  if (input.status !== undefined) {
    data.status = input.status as PlatformConnectionStatus;
    data.disabledAt = input.status === PlatformConnectionStatus.DISABLED ? new Date() : null;
  }
  if (input.storeName !== undefined) data.storeName = input.storeName ?? null;
  if (input.syncDirection !== undefined) data.syncDirection = input.syncDirection as PlatformSyncDirection;

  const updated = await client.platformConnection.update({
    where: { id: connection.id },
    data
  });
  return serializePlatformConnection(updated);
}

export async function disableConnection(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const updated = await client.platformConnection.update({
    where: { id: connection.id },
    data: {
      status: PlatformConnectionStatus.DISABLED,
      disabledAt: new Date()
    }
  });
  return serializePlatformConnection(updated);
}

export async function mapPlatformOrder(
  platform: StorePlatform,
  payload: unknown,
  options: { pickupLocationId?: string | null } = {}
) {
  const adapter = getPlatformAdapter(platform);
  if (!adapter) throw new HttpError(400, "PLATFORM_ORDER_MAPPING_UNSUPPORTED");

  const normalized = adapter.mapOrder(payload, options);
  if (!normalized.externalOrderId) throw new HttpError(400, "PLATFORM_ORDER_ID_MISSING");
  return normalized;
}

export async function previewPlatformOrderImport(
  merchantId: string,
  connectionId: string,
  input: PlatformOrderPayloadInput,
  client: Db = prisma
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const normalizedOrder = await mapPlatformOrder(connection.platform, input.payload, {
    pickupLocationId: input.pickupLocationId ?? null
  });

  return {
    connection: serializePlatformConnection(connection),
    normalized_order: serializeNormalizedPlatformOrder(normalizedOrder),
    mapping_warnings: normalizedOrder.mappingWarnings,
    will_create_shipmastr_order: false
  };
}

export async function importPlatformOrderFoundation(
  merchantId: string,
  connectionId: string,
  input: PlatformOrderPayloadInput,
  client: Db = prisma
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const normalizedOrder = await mapPlatformOrder(connection.platform, input.payload, {
    pickupLocationId: input.pickupLocationId ?? null
  });
  const record = await client.platformOrderImport.create({
    data: {
      connectionId: connection.id,
      merchantId,
      platform: connection.platform,
      externalOrderId: normalizedOrder.externalOrderId,
      externalOrderName: normalizedOrder.externalOrderName,
      status: PlatformOrderImportStatus.MAPPED,
      rawPayloadHash: payloadHash(input.payload),
      rawPayloadPreview: toJson(buildRawPayloadPreview(normalizedOrder)),
      mappingWarnings: toJson(normalizedOrder.mappingWarnings)
    }
  });

  await client.platformConnection.update({
    where: { id: connection.id },
    data: { lastOrderImportAt: new Date() }
  });

  return {
    import: serializePlatformOrderImport(record),
    normalized_order: serializeNormalizedPlatformOrder(normalizedOrder),
    order_creation: {
      status: "deferred",
      message: "Platform payload mapped and recorded. Full Shipmastr order creation wiring remains behind the existing seller API foundation."
    }
  };
}

export async function listPlatformOrderImports(
  merchantId: string,
  query: ListPlatformOrderImportsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const where: Prisma.PlatformOrderImportWhereInput = {
    merchantId,
    ...(query.platform ? { platform: query.platform as StorePlatform } : {}),
    ...(query.status ? { status: query.status as PlatformOrderImportStatus } : {}),
    ...(query.connectionId ? { connectionId: query.connectionId } : {})
  };
  const [imports, total] = await Promise.all([
    client.platformOrderImport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.platformOrderImport.count({ where })
  ]);

  return {
    imports: imports.map(serializePlatformOrderImport),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getPlatformOrderImport(
  merchantId: string,
  importId: string,
  client: Db = prisma
) {
  const record = await client.platformOrderImport.findFirst({
    where: { id: importId, merchantId }
  });
  if (!record) throw new HttpError(404, "PLATFORM_ORDER_IMPORT_NOT_FOUND");
  return serializePlatformOrderImport(record);
}

export async function createTrackingSyncFoundation(
  merchantId: string,
  connectionId: string,
  input: CreatePlatformTrackingSyncInput,
  client: Db = prisma
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const shipment = await client.shipment.findFirst({
    where: { id: input.shipmentId, sellerId: merchantId }
  });
  if (!shipment) throw new HttpError(404, "SHIPMENT_NOT_FOUND");

  const record = await client.platformTrackingSync.create({
    data: {
      connectionId: connection.id,
      merchantId,
      shipmentId: shipment.id,
      platform: connection.platform,
      externalOrderId: input.externalOrderId ?? shipment.externalOrderId ?? null,
      trackingNumber: input.trackingNumber ?? shipment.awbNumber ?? null,
      trackingUrl: input.trackingUrl ?? shipment.trackingPublicUrl ?? shipment.trackingUrl ?? null,
      status: PlatformTrackingSyncStatus.PENDING
    }
  });

  return serializePlatformTrackingSync(record);
}

export async function listTrackingSyncs(
  merchantId: string,
  query: ListPlatformTrackingSyncsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const where: Prisma.PlatformTrackingSyncWhereInput = {
    merchantId,
    ...(query.platform ? { platform: query.platform as StorePlatform } : {}),
    ...(query.status ? { status: query.status as PlatformTrackingSyncStatus } : {}),
    ...(query.connectionId ? { connectionId: query.connectionId } : {}),
    ...(query.shipmentId ? { shipmentId: query.shipmentId } : {})
  };
  const [syncs, total] = await Promise.all([
    client.platformTrackingSync.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.platformTrackingSync.count({ where })
  ]);

  return {
    tracking_syncs: syncs.map(serializePlatformTrackingSync),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function simulateTrackingSyncSuccess(
  merchantId: string,
  syncId: string,
  client: Db = prisma
) {
  const sync = await findTrackingSync(merchantId, syncId, client);
  const now = new Date();
  const updated = await client.platformTrackingSync.update({
    where: { id: sync.id },
    data: {
      status: PlatformTrackingSyncStatus.SYNCED,
      lastAttemptAt: now,
      syncedAt: now,
      errorMessage: null
    }
  });
  await client.platformConnection.update({
    where: { id: sync.connectionId },
    data: { lastTrackingSyncAt: now }
  });
  return serializePlatformTrackingSync(updated);
}

export async function simulateTrackingSyncFailure(
  merchantId: string,
  syncId: string,
  reason = "Tracking sync simulation failed.",
  client: Db = prisma
) {
  const sync = await findTrackingSync(merchantId, syncId, client);
  const updated = await client.platformTrackingSync.update({
    where: { id: sync.id },
    data: {
      status: PlatformTrackingSyncStatus.FAILED,
      lastAttemptAt: new Date(),
      errorMessage: reason
    }
  });
  return serializePlatformTrackingSync(updated);
}
