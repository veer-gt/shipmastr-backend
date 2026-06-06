import { SHIPMASTR_PUBLIC_COURIER_NETWORK } from "../../courier-partners.config.js";
import type {
  ProviderCancelResult,
  ProviderDraftOrderInput,
  ProviderDraftOrderResult,
  ProviderManifestResult,
  ProviderPickupLocationInput,
  ProviderPickupLocationResult,
  ProviderRateInput,
  ProviderRateResult,
  ProviderShipmentStatus,
  ProviderTrackingEvent,
  ProviderTrackingResult
} from "../provider-adapter.types.js";
import type {
  BigshipCancelOrderResponse,
  BigshipCourierRate,
  BigshipCourierRateResponse,
  BigshipDomesticB2COrderRequest,
  BigshipDomesticB2COrderResponse,
  BigshipPlaceOrderResponse,
  BigshipSaveWarehouseRequest,
  BigshipSaveWarehouseResponse,
  BigshipTrackingEvent,
  BigshipTrackingResponse
} from "./bigship.types.js";

type PublicProviderRate = Pick<
  ProviderRateResult,
  "serviceLevel" | "totalCharge" | "currency" | "tatDays" | "chargedWeightKg" | "courierNetwork"
>;

function finiteNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rateTotal(rate: BigshipCourierRate) {
  return finiteNumber(rate.total_charge ?? rate.totalCharge, 0);
}

function rateTat(rate: BigshipCourierRate) {
  return finiteNumber(rate.tat_days ?? rate.tat, 99);
}

function rateChargedWeight(rate: BigshipCourierRate) {
  return finiteNumber(rate.charged_weight ?? rate.chargedWeight, 0);
}

function rateCourierId(rate: BigshipCourierRate, index: number) {
  return nonEmptyString(rate.courierId ?? rate.courier_id) ?? `provider_courier_${index + 1}`;
}

function publicStatusFrom(status: ProviderShipmentStatus) {
  const labels: Record<ProviderShipmentStatus, string> = {
    draft: "Draft",
    rates_fetched: "Rates fetched",
    manifested: "Ready to ship",
    pickup_scheduled: "Pickup scheduled",
    picked_up: "Picked up",
    in_transit: "In transit",
    out_for_delivery: "Out for delivery",
    delivered: "Delivered",
    delivery_failed: "Delivery attempt failed",
    rto_initiated: "RTO initiated",
    rto_in_transit: "RTO in transit",
    rto_delivered: "RTO delivered",
    cancelled: "Cancelled",
    lost: "Exception",
    damaged: "Exception",
    exception: "Exception"
  };

  return labels[status];
}

function safeDate(value: string | undefined) {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function mapBigshipStatusToShipmentStatus(status: string | undefined): ProviderShipmentStatus {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, "_");

  if (!normalized) return "in_transit";
  if (normalized.includes("delivered") && normalized.includes("rto")) return "rto_delivered";
  if (normalized.includes("rto") && normalized.includes("transit")) return "rto_in_transit";
  if (normalized.includes("rto")) return "rto_initiated";
  if (normalized.includes("out_for_delivery") || normalized === "ofd") return "out_for_delivery";
  if (normalized.includes("delivered")) return "delivered";
  if (normalized.includes("picked") || normalized.includes("pickup_done")) return "picked_up";
  if (normalized.includes("pickup")) return "pickup_scheduled";
  if (normalized.includes("manifest") || normalized.includes("ready")) return "manifested";
  if (normalized.includes("cancel")) return "cancelled";
  if (normalized.includes("lost")) return "lost";
  if (normalized.includes("damage")) return "damaged";
  if (normalized.includes("failed") || normalized.includes("ndr")) return "delivery_failed";
  if (normalized.includes("exception")) return "exception";
  return "in_transit";
}

export function mapPickupLocationToBigship(input: ProviderPickupLocationInput): BigshipSaveWarehouseRequest {
  return {
    warehouseName: input.name,
    contactPerson: input.contactPerson,
    phone: input.phone,
    email: input.email ?? null,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2 ?? null,
    landmark: input.landmark ?? null,
    city: input.city,
    state: input.state,
    country: input.country,
    pincode: input.pincode,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null
  };
}

export function mapDomesticB2CShipmentToBigship(input: ProviderDraftOrderInput): BigshipDomesticB2COrderRequest {
  return {
    MasterCustomOrderId: input.sellerOrderId || input.shipmentId,
    MasterOrderPickUpLocation: input.pickupLocationProviderId,
    MasterOrderReturnLocation: input.returnLocationProviderId ?? input.pickupLocationProviderId,
    MasterOrderShippingName: input.buyer.name,
    MasterOrderShippingPhone: input.buyer.phone,
    MasterOrderShippingEmail: input.buyer.email ?? null,
    MasterOrderShippingAddressLine1: input.buyer.addressLine1,
    MasterOrderShippingAddressLine2: input.buyer.addressLine2 ?? null,
    MasterOrderShippingLandmark: input.buyer.landmark ?? null,
    MasterOrderShippingCity: input.buyer.city,
    MasterOrderShippingState: input.buyer.state,
    MasterOrderShippingCountry: input.buyer.country,
    MasterOrderShippingPincode: input.buyer.pincode,
    MasterOrderInvoiceNumber: input.invoiceNumber ?? null,
    MasterOrderInvoiceAmount: input.invoiceAmount,
    MasterOrderCollectableAmount: input.paymentMode === "cod" ? input.collectableAmount ?? input.invoiceAmount : 0,
    MasterOrderPaymentMode: input.paymentMode,
    MasterOrderWeightKg: input.deadWeightKg,
    MasterOrderLengthCm: input.dimensions.lengthCm,
    MasterOrderBreadthCm: input.dimensions.breadthCm,
    MasterOrderHeightCm: input.dimensions.heightCm
  };
}

export function mapBigshipPickupToProviderPickup(
  response: BigshipSaveWarehouseResponse
): ProviderPickupLocationResult {
  return {
    providerPickupId: nonEmptyString(response.warehouseId) ?? "mock_provider_pickup_001",
    status: String(response.status ?? "active").toLowerCase() === "failed" ? "failed" : "active",
    message: response.message ?? "Pickup location saved.",
    providerMetadata: {
      status: response.status ?? "active"
    }
  };
}

export function mapBigshipDraftOrderToProviderDraftOrder(
  response: BigshipDomesticB2COrderResponse
): ProviderDraftOrderResult {
  return {
    providerOrderId: nonEmptyString(response.order_id ?? response.orderId) ?? "mock_provider_order_001",
    providerReferenceNumber: nonEmptyString(response.reference_number) ?? "mock_provider_reference_001",
    status: mapBigshipStatusToShipmentStatus(response.status ?? "draft"),
    message: response.message ?? "Draft shipment created.",
    providerMetadata: {
      status: response.status ?? "draft"
    }
  };
}

function selectRateCandidates(rates: BigshipCourierRate[]) {
  const cheapest = [...rates].sort((left, right) => rateTotal(left) - rateTotal(right))[0];
  const fastest = [...rates].sort((left, right) => rateTat(left) - rateTat(right))[0];
  const recommended = rates.find((rate) => rate.recommended) ??
    rates.find((rate) => rate !== cheapest && rate !== fastest) ??
    cheapest ??
    fastest;

  return [
    ["Shipmastr Economy", cheapest],
    ["Shipmastr Express", fastest],
    ["Shipmastr Smart", recommended]
  ] as const;
}

export function mapBigshipRatesToProviderRates(response: BigshipCourierRateResponse): ProviderRateResult[] {
  const rawRates = response.rates ?? response.data ?? [];
  if (rawRates.length === 0) return [];

  const seen = new Set<string>();
  const providerRates: ProviderRateResult[] = [];

  for (const [serviceLevel, rawRate] of selectRateCandidates(rawRates)) {
    if (!rawRate || seen.has(serviceLevel)) continue;
    seen.add(serviceLevel);
    const index = rawRates.indexOf(rawRate);
    const providerCourierId = rateCourierId(rawRate, index);
    providerRates.push({
      rateId: `shipmastr_${serviceLevel.toLowerCase().replace(/[^a-z]+/g, "_")}`,
      serviceLevel,
      courierNetwork: SHIPMASTR_PUBLIC_COURIER_NETWORK.partnerName,
      totalCharge: rateTotal(rawRate),
      currency: "INR",
      tatDays: rateTat(rawRate),
      chargedWeightKg: rateChargedWeight(rawRate),
      providerCourierId,
      providerMetadata: {
        providerCourierId,
        courierName: rawRate.courierName ?? rawRate.courier_name ?? null,
        baseFreight: finiteNumber(rawRate.base_freight, 0),
        codCharge: finiteNumber(rawRate.cod_charge, 0),
        tax: finiteNumber(rawRate.tax, 0)
      }
    });
  }

  return providerRates;
}

export function serializeProviderRateForSeller(rate: ProviderRateResult): PublicProviderRate {
  return {
    serviceLevel: rate.serviceLevel,
    totalCharge: rate.totalCharge,
    currency: rate.currency,
    tatDays: rate.tatDays,
    chargedWeightKg: rate.chargedWeightKg,
    courierNetwork: rate.courierNetwork
  };
}

export function mapBigshipRateInputToRateRequest(input: ProviderRateInput) {
  return {
    order_id: input.providerOrderId ?? null,
    pickup_pincode: input.pickupPincode,
    delivery_pincode: input.deliveryPincode,
    payment_mode: input.paymentMode,
    collectable_amount: input.paymentMode === "cod" ? input.collectableAmount ?? 0 : 0,
    weight_kg: input.deadWeightKg,
    length_cm: input.dimensions.lengthCm,
    breadth_cm: input.dimensions.breadthCm,
    height_cm: input.dimensions.heightCm
  };
}

export function mapBigshipManifestToProviderManifest(
  response: BigshipPlaceOrderResponse
): ProviderManifestResult {
  const awb = nonEmptyString(response.awb_assigned ?? response.awb) ?? "mock_awb_001";
  const trackingNumber = nonEmptyString(response.tracking_number) ?? awb;
  const status = mapBigshipStatusToShipmentStatus(response.status ?? "manifested");
  const result: ProviderManifestResult = {
    awb,
    trackingNumber,
    status,
    providerReferenceNumber: nonEmptyString(response.reference_number) ?? "mock_provider_reference_001",
    message: response.message ?? "Shipment manifested.",
    providerMetadata: {
      status: response.status ?? "manifested"
    }
  };

  result.providerAwb = awb;
  return result;
}

function mapTrackingEvent(event: BigshipTrackingEvent): ProviderTrackingEvent {
  const status = mapBigshipStatusToShipmentStatus(event.status ?? event.public_status);
  return {
    status,
    publicStatus: event.public_status ?? publicStatusFrom(status),
    location: event.location ?? null,
    message: event.message ?? event.remarks ?? publicStatusFrom(status),
    checkpointTime: safeDate(event.checkpoint_time ?? event.timestamp)
  };
}

export function mapBigshipTrackingToProviderTracking(
  response: BigshipTrackingResponse
): ProviderTrackingResult {
  const events = (response.events ?? response.timeline ?? []).map(mapTrackingEvent);
  const status = mapBigshipStatusToShipmentStatus(response.status ?? events[0]?.status);

  return {
    awb: response.awb ?? null,
    trackingNumber: response.tracking_number ?? response.awb ?? null,
    status,
    publicStatus: publicStatusFrom(status),
    latestEvent: response.latest_event ?? events[0]?.message ?? response.message ?? null,
    events,
    providerMetadata: {
      eventCount: events.length
    }
  };
}

export function mapBigshipCancelToProviderCancel(response: BigshipCancelOrderResponse): ProviderCancelResult {
  const status = mapBigshipStatusToShipmentStatus(response.status ?? "cancelled");
  return {
    cancelled: response.cancelled ?? status === "cancelled",
    status,
    message: response.message ?? "Shipment cancellation requested.",
    providerMetadata: {
      status: response.status ?? "cancelled"
    }
  };
}
