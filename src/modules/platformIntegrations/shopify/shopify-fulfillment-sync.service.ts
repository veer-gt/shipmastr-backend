import {
  PlatformTrackingSyncStatus,
  StorePlatform,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { serializeShopifyFulfillmentSync } from "./shopify.serializers.js";
import { getShopifyConnectionRecord } from "./shopify-connection.service.js";
import type {
  ListShopifyRecordsQueryInput,
  ShopifyFulfillmentSyncInput
} from "./shopify.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

async function findShopifySync(merchantId: string, syncId: string, client: Db) {
  const sync = await client.platformTrackingSync.findFirst({
    where: { id: syncId, merchantId, platform: StorePlatform.SHOPIFY }
  });
  if (!sync) throw new HttpError(404, "SHOPIFY_FULFILLMENT_SYNC_NOT_FOUND");
  return sync;
}

export async function createShopifyFulfillmentSyncFoundation(
  merchantId: string,
  connectionId: string,
  input: ShopifyFulfillmentSyncInput,
  client: Db = prisma
) {
  const { connection } = await getShopifyConnectionRecord(merchantId, connectionId, client);
  const shipment = await client.shipment.findFirst({
    where: { id: input.shipmentId, sellerId: merchantId }
  });
  if (!shipment) throw new HttpError(404, "SHIPMENT_NOT_FOUND");

  const record = await client.platformTrackingSync.create({
    data: {
      connectionId: connection.id,
      merchantId,
      shipmentId: shipment.id,
      platform: StorePlatform.SHOPIFY,
      externalOrderId: input.externalOrderId ?? shipment.externalOrderId ?? null,
      trackingNumber: input.trackingNumber ?? shipment.awbNumber ?? null,
      trackingUrl: input.trackingUrl ?? shipment.trackingPublicUrl ?? shipment.trackingUrl ?? null,
      status: PlatformTrackingSyncStatus.PENDING
    }
  });

  return serializeShopifyFulfillmentSync(record);
}

export async function listShopifyFulfillmentSyncs(
  merchantId: string,
  connectionId: string,
  query: ListShopifyRecordsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const { connection } = await getShopifyConnectionRecord(merchantId, connectionId, client);
  const where: Prisma.PlatformTrackingSyncWhereInput = {
    merchantId,
    connectionId: connection.id,
    platform: StorePlatform.SHOPIFY,
    ...(query.status ? { status: query.status as PlatformTrackingSyncStatus } : {})
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
    fulfillment_syncs: syncs.map(serializeShopifyFulfillmentSync),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function simulateShopifyFulfillmentSyncSuccess(
  merchantId: string,
  syncId: string,
  client: Db = prisma
) {
  const sync = await findShopifySync(merchantId, syncId, client);
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
  await client.shopifyConnectionState.update({
    where: { connectionId: sync.connectionId },
    data: { lastFulfillmentSyncAttemptAt: now }
  });
  return serializeShopifyFulfillmentSync(updated);
}

export async function simulateShopifyFulfillmentSyncFailure(
  merchantId: string,
  syncId: string,
  reason = "Shopify fulfillment sync simulation failed.",
  client: Db = prisma
) {
  const sync = await findShopifySync(merchantId, syncId, client);
  const now = new Date();
  const updated = await client.platformTrackingSync.update({
    where: { id: sync.id },
    data: {
      status: PlatformTrackingSyncStatus.FAILED,
      lastAttemptAt: now,
      errorMessage: reason
    }
  });
  await client.shopifyConnectionState.update({
    where: { connectionId: sync.connectionId },
    data: { lastFulfillmentSyncAttemptAt: now }
  });
  return serializeShopifyFulfillmentSync(updated);
}
