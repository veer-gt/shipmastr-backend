import {
  PlatformTrackingSyncStatus,
  StorePlatform,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { serializeMagentoShippingSync } from "./magento.serializers.js";
import { getMagentoConnectionRecord } from "./magento-connection.service.js";
import type {
  ListMagentoRecordsQueryInput,
  MagentoShippingSyncInput
} from "./magento.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

async function findMagentoSync(merchantId: string, syncId: string, client: Db) {
  const sync = await client.platformTrackingSync.findFirst({
    where: { id: syncId, merchantId, platform: StorePlatform.MAGENTO }
  });
  if (!sync) throw new HttpError(404, "MAGENTO_SHIPPING_SYNC_NOT_FOUND");
  return sync;
}

export async function createMagentoShippingSyncFoundation(
  merchantId: string,
  connectionId: string,
  input: MagentoShippingSyncInput,
  client: Db = prisma
) {
  const { connection } = await getMagentoConnectionRecord(merchantId, connectionId, client);
  const shipment = await client.shipment.findFirst({
    where: { id: input.shipmentId, sellerId: merchantId }
  });
  if (!shipment) throw new HttpError(404, "SHIPMENT_NOT_FOUND");

  const record = await client.platformTrackingSync.create({
    data: {
      connectionId: connection.id,
      merchantId,
      shipmentId: shipment.id,
      platform: StorePlatform.MAGENTO,
      externalOrderId: input.externalOrderId ?? input.incrementId ?? shipment.externalOrderId ?? null,
      trackingNumber: input.trackingNumber ?? shipment.awbNumber ?? null,
      trackingUrl: input.trackingUrl ?? shipment.trackingPublicUrl ?? shipment.trackingUrl ?? null,
      status: PlatformTrackingSyncStatus.PENDING
    }
  });

  return serializeMagentoShippingSync(record);
}

export async function listMagentoShippingSyncs(
  merchantId: string,
  connectionId: string,
  query: ListMagentoRecordsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const { connection } = await getMagentoConnectionRecord(merchantId, connectionId, client);
  const where: Prisma.PlatformTrackingSyncWhereInput = {
    merchantId,
    connectionId: connection.id,
    platform: StorePlatform.MAGENTO,
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
    shipping_syncs: syncs.map(serializeMagentoShippingSync),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function simulateMagentoShippingSyncSuccess(
  merchantId: string,
  syncId: string,
  client: Db = prisma
) {
  const sync = await findMagentoSync(merchantId, syncId, client);
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
  await client.magentoConnectionState.update({
    where: { connectionId: sync.connectionId },
    data: { lastShippingSyncAttemptAt: now }
  });
  return serializeMagentoShippingSync(updated);
}

export async function simulateMagentoShippingSyncFailure(
  merchantId: string,
  syncId: string,
  reason = "Magento shipping sync simulation failed.",
  client: Db = prisma
) {
  const sync = await findMagentoSync(merchantId, syncId, client);
  const now = new Date();
  const updated = await client.platformTrackingSync.update({
    where: { id: sync.id },
    data: {
      status: PlatformTrackingSyncStatus.FAILED,
      lastAttemptAt: now,
      errorMessage: reason
    }
  });
  await client.magentoConnectionState.update({
    where: { connectionId: sync.connectionId },
    data: { lastShippingSyncAttemptAt: now }
  });
  return serializeMagentoShippingSync(updated);
}
