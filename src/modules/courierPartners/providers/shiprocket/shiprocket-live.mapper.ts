import type {
  ProviderDraftOrderInput,
  ProviderDraftOrderResult,
  ProviderLabelResult,
  ProviderManifestResult
} from "../provider-adapter.types.js";
import type {
  ShiprocketAssignAwbResponse,
  ShiprocketCreateOrderRequest,
  ShiprocketCreateOrderResponse,
  ShiprocketGenerateLabelResponse
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

function dataObject(value: Record<string, unknown>) {
  return objectValue(value.data);
}

function safeMetadata(values: Record<string, unknown>) {
  return {
    provider_status: firstString(values.status, values.shipment_status, values.awb_assign_status) ?? null,
    provider_status_code: firstString(values.status_code, values.code) ?? null,
    has_label_url: Boolean(firstString(values.label_url, values.labelUrl, values.label))
  };
}

function productItems(input: ProviderDraftOrderInput) {
  const metadataProducts = objectValue(input as unknown);
  void metadataProducts;
  return [{
    name: input.sellerOrderId,
    sku: input.sellerOrderId,
    units: 1,
    selling_price: input.invoiceAmount
  }];
}

export function mapProviderDraftToShiprocketOrder(input: ProviderDraftOrderInput): ShiprocketCreateOrderRequest {
  const paymentMethod = input.paymentMode === "cod" ? "COD" : "Prepaid";
  return {
    order_id: input.sellerOrderId,
    order_date: new Date().toISOString().slice(0, 19).replace("T", " "),
    pickup_location: input.pickupLocationProviderId,
    channel_id: "",
    billing_customer_name: input.buyer.name,
    billing_last_name: "",
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
    length: input.dimensions.lengthCm,
    breadth: input.dimensions.breadthCm,
    height: input.dimensions.heightCm,
    weight: input.deadWeightKg
  };
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
