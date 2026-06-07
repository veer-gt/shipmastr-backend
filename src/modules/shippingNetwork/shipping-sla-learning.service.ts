import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { toPrismaJson } from "./shipping-public-serializers.js";
import type { ShippingTier } from "./shipping-tier-decision.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type SlaEventType =
  | "awb_assigned"
  | "label_generated"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "rto"
  | "failed"
  | "delayed";

export type SlaEventInput = {
  merchantId: string;
  shipmentId: string;
  orderId?: string | null;
  provider?: string | null;
  courierCode?: string | null;
  courierName?: string | null;
  serviceType?: string | null;
  selectedTier?: ShippingTier | string | null;
  pickupPincode?: string | null;
  deliveryPincode?: string | null;
  eventType: SlaEventType;
  eventAt?: Date;
  metadata?: Record<string, unknown> | null;
};

export type SlaStatQuery = {
  provider?: string;
  courierCode?: string;
  deliveryPincode?: string;
  selectedTier?: string;
};

function clampScore(value: number) {
  return Math.max(0, Math.min(1, value));
}

function keyPart(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function statKey(input: {
  provider?: string | null;
  courierCode?: string | null;
  serviceType?: string | null;
  selectedTier?: string | null;
  pickupPincode?: string | null;
  deliveryPincode?: string | null;
}) {
  return [
    keyPart(input.provider),
    keyPart(input.courierCode),
    keyPart(input.serviceType),
    keyPart(input.selectedTier),
    keyPart(input.pickupPincode),
    keyPart(input.deliveryPincode)
  ].join("|");
}

function statWhere(parts: ReturnType<typeof parseStatKey>) {
  return {
    provider: parts.provider || null,
    courierCode: parts.courierCode || null,
    serviceType: parts.serviceType || null,
    selectedTier: parts.selectedTier || null,
    pickupPincode: parts.pickupPincode || null,
    deliveryPincode: parts.deliveryPincode || null
  };
}

function parseStatKey(key: string) {
  const [provider, courierCode, serviceType, selectedTier, pickupPincode, deliveryPincode] = key.split("|");
  return {
    provider,
    courierCode,
    serviceType,
    selectedTier,
    pickupPincode,
    deliveryPincode
  };
}

export function calculateReliabilityScore(input: {
  totalShipments: number;
  deliveredCount: number;
  rtoCount: number;
  failedCount: number;
}) {
  if (input.totalShipments <= 0) return 0.75;
  const deliveredRate = input.deliveredCount / input.totalShipments;
  const nonFailureRate = (input.totalShipments - input.failedCount - input.rtoCount) / input.totalShipments;
  return clampScore(deliveredRate * 0.7 + nonFailureRate * 0.3);
}

export async function recordSlaEvent(input: SlaEventInput, client: Db = prisma) {
  return client.courierSlaEvent.create({
    data: {
      merchantId: input.merchantId,
      shipmentId: input.shipmentId,
      orderId: input.orderId ?? null,
      provider: input.provider ?? null,
      courierCode: input.courierCode ?? null,
      courierName: input.courierName ?? null,
      serviceType: input.serviceType ?? null,
      selectedTier: input.selectedTier ?? null,
      pickupPincode: input.pickupPincode ?? null,
      deliveryPincode: input.deliveryPincode ?? null,
      eventType: input.eventType,
      eventAt: input.eventAt ?? new Date(),
      metadataJson: toPrismaJson(input.metadata ?? null)
    }
  });
}

export async function recalculateCourierSlaStats(
  filters: SlaStatQuery = {},
  client: Db = prisma
) {
  const events = await client.courierSlaEvent.findMany({
    where: {
      ...(filters.provider ? { provider: filters.provider } : {}),
      ...(filters.courierCode ? { courierCode: filters.courierCode } : {}),
      ...(filters.deliveryPincode ? { deliveryPincode: filters.deliveryPincode } : {}),
      ...(filters.selectedTier ? { selectedTier: filters.selectedTier } : {})
    }
  });
  const groups = new Map<string, {
    shipments: Set<string>;
    delivered: Set<string>;
    rto: Set<string>;
    failed: Set<string>;
  }>();

  for (const event of events) {
    const key = statKey(event);
    const group = groups.get(key) ?? {
      shipments: new Set<string>(),
      delivered: new Set<string>(),
      rto: new Set<string>(),
      failed: new Set<string>()
    };
    group.shipments.add(event.shipmentId);
    if (event.eventType === "delivered") group.delivered.add(event.shipmentId);
    if (event.eventType === "rto") group.rto.add(event.shipmentId);
    if (event.eventType === "failed" || event.eventType === "delayed") group.failed.add(event.shipmentId);
    groups.set(key, group);
  }

  const now = new Date();
  const stats = [];
  for (const [key, group] of groups) {
    const parts = parseStatKey(key);
    const totalShipments = group.shipments.size;
    const deliveredCount = group.delivered.size;
    const rtoCount = group.rto.size;
    const failedCount = group.failed.size;
    const reliabilityScore = calculateReliabilityScore({
      totalShipments,
      deliveredCount,
      rtoCount,
      failedCount
    });
    const existing = await client.courierSlaStat.findFirst({
      where: statWhere(parts)
    });
    const data = {
      ...statWhere(parts),
      totalShipments,
      deliveredCount,
      rtoCount,
      failedCount,
      avgDeliveryDays: null,
      reliabilityScore,
      lastCalculatedAt: now
    };

    stats.push(existing
      ? await client.courierSlaStat.update({ where: { id: existing.id }, data })
      : await client.courierSlaStat.create({ data }));
  }

  return stats.map(serializeSlaStat);
}

export async function getCourierSlaStats(query: SlaStatQuery = {}, client: Db = prisma) {
  const stats = await client.courierSlaStat.findMany({
    where: {
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.courierCode ? { courierCode: query.courierCode } : {}),
      ...(query.deliveryPincode ? { deliveryPincode: query.deliveryPincode } : {}),
      ...(query.selectedTier ? { selectedTier: query.selectedTier } : {})
    },
    orderBy: { totalShipments: "desc" },
    take: 50
  });

  return {
    stats: stats.map(serializeSlaStat)
  };
}

export function serializeSlaStat(stat: {
  provider?: string | null;
  courierCode?: string | null;
  courierName?: string | null;
  serviceType?: string | null;
  selectedTier?: string | null;
  pickupPincode?: string | null;
  deliveryPincode?: string | null;
  totalShipments: number;
  deliveredCount: number;
  rtoCount: number;
  failedCount: number;
  avgDeliveryDays?: number | null;
  reliabilityScore?: number | null;
}) {
  return {
    provider: stat.provider ?? null,
    courierCode: stat.courierCode ?? null,
    courierName: stat.courierName ?? null,
    serviceType: stat.serviceType ?? null,
    selectedTier: stat.selectedTier ?? null,
    pickupPincode: stat.pickupPincode ?? null,
    deliveryPincode: stat.deliveryPincode ?? null,
    totalShipments: stat.totalShipments,
    deliveredCount: stat.deliveredCount,
    rtoCount: stat.rtoCount,
    failedCount: stat.failedCount,
    avgDeliveryDays: stat.avgDeliveryDays ?? null,
    reliabilityScore: stat.reliabilityScore ?? 0.75
  };
}

export async function getReliabilityScoreForRate(input: {
  provider?: string | null;
  courierCode?: string | null;
  deliveryPincode?: string | null;
  selectedTier?: string | null;
}, client: Db = prisma) {
  const stat = await client.courierSlaStat.findFirst({
    where: {
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.courierCode ? { courierCode: input.courierCode } : {}),
      ...(input.deliveryPincode ? { deliveryPincode: input.deliveryPincode } : {}),
      ...(input.selectedTier ? { selectedTier: input.selectedTier } : {})
    },
    orderBy: { totalShipments: "desc" }
  });

  if (!stat || stat.totalShipments <= 0 || typeof stat.reliabilityScore !== "number") return 0.75;
  return clampScore(stat.reliabilityScore);
}
