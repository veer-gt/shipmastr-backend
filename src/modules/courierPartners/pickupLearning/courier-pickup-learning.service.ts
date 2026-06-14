import { Prisma } from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { getSellerShipment } from "../../shippingNetwork/shipping-shipments.service.js";
import type {
  CourierPickupLearningClassification,
  CourierPickupLearningObservation,
  CourierPickupLearningProviderSummary,
  CourierPickupLearningRecommendation,
  CourierPickupLearningStatus
} from "./courier-pickup-learning.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

type ShipmentLike = {
  id?: string | null;
  pickupLocationId?: string | null;
  fromPincode?: string | null;
  toPincode?: string | null;
};

type RateRecord = {
  id: string;
  shipmentId?: string | null;
  sellerId: string;
  publicServiceCode?: string | null;
  publicServiceName?: string | null;
  amountPaise?: number | null;
  rateBreakup?: unknown;
  createdAt?: Date | string | null;
  shipment?: ShipmentLike | null;
};

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function boolValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function isoDate(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

function phase6Metadata(rate: RateRecord) {
  return metadataObject(metadataObject(rate.rateBreakup).phase6);
}

function rootMetadata(rate: RateRecord) {
  return metadataObject(rate.rateBreakup);
}

function safePublicServiceCode(rate: RateRecord) {
  if (rate.publicServiceCode === "shipmastr_smart" || rate.publicServiceCode === "shipmastr_economy" || rate.publicServiceCode === "shipmastr_express") {
    return rate.publicServiceCode;
  }
  const name = String(rate.publicServiceName ?? "").toLowerCase();
  if (name.includes("economy")) return "shipmastr_economy";
  if (name.includes("express")) return "shipmastr_express";
  if (name.includes("smart")) return "shipmastr_smart";
  return null;
}

function numericProviderCourierId(value: unknown) {
  const normalized = stringValue(value);
  return normalized && /^[0-9]+$/.test(normalized) ? normalized : null;
}

function providerCourierId(rate: RateRecord) {
  const phase6 = phase6Metadata(rate);
  const root = rootMetadata(rate);
  const result = metadataObject(root.result);
  return numericProviderCourierId(phase6.providerCourierId)
    ?? numericProviderCourierId(root.providerCourierId)
    ?? numericProviderCourierId(root.internalCourierId)
    ?? numericProviderCourierId(result.providerCourierId)
    ?? numericProviderCourierId(result.courier_id)
    ?? numericProviderCourierId(result.courierId);
}

function providerCourierIdSuffix(id: string | null) {
  if (!id) return null;
  return id.slice(-3).padStart(Math.min(3, id.length), "*");
}

function pickupLocationId(rate: RateRecord) {
  const phase6 = phase6Metadata(rate);
  const root = rootMetadata(rate);
  return stringValue(phase6.trialPickupLocationId)
    ?? stringValue(phase6.pickupLocationId)
    ?? stringValue(root.trialPickupLocationId)
    ?? stringValue(root.pickupLocationId)
    ?? rate.shipment?.pickupLocationId
    ?? null;
}

function pickupPincode(rate: RateRecord) {
  const phase6 = phase6Metadata(rate);
  const root = rootMetadata(rate);
  return stringValue(phase6.pickupPincode)
    ?? stringValue(root.pickupPincode)
    ?? stringValue(rate.shipment?.fromPincode);
}

function deliveryPincode(rate: RateRecord) {
  const phase6 = phase6Metadata(rate);
  const root = rootMetadata(rate);
  return stringValue(phase6.deliveryPincode)
    ?? stringValue(root.deliveryPincode)
    ?? stringValue(rate.shipment?.toPincode);
}

function observationFromRate(providerKey: string, rate: RateRecord): CourierPickupLearningObservation | null {
  const phase6 = phase6Metadata(rate);
  const pickup = pickupPincode(rate);
  if (!pickup) return null;
  const courierId = providerCourierId(rate);
  const pickupAvailable = boolValue(phase6.pickupAvailable);
  const deliveryAvailable = boolValue(phase6.deliveryAvailable);
  const amount = numberValue(rate.amountPaise);
  const eligible = pickupAvailable !== false
    && deliveryAvailable !== false
    && Boolean(courierId)
    && (amount === null || amount > 0);
  return {
    provider_key: providerKey,
    pickup_location_id: pickupLocationId(rate),
    pickup_pincode: pickup,
    delivery_pincode: deliveryPincode(rate),
    public_service_code: safePublicServiceCode(rate),
    internal_courier_id_present: Boolean(courierId),
    provider_courier_id_suffix: providerCourierIdSuffix(courierId),
    live_mode: stringValue(phase6.livePilotRatesMode) === "LIVE",
    live_ready: phase6.livePilotRatesReady === true,
    pickup_available: pickupAvailable,
    delivery_available: deliveryAvailable,
    eligible_rate_count: eligible ? 1 : 0,
    candidate_rate_count: 1,
    observed_at: isoDate(rate.createdAt)
  };
}

function statusFor(input: {
  observationCount: number;
  pickupAvailableCount: number;
  pickupUnavailableCount: number;
  availabilityScore: number;
}): CourierPickupLearningStatus {
  if (!input.observationCount) return "UNKNOWN";
  if (input.pickupUnavailableCount > 0 && input.pickupAvailableCount === 0) return "UNAVAILABLE";
  if (input.availabilityScore >= 0.8) return "HEALTHY";
  if (input.availabilityScore > 0) return "DEGRADED";
  return "UNKNOWN";
}

function recommendationFor(status: CourierPickupLearningStatus): CourierPickupLearningRecommendation {
  if (status === "HEALTHY") return "USE_PICKUP";
  if (status === "DEGRADED") return "RUN_RATE_REFRESH";
  if (status === "UNAVAILABLE") return "TRY_ALTERNATE_PICKUP";
  return "RUN_RATE_REFRESH";
}

export function classifyPickupLearning(
  providerKey: string,
  observations: CourierPickupLearningObservation[],
  fallback: { pickupPincode?: string | null; deliveryPincode?: string | null } = {}
): CourierPickupLearningClassification {
  const pickupAvailableCount = observations.filter((item) => item.pickup_available === true).length;
  const pickupUnavailableCount = observations.filter((item) => item.pickup_available === false).length;
  const knownPickupCount = pickupAvailableCount + pickupUnavailableCount;
  const availabilityScore = knownPickupCount ? Math.round((pickupAvailableCount / knownPickupCount) * 100) / 100 : 0;
  const status = statusFor({
    observationCount: observations.length,
    pickupAvailableCount,
    pickupUnavailableCount,
    availabilityScore
  });
  const observedAtValues = observations
    .map((item) => item.observed_at)
    .sort();
  const latestObservedAt = observedAtValues.length ? observedAtValues[observedAtValues.length - 1]! : null;
  return {
    provider_key: providerKey,
    pickup_pincode: observations[0]?.pickup_pincode ?? fallback.pickupPincode ?? null,
    delivery_pincode: observations[0]?.delivery_pincode ?? fallback.deliveryPincode ?? null,
    status,
    availability_score: availabilityScore,
    observation_count: observations.length,
    pickup_available_count: pickupAvailableCount,
    pickup_unavailable_count: pickupUnavailableCount,
    delivery_available_count: observations.filter((item) => item.delivery_available !== false).length,
    latest_observed_at: latestObservedAt,
    recommendation: recommendationFor(status)
  };
}

function providerSummary(providerKey: string, observations: CourierPickupLearningObservation[]): CourierPickupLearningProviderSummary {
  const byPickup = new Map<string, CourierPickupLearningObservation[]>();
  for (const observation of observations) {
    const key = observation.pickup_pincode;
    byPickup.set(key, [...(byPickup.get(key) ?? []), observation]);
  }
  const pickups = [...byPickup.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, rows]) => classifyPickupLearning(providerKey, rows));
  const aggregate = classifyPickupLearning(providerKey, observations);
  return {
    provider_key: providerKey,
    status: aggregate.status,
    availability_score: aggregate.availability_score,
    observation_count: aggregate.observation_count,
    pickup_count: pickups.length,
    unavailable_pickup_count: pickups.filter((pickup) => pickup.status === "UNAVAILABLE").length,
    latest_observed_at: aggregate.latest_observed_at,
    recommendation: aggregate.recommendation,
    pickups
  };
}

async function rateRows(input: {
  merchantId: string;
  client: Db;
  shipmentId?: string;
  limit: number;
}) {
  return input.client.shipmentRate.findMany({
    where: {
      sellerId: input.merchantId,
      ...(input.shipmentId ? { shipmentId: input.shipmentId } : {})
    },
    orderBy: { createdAt: "desc" },
    take: input.limit,
    include: {
      shipment: {
        select: {
          id: true,
          pickupLocationId: true,
          fromPincode: true,
          toPincode: true
        }
      }
    }
  }) as Promise<RateRecord[]>;
}

export async function listCourierPickupLearningProviders(
  merchantId: string,
  options: { client?: Db; limit?: number } = {}
) {
  const client = options.client ?? prisma;
  const observations = (await rateRows({
    merchantId,
    client,
    limit: options.limit ?? 100
  }))
    .map((rate) => observationFromRate("SHIPROCKET", rate))
    .filter((item): item is CourierPickupLearningObservation => Boolean(item));
  return {
    providers: [providerSummary("SHIPROCKET", observations)]
  };
}

export async function getCourierPickupLearningProvider(
  merchantId: string,
  providerKey: "SHIPROCKET" | string,
  options: { client?: Db; limit?: number } = {}
) {
  if (providerKey !== "SHIPROCKET") throw new HttpError(400, "PICKUP_LEARNING_UNSUPPORTED_PROVIDER");
  const { providers } = await listCourierPickupLearningProviders(merchantId, options);
  return providers[0]!;
}

export async function getCourierPickupLearningForPickup(
  merchantId: string,
  providerKey: "SHIPROCKET" | string,
  pickupPincode: string,
  options: { client?: Db; deliveryPincode?: string; limit?: number } = {}
) {
  if (providerKey !== "SHIPROCKET") throw new HttpError(400, "PICKUP_LEARNING_UNSUPPORTED_PROVIDER");
  const client = options.client ?? prisma;
  const observations = (await rateRows({
    merchantId,
    client,
    limit: options.limit ?? 100
  }))
    .map((rate) => observationFromRate(providerKey, rate))
    .filter((item): item is CourierPickupLearningObservation => Boolean(item))
    .filter((item) => item.pickup_pincode === pickupPincode)
    .filter((item) => !options.deliveryPincode || item.delivery_pincode === options.deliveryPincode);
  return classifyPickupLearning(providerKey, observations, {
    pickupPincode,
    deliveryPincode: options.deliveryPincode ?? null
  });
}

export async function getCourierPickupLearningForShipment(
  merchantId: string,
  providerKey: "SHIPROCKET" | string,
  shipmentId: string,
  options: { client?: Db; limit?: number } = {}
) {
  if (providerKey !== "SHIPROCKET") throw new HttpError(400, "PICKUP_LEARNING_UNSUPPORTED_PROVIDER");
  const client = options.client ?? prisma;
  const shipment = await getSellerShipment(merchantId, shipmentId, client);
  const rows = await rateRows({
    merchantId,
    client,
    shipmentId,
    limit: options.limit ?? 100
  });
  const observations = rows
    .map((rate) => observationFromRate(providerKey, {
      ...rate,
      shipment: rate.shipment ?? {
        id: shipment.id,
        pickupLocationId: shipment.pickupLocationId,
        fromPincode: shipment.fromPincode,
        toPincode: shipment.toPincode
      }
    }))
    .filter((item): item is CourierPickupLearningObservation => Boolean(item));
  return classifyPickupLearning(providerKey, observations, {
    pickupPincode: shipment.fromPincode,
    deliveryPincode: shipment.toPincode
  });
}
