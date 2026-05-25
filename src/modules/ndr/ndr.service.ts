import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";

const MAX_NDR_ACTION_ITEMS = 100;
const NDR_SLA_MS = 24 * 60 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

type NdrRecord = {
  id: string;
  merchantId: string;
  orderId: string | null;
  courierId: string | null;
  pincode: string | null;
  reason: string;
  actionRequired: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
};

type OrderRecord = {
  id: string;
  merchantId: string;
  externalOrderId: string;
  pincode: string;
  city: string;
  state: string;
  status: string;
  shipmentDetails: {
    awb: string | null;
    trackingNumber: string | null;
    courierId: string | null;
    pincode: string;
    city: string | null;
    state: string | null;
    shipmentStatus: string;
    ndrStatus: string | null;
    firstAttemptAt: Date | null;
    estimatedDeliveryDate: Date | null;
  } | null;
};

type NdrDataClient = {
  ndrEvent: {
    findMany(args: unknown): Promise<NdrRecord[]>;
    findFirst(args: unknown): Promise<NdrRecord | null>;
    update(args: unknown): Promise<NdrRecord>;
  };
  order: {
    findMany(args: unknown): Promise<OrderRecord[]>;
  };
};

export type NdrResolutionInput = {
  preferredAction: "reattempt" | "reschedule" | "hold" | "return_to_origin";
  preferredSlot?: string;
  note?: string;
  attempted?: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeRecord(value: Prisma.JsonValue | null): JsonRecord {
  return isRecord(value) ? value : {};
}

function nestedRecord(parent: JsonRecord, key: string): JsonRecord {
  return isRecord(parent[key]) ? parent[key] as JsonRecord : {};
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeDateString(value: unknown): string | null {
  const date = typeof value === "string" || value instanceof Date ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function formatReason(reason: string) {
  return reason
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusFromMetadata(metadata: JsonRecord, order?: OrderRecord) {
  const resolution = nestedRecord(metadata, "resolution");
  return (
    safeString(resolution.status) ||
    safeString(metadata.status) ||
    safeString(order?.shipmentDetails?.ndrStatus) ||
    "open"
  );
}

function isResolved(status: string) {
  return ["resolved", "closed", "rto", "returned"].includes(status.toLowerCase());
}

function isInProgress(status: string) {
  return ["in_progress", "buyer_contacted", "reattempt_scheduled", "rescheduled"].includes(status.toLowerCase());
}

function actionCenterItem(event: NdrRecord, order: OrderRecord | undefined, now: Date) {
  const metadata = safeRecord(event.metadata);
  const shipment = order?.shipmentDetails ?? null;
  const latestAttempt = nestedRecord(metadata, "latestAttempt");
  const consumerResponse = nestedRecord(metadata, "consumerResponse");
  const resolution = nestedRecord(metadata, "resolution");
  const status = statusFromMetadata(metadata, order);
  const explicitSlaDueAt = safeDateString(metadata.slaDueAt);
  const slaDueAt = explicitSlaDueAt ?? new Date(event.createdAt.getTime() + NDR_SLA_MS).toISOString();
  const breached = !isResolved(status) && now.getTime() > new Date(slaDueAt).getTime();
  const fraudSignal = safeString(metadata.fraudSignal) || safeString(metadata.fakeAttemptSignal) || "none";
  const nextAction = safeString(resolution.preferredAction) || safeString(metadata.nextAction) || event.actionRequired || "review";

  return {
    id: event.id,
    orderId: event.orderId,
    externalOrderId: order?.externalOrderId ?? null,
    reason: event.actionRequired || formatReason(event.reason),
    status,
    nextAction,
    slaDueAt,
    slaBreached: breached,
    fraudSignal,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    shipment: {
      awbNumber: shipment?.awb || safeString(metadata.awb) || safeString(metadata.awbNumber) || null,
      trackingNumber: shipment?.trackingNumber || safeString(metadata.trackingNumber) || null,
      carrier: safeString(metadata.courierName) || event.courierId || shipment?.courierId || "Assigned courier",
      toPincode: shipment?.pincode || event.pincode || order?.pincode || null,
      city: shipment?.city || order?.city || null,
      state: shipment?.state || order?.state || null,
      shipmentStatus: shipment?.shipmentStatus || order?.status || null
    },
    latestAttempt: {
      note: safeString(latestAttempt.note) || safeString(metadata.latestAttemptNote) || null,
      at: safeDateString(latestAttempt.at) || safeDateString(metadata.latestAttemptAt)
    },
    consumerResponse: {
      preferredAction: safeString(consumerResponse.preferredAction) || safeString(resolution.preferredAction) || null,
      preferredSlot: safeString(consumerResponse.preferredSlot) || safeString(resolution.preferredSlot) || null
    }
  };
}

export async function getNdrActionCenter(
  merchantId: string,
  client: NdrDataClient = prisma as unknown as NdrDataClient,
  now = new Date()
) {
  const records = await client.ndrEvent.findMany({
    where: { merchantId },
    orderBy: { createdAt: "desc" },
    take: MAX_NDR_ACTION_ITEMS
  });
  const scopedRecords = records.filter((record) => record.merchantId === merchantId);
  const orderIds = Array.from(new Set(scopedRecords.map((record) => record.orderId).filter(Boolean))) as string[];
  const orders = orderIds.length
    ? await client.order.findMany({
      where: { merchantId, id: { in: orderIds } },
      select: {
        id: true,
        merchantId: true,
        externalOrderId: true,
        pincode: true,
        city: true,
        state: true,
        status: true,
        shipmentDetails: {
          select: {
            awb: true,
            trackingNumber: true,
            courierId: true,
            pincode: true,
            city: true,
            state: true,
            shipmentStatus: true,
            ndrStatus: true,
            firstAttemptAt: true,
            estimatedDeliveryDate: true
          }
        }
      }
    })
    : [];
  const orderMap = new Map(orders.filter((order) => order.merchantId === merchantId).map((order) => [order.id, order]));
  const items = scopedRecords.map((record) => actionCenterItem(record, record.orderId ? orderMap.get(record.orderId) : undefined, now));
  const summary = {
    open: items.filter((item) => !isResolved(item.status) && !isInProgress(item.status)).length,
    inProgress: items.filter((item) => isInProgress(item.status)).length,
    awaitingBuyerAction: items.filter((item) => item.nextAction === "review" || item.consumerResponse.preferredAction === null).length,
    resolved: items.filter((item) => isResolved(item.status)).length,
    slaBreached: items.filter((item) => item.slaBreached).length,
    fakeAttemptSignals: items.filter((item) => item.fraudSignal && item.fraudSignal !== "none").length
  };

  return {
    summary,
    items,
    events: items,
    count: items.length
  };
}

export async function resolveNdrEvent(
  merchantId: string,
  id: string,
  input: NdrResolutionInput,
  client: NdrDataClient = prisma as unknown as NdrDataClient
) {
  const record = await client.ndrEvent.findFirst({
    where: { id, merchantId }
  });

  if (!record) {
    throw new HttpError(404, "NDR_EVENT_NOT_FOUND");
  }

  const metadata = safeRecord(record.metadata);
  const resolution = {
    preferredAction: input.preferredAction,
    preferredSlot: input.preferredSlot || null,
    note: input.note || null,
    attempted: input.attempted !== false,
    status: "in_progress",
    updatedAt: new Date().toISOString()
  };

  return client.ndrEvent.update({
    where: { id: record.id },
    data: {
      actionRequired: input.preferredAction,
      metadata: {
        ...metadata,
        resolution
      }
    }
  });
}

export async function resolveNdrEvents(
  merchantId: string,
  ids: string[],
  input: NdrResolutionInput,
  client: NdrDataClient = prisma as unknown as NdrDataClient
) {
  const uniqueIds = Array.from(new Set(ids));
  const results = await Promise.all(uniqueIds.map((id) => resolveNdrEvent(merchantId, id, input, client)));
  return {
    updated: results.length
  };
}
