import {
  PlatformTrackingSyncStatus,
  StorePlatform,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { serializeWooCommerceTrackingSync } from "./woocommerce.serializers.js";
import { getWooCommerceConnectionRecord } from "./woocommerce-connection.service.js";
import type {
  ListWooCommerceRecordsQueryInput,
  WooCommerceTrackingSyncInput
} from "./woocommerce.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

async function findWooCommerceSync(merchantId: string, syncId: string, client: Db) {
  const sync = await client.platformTrackingSync.findFirst({
    where: { id: syncId, merchantId, platform: StorePlatform.WOOCOMMERCE }
  });
  if (!sync) throw new HttpError(404, "WOOCOMMERCE_TRACKING_SYNC_NOT_FOUND");
  return sync;
}

export async function createWooCommerceTrackingSyncFoundation(
  merchantId: string,
  connectionId: string,
  input: WooCommerceTrackingSyncInput,
  client: Db = prisma
) {
  const { connection } = await getWooCommerceConnectionRecord(merchantId, connectionId, client);
  const shipment = await client.shipment.findFirst({
    where: { id: input.shipmentId, sellerId: merchantId }
  });
  if (!shipment) throw new HttpError(404, "SHIPMENT_NOT_FOUND");

  const record = await client.platformTrackingSync.create({
    data: {
      connectionId: connection.id,
      merchantId,
      shipmentId: shipment.id,
      platform: StorePlatform.WOOCOMMERCE,
      externalOrderId: input.externalOrderId ?? shipment.externalOrderId ?? null,
      trackingNumber: input.trackingNumber ?? shipment.awbNumber ?? null,
      trackingUrl: input.trackingUrl ?? shipment.trackingPublicUrl ?? shipment.trackingUrl ?? null,
      status: PlatformTrackingSyncStatus.PENDING
    }
  });

  return serializeWooCommerceTrackingSync(record);
}

export async function listWooCommerceTrackingSyncs(
  merchantId: string,
  connectionId: string,
  query: ListWooCommerceRecordsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const { connection } = await getWooCommerceConnectionRecord(merchantId, connectionId, client);
  const where: Prisma.PlatformTrackingSyncWhereInput = {
    merchantId,
    connectionId: connection.id,
    platform: StorePlatform.WOOCOMMERCE,
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
    tracking_syncs: syncs.map(serializeWooCommerceTrackingSync),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function simulateWooCommerceTrackingSyncSuccess(
  merchantId: string,
  syncId: string,
  client: Db = prisma
) {
  const sync = await findWooCommerceSync(merchantId, syncId, client);
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
  await client.wooCommerceConnectionState.update({
    where: { connectionId: sync.connectionId },
    data: { lastTrackingSyncAttemptAt: now }
  });
  return serializeWooCommerceTrackingSync(updated);
}

export async function simulateWooCommerceTrackingSyncFailure(
  merchantId: string,
  syncId: string,
  reason = "WooCommerce tracking sync simulation failed.",
  client: Db = prisma
) {
  const sync = await findWooCommerceSync(merchantId, syncId, client);
  const now = new Date();
  const updated = await client.platformTrackingSync.update({
    where: { id: sync.id },
    data: {
      status: PlatformTrackingSyncStatus.FAILED,
      lastAttemptAt: now,
      errorMessage: reason
    }
  });
  await client.wooCommerceConnectionState.update({
    where: { connectionId: sync.connectionId },
    data: { lastTrackingSyncAttemptAt: now }
  });
  return serializeWooCommerceTrackingSync(updated);
}
