import type { CourierEventType, Order, Prisma, WebhookEvent } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

function rate(part: number, total: number) {
  return total ? Number((part / total).toFixed(4)) : 0;
}

export function eventTypeFromCarrier(value: string): CourierEventType {
  const normalized = value.toLowerCase();
  if (normalized.includes("delivered")) return "DELIVERED";
  if (normalized.includes("ndr")) return "NDR";
  if (normalized.includes("rto")) return "RTO";
  if (normalized.includes("lost")) return "LOST";
  if (normalized.includes("out_for_delivery")) return "OUT_FOR_DELIVERY";
  if (normalized.includes("picked")) return "PICKED_UP";
  if (normalized.includes("pickup")) return "PICKUP_SCHEDULED";
  if (normalized.includes("cancel")) return "CANCELLED";
  return "IN_TRANSIT";
}

function score(deliveryRate: number, rtoRate: number, ndrRate: number) {
  return Math.max(0, Math.min(100, Math.round(50 + deliveryRate * 40 - rtoRate * 35 - ndrRate * 20)));
}

export function rankCourierOptions(options: Array<{
  courierId: string;
  priority: number;
  performanceScore?: number | null;
  deliveryRate?: number | null;
  rtoRate?: number | null;
  estimatedCost?: number | null;
}>) {
  return options
    .map((option) => {
      const performanceScore = option.performanceScore ?? 50;
      const deliveryBonus = Math.round((option.deliveryRate ?? 0.5) * 20);
      const rtoPenalty = Math.round((option.rtoRate ?? 0) * 30);
      const priorityBonus = Math.max(0, 10 - option.priority / 20);
      const costPenalty = option.estimatedCost ? Math.min(option.estimatedCost / 100, 8) : 4;
      return {
        ...option,
        score: Math.max(0, Math.min(100, Math.round(performanceScore + deliveryBonus + priorityBonus - rtoPenalty - costPenalty)))
      };
    })
    .sort((a, b) => b.score - a.score || (a.estimatedCost || 999999) - (b.estimatedCost || 999999));
}

async function resolveCourierId(payload: Prisma.JsonValue, client: Db) {
  const object = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Prisma.JsonObject : {};
  const courierId = typeof object.courierId === "string" ? object.courierId : "";
  if (courierId) return courierId;

  const courierCode = String(object.courierCode || object.carrierCode || object.carrier || "").trim();
  if (!courierCode) return null;

  const courier = await client.courierPartner.findFirst({
    where: { code: courierCode.toUpperCase() }
  });
  return courier?.id || null;
}

export async function updateCourierPerformanceFromWebhook(
  event: WebhookEvent & { order?: Order | null },
  client: Db = prisma
) {
  const courierId = await resolveCourierId(event.payload, client);
  const pincode = event.order?.pincode || (() => {
    const object = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Prisma.JsonObject : {};
    return String(object.pincode || object.toPincode || "");
  })();

  if (!courierId || !/^\d{6}$/.test(pincode)) return null;

  const courierEventType = eventTypeFromCarrier(event.eventType);
  const delivered = courierEventType === "DELIVERED";
  const ndr = courierEventType === "NDR";
  const rto = courierEventType === "RTO";
  const lost = courierEventType === "LOST";

  const performance = await client.courierPincodePerformance.upsert({
    where: { courierId_pincode: { courierId, pincode } },
    create: {
      courierId,
      pincode,
      totalShipments: 1,
      deliveredCount: delivered ? 1 : 0,
      ndrCount: ndr ? 1 : 0,
      rtoCount: rto ? 1 : 0,
      lostCount: lost ? 1 : 0
    },
    update: {
      totalShipments: { increment: 1 },
      ...(delivered ? { deliveredCount: { increment: 1 } } : {}),
      ...(ndr ? { ndrCount: { increment: 1 } } : {}),
      ...(rto ? { rtoCount: { increment: 1 } } : {}),
      ...(lost ? { lostCount: { increment: 1 } } : {})
    }
  });

  const deliveryRate = rate(performance.deliveredCount, performance.totalShipments);
  const rtoRate = rate(performance.rtoCount, performance.totalShipments);
  const ndrRate = rate(performance.ndrCount, performance.totalShipments);

  const updatedPerformance = await client.courierPincodePerformance.update({
    where: { id: performance.id },
    data: {
      deliveryRate,
      rtoRate,
      score: score(deliveryRate, rtoRate, ndrRate)
    }
  });

  const courierShipments = await client.courierShipment.findMany({ where: { courierId } });
  const shipmentCount = courierShipments.length || performance.totalShipments;
  const deliveredCount = courierShipments.filter((shipment) => shipment.status === "delivered").length + (delivered ? 1 : 0);
  const ndrCount = courierShipments.filter((shipment) => shipment.status === "ndr").length + (ndr ? 1 : 0);
  const rtoCount = courierShipments.filter((shipment) => shipment.status.startsWith("rto")).length + (rto ? 1 : 0);
  const lostCount = courierShipments.filter((shipment) => shipment.status === "lost").length + (lost ? 1 : 0);
  const cardDeliveryRate = rate(deliveredCount, shipmentCount);
  const cardRtoRate = rate(rtoCount, shipmentCount);

  await client.courierScorecard.upsert({
    where: { courierId },
    create: {
      courierId,
      shipmentCount,
      deliveredCount,
      ndrCount,
      rtoCount,
      lostCount,
      deliveryRate: cardDeliveryRate,
      rtoRate: cardRtoRate,
      score: score(cardDeliveryRate, cardRtoRate, rate(ndrCount, shipmentCount))
    },
    update: {
      shipmentCount,
      deliveredCount,
      ndrCount,
      rtoCount,
      lostCount,
      deliveryRate: cardDeliveryRate,
      rtoRate: cardRtoRate,
      score: score(cardDeliveryRate, cardRtoRate, rate(ndrCount, shipmentCount))
    }
  });

  await client.pincodeIntelligence.upsert({
    where: { pincode },
    create: {
      pincode,
      totalOrders: 1,
      deliveredOrders: delivered ? 1 : 0,
      ndrOrders: ndr ? 1 : 0,
      rtoOrders: rto ? 1 : 0
    },
    update: {
      totalOrders: { increment: 1 },
      ...(delivered ? { deliveredOrders: { increment: 1 } } : {}),
      ...(ndr ? { ndrOrders: { increment: 1 } } : {}),
      ...(rto ? { rtoOrders: { increment: 1 } } : {})
    }
  });

  return updatedPerformance;
}

export async function recommendCourierForOrder(orderId: string, client: Db = prisma) {
  const order = await client.order.findUniqueOrThrow({ where: { id: orderId } });
  const performances = await client.courierPincodePerformance.findMany({
    where: { pincode: order.pincode },
    orderBy: [{ score: "desc" }, { deliveryRate: "desc" }, { rtoRate: "asc" }]
  });

  const couriers = await client.courierPartner.findMany({
    where: { active: true },
    include: { rateCards: true }
  });

  const recommendations = couriers
    .map((courier) => {
      const perf = performances.find((item) => item.courierId === courier.id);
      const matchingRate = courier.rateCards.find((rateCard) => rateCard.minWeight <= (order.weightGrams || 500) && rateCard.maxWeight >= (order.weightGrams || 500));
      const cost = matchingRate
        ? matchingRate.baseRate + matchingRate.fuelSurcharge + (order.paymentMode === "COD" ? matchingRate.codFee : 0)
        : null;
      const baseScore = perf?.score ?? 50;
      const scoreValue = Math.max(0, Math.min(100, baseScore + Math.max(0, 10 - courier.priority / 20) - (cost ? Math.min(cost / 100, 8) : 4)));

      return {
        courier,
        perf,
        cost,
        score: Math.round(scoreValue),
        etaDays: matchingRate?.etaDays || null,
        reasons: [
          perf ? `Pincode score ${perf.score}` : "No pincode history yet",
          matchingRate ? `Rate card available` : "No matching rate card",
          `Priority ${courier.priority}`
        ]
      };
    })
    .sort((a, b) => b.score - a.score || (a.cost || 999999) - (b.cost || 999999));

  const best = recommendations[0];
  if (!best) return null;

  return client.courierRecommendation.create({
    data: {
      merchantId: order.merchantId,
      orderId: order.id,
      courierId: best.courier.id,
      pincode: order.pincode,
      score: best.score,
      estimatedCost: best.cost,
      estimatedEtaDays: best.etaDays,
      reasons: best.reasons,
      metadata: {
        courierName: best.courier.name,
        courierCode: best.courier.code
      }
    }
  });
}
