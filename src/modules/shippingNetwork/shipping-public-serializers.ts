import type { ShipmentStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { buildTrackingPublicUrl } from "./shipping-tracking-token.js";

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

export function trackingPublicUrlForShipment(shipment: {
  trackingToken?: string | null;
  trackingPublicUrl?: string | null;
  trackingUrl?: string | null;
  awbNumber?: string | null;
}) {
  return shipment.trackingPublicUrl
    ?? buildTrackingPublicUrl(shipment.trackingToken)
    ?? shipment.trackingUrl
    ?? trackingUrlForAwb(shipment.awbNumber);
}

export const terminalShipmentStatuses = new Set<string>([
  "delivered",
  "rto_delivered",
  "cancelled",
  "lost",
  "damaged"
]);

export const shipmentQueues = [
  "ready_to_ship",
  "needs_attention",
  "in_transit",
  "delivered",
  "rto_failed"
] as const;

export type ShipmentQueue = typeof shipmentQueues[number];

export type PublicAttentionReason = {
  code: string;
  label: string;
  message: string;
};

const inTransitStatuses = new Set<string>([
  "manifested",
  "pickup_scheduled",
  "picked_up",
  "in_transit",
  "out_for_delivery"
]);

const rtoFailedStatuses = new Set<string>([
  "rto_initiated",
  "rto_in_transit",
  "rto_delivered",
  "delivery_failed",
  "exception",
  "cancelled",
  "lost",
  "damaged"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nestedRecord(value: unknown, key: string) {
  if (!isRecord(value)) return {};
  const nested = value[key];
  return isRecord(nested) ? nested : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  const parsed = decimalToNumber(value);
  return parsed === null ? 0 : parsed;
}

function shipmentMetadataRecord(shipment: { metadata?: unknown }) {
  return isRecord(shipment.metadata) ? shipment.metadata : {};
}

function shipmentBuyer(shipment: { metadata?: unknown }) {
  return nestedRecord(shipmentMetadataRecord(shipment), "buyer");
}

function shipmentBuyerAddress(shipment: { metadata?: unknown }) {
  return nestedRecord(shipmentBuyer(shipment), "address");
}

function shipmentInvoice(shipment: { metadata?: unknown }) {
  return nestedRecord(shipmentMetadataRecord(shipment), "invoice");
}

function shipmentPhase6(shipment: { metadata?: unknown }) {
  return nestedRecord(shipmentMetadataRecord(shipment), "phase6");
}

function hasPositiveMoney(value: unknown) {
  return numberValue(value) > 0;
}

function attentionReason(code: string, label: string, message: string): PublicAttentionReason {
  return { code, label, message };
}

export type ShipmentAttentionSource = {
  status: ShipmentStatus | string;
  paymentMode?: string | null;
  pickupLocationId?: string | null;
  codAmountPaise?: number | null;
  declaredValuePaise?: number | null;
  deadWeightKg?: unknown;
  lengthCm?: unknown;
  breadthCm?: unknown;
  heightCm?: unknown;
  metadata?: unknown;
};

export function calculateAttentionReasons(shipment: ShipmentAttentionSource): PublicAttentionReason[] {
  const status = String(shipment.status);
  const buyer = shipmentBuyer(shipment);
  const address = shipmentBuyerAddress(shipment);
  const invoice = shipmentInvoice(shipment);
  const reasons: PublicAttentionReason[] = [];

  if (!shipment.pickupLocationId) {
    reasons.push(attentionReason(
      "missing_pickup_location",
      "Address Quality Check",
      "Pickup location is required before shipping."
    ));
  }

  if (!stringValue(buyer.phone)) {
    reasons.push(attentionReason(
      "missing_buyer_phone",
      "Address Quality Check",
      "Buyer phone is required before rate selection."
    ));
  }

  if (!stringValue(address.pincode)) {
    reasons.push(attentionReason(
      "missing_buyer_pincode",
      "Address Quality Check",
      "Buyer pincode is required for serviceability and rates."
    ));
  }

  if (!shipment.declaredValuePaise && !hasPositiveMoney(invoice.invoice_amount)) {
    reasons.push(attentionReason(
      "missing_invoice_amount",
      "Shipment Review",
      "Invoice amount is required before AWB generation."
    ));
  }

  if (String(shipment.paymentMode) === "cod" && !shipment.codAmountPaise && !hasPositiveMoney(invoice.collectable_amount)) {
    reasons.push(attentionReason(
      "missing_cod_collectable_amount",
      "COD Shield",
      "COD collectable amount is required for this shipment."
    ));
  }

  if (numberValue(shipment.deadWeightKg) <= 0) {
    reasons.push(attentionReason(
      "missing_package_weight",
      "Weight Guard",
      "Package weight is required for chargeable weight calculation."
    ));
  }

  if (numberValue(shipment.lengthCm) <= 0 || numberValue(shipment.breadthCm) <= 0 || numberValue(shipment.heightCm) <= 0) {
    reasons.push(attentionReason(
      "missing_package_dimensions",
      "Weight Guard",
      "Package dimensions are required for volumetric weight calculation."
    ));
  }

  if (status === "draft") {
    reasons.push(attentionReason(
      "no_rates_fetched",
      "Rates Pending",
      "Fetch Shipmastr Smart, Economy, and Express rates before AWB generation."
    ));
  }

  if (status === "cancelled") {
    reasons.push(attentionReason(
      "shipment_cancelled",
      "Shipment Review",
      "This shipment has been cancelled."
    ));
  }

  if (status === "delivery_failed" || status === "exception") {
    reasons.push(attentionReason(
      "shipment_failed",
      "Shipment Review",
      "This shipment needs review before the next action."
    ));
  }

  return reasons;
}

export function calculateShipmentQueue(shipment: ShipmentAttentionSource): ShipmentQueue {
  const status = String(shipment.status);

  if (status === "delivered") return "delivered";
  if (rtoFailedStatuses.has(status)) return "rto_failed";
  if (inTransitStatuses.has(status)) return "in_transit";

  return calculateAttentionReasons(shipment).length ? "needs_attention" : "ready_to_ship";
}

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
  trackingToken?: string | null;
  trackingPublicUrl?: string | null;
  serviceLevel?: string | null;
  deadWeightKg?: unknown;
  volumetricWeightKg?: unknown;
  chargeableWeightKg?: unknown;
  metadata?: unknown;
};

export function serializeShipment(shipment: PublicShipmentSource) {
  const awb = shipment.awbNumber ?? null;
  const phase6 = shipmentPhase6(shipment);
  const labelUrl = stringValue(phase6.labelUrl) || null;
  const selectedTier = stringValue(phase6.selectedTier) || null;

  return {
    shipment_id: shipment.id,
    seller_order_id: shipment.externalOrderId ?? null,
    status: String(shipment.status),
    segment: shipment.segment,
    payment_mode: shipment.paymentMode,
    awb,
    tracking_number: awb,
    tracking_url: trackingPublicUrlForShipment(shipment),
    tracking_public_url: trackingPublicUrlForShipment(shipment),
    label_url: labelUrl,
    courier_network: PUBLIC_COURIER_NETWORK,
    service_level: shipment.serviceLevel ?? null,
    selected_tier: selectedTier,
    weight: {
      dead_weight_kg: decimalToNumber(shipment.deadWeightKg),
      volumetric_weight_kg: decimalToNumber(shipment.volumetricWeightKg),
      chargeable_weight_kg: decimalToNumber(shipment.chargeableWeightKg)
    }
  };
}

export type PublicShipmentListSource = PublicShipmentSource & ShipmentAttentionSource & {
  orderId?: string | null;
  pickupLocationId?: string | null;
  codAmountPaise?: number | null;
  declaredValuePaise?: number | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  metadata?: unknown;
};

export function serializeShipmentListItem(shipment: PublicShipmentListSource) {
  const buyer = shipmentBuyer(shipment);
  const address = shipmentBuyerAddress(shipment);
  const phase6 = shipmentPhase6(shipment);
  const awb = shipment.awbNumber ?? null;
  const attention = calculateAttentionReasons(shipment);

  return {
    shipment_id: shipment.id,
    seller_order_id: shipment.externalOrderId ?? null,
    order_id: shipment.orderId ?? null,
    status: String(shipment.status),
    queue: calculateShipmentQueue(shipment),
    payment_mode: shipment.paymentMode,
    buyer: {
      name: stringValue(buyer.name) || null,
      phone: stringValue(buyer.phone) || null,
      pincode: stringValue(address.pincode) || null,
      city: stringValue(address.city) || null,
      state: stringValue(address.state) || null
    },
    pickup_location_id: shipment.pickupLocationId ?? null,
    awb,
    tracking_number: awb,
    tracking_url: trackingPublicUrlForShipment(shipment),
    tracking_public_url: trackingPublicUrlForShipment(shipment),
    label_url: stringValue(phase6.labelUrl) || null,
    courier_network: PUBLIC_COURIER_NETWORK,
    service_level: shipment.serviceLevel ?? null,
    selected_tier: stringValue(phase6.selectedTier) || null,
    invoice_amount: shipment.declaredValuePaise ? paiseToMoney(shipment.declaredValuePaise) : null,
    collectable_amount: shipment.codAmountPaise ? paiseToMoney(shipment.codAmountPaise) : 0,
    weight: {
      dead_weight_kg: decimalToNumber(shipment.deadWeightKg),
      volumetric_weight_kg: decimalToNumber(shipment.volumetricWeightKg),
      chargeable_weight_kg: decimalToNumber(shipment.chargeableWeightKg)
    },
    created_at: shipment.createdAt ?? null,
    updated_at: shipment.updatedAt ?? null,
    attention
  };
}

export function serializeShipmentList(input: {
  shipments: PublicShipmentListSource[];
  page: number;
  perPage: number;
  total: number;
}) {
  return {
    shipments: input.shipments.map(serializeShipmentListItem),
    pagination: {
      page: input.page,
      per_page: input.perPage,
      total: input.total,
      has_more: input.page * input.perPage < input.total
    }
  };
}

export function serializeOrderShipmentBridgeResult(shipment: PublicShipmentListSource) {
  const item = serializeShipmentListItem(shipment);

  return {
    shipment_id: item.shipment_id,
    order_id: item.order_id,
    seller_order_id: item.seller_order_id,
    status: item.status,
    segment: shipment.segment,
    payment_mode: item.payment_mode,
    pickup_location_id: item.pickup_location_id,
    attention: item.attention
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
