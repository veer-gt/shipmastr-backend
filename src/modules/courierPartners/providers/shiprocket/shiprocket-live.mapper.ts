import type {
  ProviderDraftOrderInput,
  ProviderDraftOrderResult,
  ProviderLabelResult,
  ProviderManifestResult,
  ProviderRateInput,
  ProviderRateResult
} from "../provider-adapter.types.js";
import type {
  ShiprocketAssignAwbResponse,
  ShiprocketCreateOrderRequest,
  ShiprocketCreateOrderResponse,
  ShiprocketGenerateLabelResponse,
  ShiprocketPickupListResponse,
  ShiprocketServiceabilityRequest,
  ShiprocketServiceabilityResponse
} from "./shiprocket-live.client.js";

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function dataObject(value: Record<string, unknown>) {
  return objectValue(value.data);
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[^\d.]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function safeMetadata(values: Record<string, unknown>) {
  return {
    provider_status: firstString(values.status, values.shipment_status, values.awb_assign_status) ?? null,
    provider_status_code: firstString(values.status_code, values.code) ?? null,
    has_label_url: Boolean(firstString(values.label_url, values.labelUrl, values.label))
  };
}

function positiveNumber(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInt(value: unknown, fallback: number) {
  const parsed = firstNumber(value);
  return parsed && parsed > 0 ? Math.max(1, Math.round(parsed)) : fallback;
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: name.trim(), lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1) ?? ""
  };
}

function productItems(input: ProviderDraftOrderInput) {
  const products = input.products?.length ? input.products : null;
  if (products) {
    return products.map((product, index) => ({
      name: product.name.trim() || input.sellerOrderId,
      sku: product.sku?.trim() || `${input.sellerOrderId}-${index + 1}`,
      units: Math.max(1, Math.round(positiveNumber(product.quantity, 1))),
      selling_price: positiveNumber(product.unitPrice, input.invoiceAmount)
    }));
  }

  return [{
    name: input.sellerOrderId,
    sku: input.sellerOrderId,
    units: 1,
    selling_price: input.invoiceAmount
  }];
}

export function mapProviderDraftToShiprocketOrder(input: ProviderDraftOrderInput): ShiprocketCreateOrderRequest {
  const paymentMethod = input.paymentMode === "cod" ? "COD" : "Prepaid";
  const buyerName = splitName(input.buyer.name);
  const collectableAmount = input.paymentMode === "cod"
    ? positiveNumber(input.collectableAmount, input.invoiceAmount)
    : 0;

  return {
    order_id: input.sellerOrderId,
    order_date: new Date().toISOString().slice(0, 19).replace("T", " "),
    pickup_location: input.pickupLocationProviderId,
    channel_id: "",
    billing_customer_name: buyerName.firstName,
    billing_last_name: buyerName.lastName,
    billing_address: input.buyer.addressLine1,
    billing_address_2: input.buyer.addressLine2 ?? "",
    billing_city: input.buyer.city,
    billing_pincode: input.buyer.pincode,
    billing_state: input.buyer.state,
    billing_country: input.buyer.country,
    billing_email: input.buyer.email ?? "support@shipmastr.com",
    billing_phone: input.buyer.phone,
    shipping_is_billing: true,
    order_items: productItems(input),
    payment_method: paymentMethod,
    shipping_charges: 0,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: 0,
    sub_total: input.invoiceAmount,
    collectable_amount: collectableAmount,
    length: input.dimensions.lengthCm,
    breadth: input.dimensions.breadthCm,
    height: input.dimensions.heightCm,
    weight: input.deadWeightKg
  };
}

export function mapProviderRateInputToShiprocketServiceability(input: ProviderRateInput): ShiprocketServiceabilityRequest {
  return {
    pickup_postcode: input.pickupPincode,
    delivery_postcode: input.deliveryPincode,
    weight: positiveNumber(input.deadWeightKg, 0.5),
    cod: input.paymentMode === "cod" ? 1 : 0,
    ...(input.collectableAmount !== undefined && input.collectableAmount !== null
      ? { declared_value: positiveNumber(input.collectableAmount, 0) }
      : {})
  };
}

function serviceabilityRows(response: ShiprocketServiceabilityResponse) {
  const data = dataObject(response);
  return [
    ...arrayValue(data.available_courier_companies),
    ...arrayValue(data.availableCourierCompanies),
    ...arrayValue(response.available_courier_companies),
    ...arrayValue(response.availableCourierCompanies),
    ...arrayValue(data.couriers),
    ...arrayValue(response.couriers)
  ];
}

function recommendedCourierId(response: ShiprocketServiceabilityResponse) {
  const data = dataObject(response);
  return firstString(
    data.recommended_courier_company_id,
    data.recommendedCourierCompanyId,
    response.recommended_courier_company_id,
    response.recommendedCourierCompanyId
  );
}

function truthyAvailability(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") return !["0", "false", "no", "n", "not available"].includes(value.trim().toLowerCase());
  return true;
}

function strictBool(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "active", "enabled", "verified", "approved"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "inactive", "disabled", "unverified", "pending", "rejected"].includes(normalized)) return false;
  }
  return null;
}

function safeStatusFlag(value: unknown) {
  const raw = firstString(value);
  if (!raw) return null;
  const safe = raw.replace(/[^a-zA-Z0-9 _.-]/g, "").trim().slice(0, 60);
  return safe || null;
}

function pickupRows(response: ShiprocketPickupListResponse) {
  const data = dataObject(response);
  return [
    ...arrayValue(response.data),
    ...arrayValue(data.pickup_addresses),
    ...arrayValue(data.pickupAddresses),
    ...arrayValue(data.pickup_locations),
    ...arrayValue(data.pickupLocations),
    ...arrayValue(data.shipping_address),
    ...arrayValue(data.shippingAddress),
    ...arrayValue(response.pickup_addresses),
    ...arrayValue(response.pickupAddresses),
    ...arrayValue(response.pickup_locations),
    ...arrayValue(response.pickupLocations),
    ...arrayValue(response.shipping_address),
    ...arrayValue(response.shippingAddress)
  ];
}

function idSuffix(value: string | null) {
  if (!value) return null;
  return value.length <= 4 ? value : value.slice(-4);
}

export type SafeShiprocketPickup = {
  providerPickupIdPresent: boolean;
  providerPickupIdSuffix: string | null;
  pickupName: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  active: boolean | null;
  verified: boolean | null;
  statusFlags: string[];
};

export function mapShiprocketPickupListToSafePickups(response: ShiprocketPickupListResponse): SafeShiprocketPickup[] {
  return pickupRows(response).map((row) => {
    const providerPickupId = firstString(
      row.id,
      row.pickup_id,
      row.pickupId,
      row.pickup_location_id,
      row.pickupLocationId,
      row.pickup_code,
      row.pickupCode
    );
    const pincode = firstString(row.pin_code, row.pincode, row.pickup_pincode, row.pickupPincode, row.postcode);
    const statusFlags = [
      safeStatusFlag(row.status),
      safeStatusFlag(row.pickup_status),
      safeStatusFlag(row.pickupStatus),
      safeStatusFlag(row.kyc_status),
      safeStatusFlag(row.kycStatus)
    ].filter((item): item is string => Boolean(item));
    return {
      providerPickupIdPresent: Boolean(providerPickupId),
      providerPickupIdSuffix: idSuffix(providerPickupId),
      pickupName: firstString(row.pickup_location, row.pickupLocation, row.name, row.company_name, row.companyName, row.warehouse_name, row.warehouseName),
      city: firstString(row.city, row.pickup_city, row.pickupCity),
      state: firstString(row.state, row.pickup_state, row.pickupState),
      pincode: pincode && /^[1-9][0-9]{5}$/.test(pincode) ? pincode : null,
      active: strictBool(row.is_active ?? row.isActive ?? row.active ?? row.status),
      verified: strictBool(row.is_verified ?? row.isVerified ?? row.verified ?? row.pickup_verified ?? row.pickupVerified ?? row.kyc_status ?? row.kycStatus),
      statusFlags: [...new Set(statusFlags)]
    };
  }).filter((pickup) => pickup.providerPickupIdPresent || pickup.pincode || pickup.pickupName);
}

type ShiprocketRateCandidate = {
  courierId: string;
  serviceId: string | null;
  rateId: string;
  amount: number;
  tatDays: number;
  chargedWeightKg: number;
  codSupported: boolean;
  pickupAvailable: boolean;
  deliveryAvailable: boolean;
  recommendationBoost: number;
};

function candidateFromRow(row: Record<string, unknown>, recommendedId: string | null, index: number): ShiprocketRateCandidate | null {
  const courierId = firstString(
    row.courier_company_id,
    row.courierCompanyId,
    row.courier_id,
    row.courierId,
    row.id
  );
  if (!courierId || !/^[0-9]+$/.test(courierId)) return null;

  const amount = firstNumber(
    row.rate,
    row.freight_charge,
    row.freightCharge,
    row.total_charges,
    row.totalCharges,
    row.shipping_charges,
    row.shippingCharges
  );
  if (!amount || amount <= 0) return null;

  const tatDays = positiveInt(row.estimated_delivery_days ?? row.estimatedDeliveryDays ?? row.etd ?? row.estimated_days, 3);
  const serviceId = firstString(row.service_id, row.serviceId, row.courier_service_id, row.courierServiceId);
  return {
    courierId,
    serviceId,
    rateId: firstString(row.rate_id, row.rateId, row.id) ?? `${courierId}-${index + 1}`,
    amount,
    tatDays,
    chargedWeightKg: positiveNumber(row.charge_weight ?? row.chargedWeight ?? row.weight, 0.5),
    codSupported: truthyAvailability(row.cod ?? row.cod_available ?? row.codAvailable ?? row.is_cod),
    pickupAvailable: truthyAvailability(row.pickup_availability ?? row.pickupAvailability),
    deliveryAvailable: truthyAvailability(row.delivery_availability ?? row.deliveryAvailability),
    recommendationBoost: recommendedId && courierId === recommendedId ? 1 : 0
  };
}

function chooseEconomy(candidates: ShiprocketRateCandidate[]) {
  return [...candidates].sort((left, right) => left.amount - right.amount || left.tatDays - right.tatDays)[0]!;
}

function chooseExpress(candidates: ShiprocketRateCandidate[]) {
  return [...candidates].sort((left, right) => left.tatDays - right.tatDays || left.amount - right.amount)[0]!;
}

function chooseSmart(candidates: ShiprocketRateCandidate[], economy: ShiprocketRateCandidate, express: ShiprocketRateCandidate) {
  const minAmount = Math.min(...candidates.map((item) => item.amount));
  const maxAmount = Math.max(...candidates.map((item) => item.amount));
  const minTat = Math.min(...candidates.map((item) => item.tatDays));
  const maxTat = Math.max(...candidates.map((item) => item.tatDays));
  const score = (item: ShiprocketRateCandidate) => {
    const costScore = maxAmount === minAmount ? 1 : 1 - ((item.amount - minAmount) / (maxAmount - minAmount));
    const speedScore = maxTat === minTat ? 1 : 1 - ((item.tatDays - minTat) / (maxTat - minTat));
    return costScore * 0.35 + speedScore * 0.45 + item.recommendationBoost * 0.2;
  };
  return [...candidates].sort((left, right) => score(right) - score(left) || left.tatDays - right.tatDays || left.amount - right.amount)[0]
    ?? express
    ?? economy;
}

function toProviderRate(candidate: ShiprocketRateCandidate, serviceLevel: ProviderRateResult["serviceLevel"]): ProviderRateResult {
  return {
    rateId: `${candidate.rateId}:${serviceLevel.toLowerCase().replace(/\s+/g, "_")}`,
    serviceLevel,
    courierNetwork: "Shipmastr Courier Network",
    totalCharge: candidate.amount,
    currency: "INR",
    tatDays: candidate.tatDays,
    chargedWeightKg: candidate.chargedWeightKg,
    codSupported: candidate.codSupported,
    pickupAvailable: candidate.pickupAvailable,
    deliveryAvailable: candidate.deliveryAvailable,
    reliabilityScore: candidate.recommendationBoost ? 0.9 : 0.8,
    providerCourierId: candidate.courierId,
    providerMetadata: {
      providerCourierId: candidate.courierId,
      providerServiceId: candidate.serviceId,
      providerRateId: candidate.rateId,
      providerStatus: "serviceable",
      rawProviderResponseStored: false
    }
  };
}

export function mapShiprocketServiceabilityToProviderRates(response: ShiprocketServiceabilityResponse): ProviderRateResult[] {
  const recommendedId = recommendedCourierId(response);
  const candidates = serviceabilityRows(response)
    .map((row, index) => candidateFromRow(row, recommendedId, index))
    .filter((item): item is ShiprocketRateCandidate => Boolean(item));

  if (!candidates.length) return [];

  const economy = chooseEconomy(candidates);
  const express = chooseExpress(candidates);
  const smart = chooseSmart(candidates, economy, express);

  return [
    toProviderRate(smart, "Shipmastr Smart"),
    toProviderRate(economy, "Shipmastr Economy"),
    toProviderRate(express, "Shipmastr Express")
  ];
}

export function mapShiprocketOrderToProviderDraft(response: ShiprocketCreateOrderResponse): ProviderDraftOrderResult {
  const data = dataObject(response);
  const providerShipmentId = firstString(
    data.shipment_id,
    data.shipmentId,
    response.shipment_id,
    response.shipmentId
  );
  const providerOrderId = firstString(data.order_id, data.orderId, response.order_id, response.orderId) ?? providerShipmentId;
  if (!providerShipmentId && !providerOrderId) {
    throw new Error("SHIPROCKET_INVALID_ORDER_RESPONSE");
  }
  return {
    providerOrderId: providerShipmentId ?? providerOrderId!,
    providerReferenceNumber: providerOrderId ?? providerShipmentId!,
    status: "draft",
    message: "Courier provider order prepared.",
    providerMetadata: safeMetadata({ ...response, ...data })
  };
}

export function mapShiprocketAwbToProviderManifest(response: ShiprocketAssignAwbResponse): ProviderManifestResult {
  const data = dataObject(response);
  const awb = firstString(
    data.awb_code,
    data.awb,
    data.awbCode,
    response.awb_code,
    response.awb,
    response.awbCode
  );
  const shipmentId = firstString(data.shipment_id, data.shipmentId, response.shipment_id, response.shipmentId);
  const orderId = firstString(data.order_id, data.orderId, response.order_id, response.orderId);
  if (!awb) throw new Error("SHIPROCKET_INVALID_AWB_RESPONSE");
  return {
    awb,
    trackingNumber: awb,
    providerAwb: awb,
    status: "manifested",
    providerReferenceNumber: shipmentId ?? orderId ?? awb,
    message: "Courier provider AWB assigned.",
    providerMetadata: safeMetadata({ ...response, ...data })
  };
}

export function mapShiprocketLabelToProviderLabel(response: ShiprocketGenerateLabelResponse): ProviderLabelResult {
  const data = dataObject(response);
  const labelUrl = firstString(
    data.label_url,
    data.labelUrl,
    data.label,
    response.label_url,
    response.labelUrl,
    response.label
  );
  return {
    labelUrl,
    status: "manifested",
    message: labelUrl ? "Courier provider label generated." : "Courier provider label is pending.",
    providerMetadata: safeMetadata({ ...response, ...data })
  };
}
