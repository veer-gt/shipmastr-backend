import type { ShipmentStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";

export const PUBLIC_COURIER_NETWORK = "Shipmastr Courier Network" as const;

export const PUBLIC_SERVICE_LEVELS = {
  smart: "Shipmastr Smart",
  economy: "Shipmastr Economy",
  express: "Shipmastr Express"
} as const;

export type PublicEnvelope<T> = {
  success: true;
  message: string;
  data: T;
  error: null;
};

export function successEnvelope<T>(message: string, data: T): PublicEnvelope<T> {
  return {
    success: true,
    message,
    data,
    error: null
  };
}

export function decimalToNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function moneyToPaise(value: number) {
  return Math.round(value * 100);
}

export function paiseToMoney(value: number) {
  return Math.round(value) / 100;
}

export function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

export function serviceCodeForName(serviceName: string) {
  const normalized = serviceName.toLowerCase();
  if (normalized.includes("economy")) return "shipmastr_economy";
  if (normalized.includes("express")) return "shipmastr_express";
  return "shipmastr_smart";
}

export function trackingUrlForAwb(awb: string | null | undefined) {
  return awb ? `/tracking/?awb=${encodeURIComponent(awb)}` : null;
}

export const terminalShipmentStatuses = new Set<string>([
  "delivered",
  "rto_delivered",
  "cancelled",
  "lost",
  "damaged"
]);

export type PublicPickupLocationSource = {
  id: string;
  label: string;
  status: string;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  country: string;
  createdAt?: Date | string;
};

export function serializePickupLocation(location: PublicPickupLocationSource) {
  return {
    pickup_location_id: location.id,
    name: location.label,
    status: location.status,
    city: location.city ?? null,
    state: location.state ?? null,
    pincode: location.pincode ?? null,
    country: location.country,
    courier_network: PUBLIC_COURIER_NETWORK
  };
}

export type PublicShipmentSource = {
  id: string;
  externalOrderId?: string | null;
  status: ShipmentStatus | string;
  segment: string;
  paymentMode: string;
  awbNumber?: string | null;
  trackingUrl?: string | null;
  serviceLevel?: string | null;
  deadWeightKg?: unknown;
  volumetricWeightKg?: unknown;
  chargeableWeightKg?: unknown;
};

export function serializeShipment(shipment: PublicShipmentSource) {
  const awb = shipment.awbNumber ?? null;
  return {
    shipment_id: shipment.id,
    seller_order_id: shipment.externalOrderId ?? null,
    status: String(shipment.status),
    segment: shipment.segment,
    payment_mode: shipment.paymentMode,
    awb,
    tracking_number: awb,
    tracking_url: shipment.trackingUrl ?? trackingUrlForAwb(awb),
    courier_network: PUBLIC_COURIER_NETWORK,
    service_level: shipment.serviceLevel ?? null,
    weight: {
      dead_weight_kg: decimalToNumber(shipment.deadWeightKg),
      volumetric_weight_kg: decimalToNumber(shipment.volumetricWeightKg),
      chargeable_weight_kg: decimalToNumber(shipment.chargeableWeightKg)
    }
  };
}

export type PublicRateSource = {
  id: string;
  publicServiceName: string;
  chargeableWeightKg?: unknown;
  amountPaise: number;
  currency: string;
  estimatedDeliveryDays?: number | null;
};

export function serializeRate(rate: PublicRateSource) {
  return {
    rate_id: rate.id,
    courier_network: PUBLIC_COURIER_NETWORK,
    service_level: rate.publicServiceName,
    charged_weight_kg: decimalToNumber(rate.chargeableWeightKg),
    total_charge: paiseToMoney(rate.amountPaise),
    currency: rate.currency,
    estimated_tat_days: rate.estimatedDeliveryDays ?? null
  };
}

export type PublicTrackingEventSource = {
  status: ShipmentStatus | string;
  eventLabel: string;
  publicMessage?: string | null;
  location?: string | null;
  occurredAt: Date | string;
};

export function serializeTrackingEvent(event: PublicTrackingEventSource) {
  return {
    status: String(event.status),
    label: event.eventLabel,
    message: event.publicMessage ?? event.eventLabel,
    location: event.location ?? null,
    occurred_at: event.occurredAt
  };
}
