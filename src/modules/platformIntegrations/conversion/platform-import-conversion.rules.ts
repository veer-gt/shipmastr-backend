import type { OrderStatus } from "@prisma/client";
import { sanitizeImportPreview } from "../importQueue/platform-import-queue.serializers.js";
import {
  reconciliationStatusForItem,
  reconciliationWarnings
} from "../reconciliation/platform-import-reconciliation.serializer.js";
import type {
  PlatformImportConversionQueue,
  PlatformImportConversionReasonCode
} from "./platform-import-conversion.types.js";

export type ConversionImportItem = {
  id: string;
  jobId: string;
  connectionId: string;
  merchantId: string;
  platform: string;
  externalOrderId?: string | null;
  externalOrderName?: string | null;
  status: string;
  orderImportId?: string | null;
  normalizedOrderId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  mappingWarnings?: unknown;
  safePayloadPreview?: unknown;
};

export type ConversionSafeOrderFields = {
  externalOrderId: string | null;
  displayOrderName: string | null;
  buyerName: string;
  city: string;
  state: string;
  pincode: string | null;
  country: string | null;
  orderValue: number;
  codAmount: number;
  paymentMode: "COD" | "PREPAID";
  itemCount: number;
  productDescription: string | null;
  packageWeight: number | null;
};

export type ConversionEligibility = {
  eligible: boolean;
  reconciliationStatus: ReturnType<typeof reconciliationStatusForItem>;
  queue: PlatformImportConversionQueue | null;
  reasonCodes: PlatformImportConversionReasonCode[];
  warnings: string[];
  fields: ConversionSafeOrderFields;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intValue(value: unknown) {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.max(0, Math.round(parsed));
}

function safePayload(item: ConversionImportItem) {
  return asRecord(sanitizeImportPreview(item.safePayloadPreview));
}

function destinationFromPreview(preview: Record<string, unknown>) {
  return asRecord(preview.destination ?? preview.delivery ?? preview.shipping_address);
}

function buyerFromPreview(preview: Record<string, unknown>) {
  return asRecord(preview.buyerPreview ?? preview.buyer_preview ?? preview.buyer);
}

function lineItemsFromPreview(preview: Record<string, unknown>) {
  return asArray(preview.lineItemPreview ?? preview.line_item_preview ?? preview.line_items ?? preview.items);
}

function firstProductName(preview: Record<string, unknown>) {
  const first = asRecord(lineItemsFromPreview(preview)[0]);
  return stringValue(first.name);
}

function firstWeightGrams(preview: Record<string, unknown>) {
  const fromPreview = intValue(preview.dead_weight_grams ?? preview.weight_grams ?? preview.package_weight_grams);
  if (fromPreview) return fromPreview;
  for (const lineItem of lineItemsFromPreview(preview)) {
    const weight = intValue(asRecord(lineItem).weightGrams ?? asRecord(lineItem).weight_grams);
    if (weight) return weight;
  }
  return null;
}

function itemCountFromPreview(preview: Record<string, unknown>) {
  const lineItems = lineItemsFromPreview(preview);
  const fromPreview = intValue(preview.item_count ?? preview.itemCount);
  if (fromPreview && fromPreview > 0) return fromPreview;
  return lineItems.length;
}

function orderAmountFromPreview(preview: Record<string, unknown>) {
  const paise = intValue(preview.order_amount_paise ?? preview.total_amount_paise);
  if (paise !== null) return Math.max(0, Math.round(paise / 100));
  const amount = numberValue(preview.totalAmount ?? preview.total_amount ?? preview.order_amount);
  return Math.max(0, Math.round(amount ?? 0));
}

function codDetected(preview: Record<string, unknown>) {
  if (typeof preview.codDetected === "boolean") return preview.codDetected;
  if (typeof preview.cod_detected === "boolean") return preview.cod_detected;
  return String(preview.payment_mode || "").toUpperCase() === "COD";
}

export function safeOrderFieldsFromImportItem(item: ConversionImportItem): ConversionSafeOrderFields {
  const preview = safePayload(item);
  const buyer = buyerFromPreview(preview);
  const destination = destinationFromPreview(preview);
  const orderValue = orderAmountFromPreview(preview);
  const paymentMode = codDetected(preview) ? "COD" : "PREPAID";
  const itemCount = itemCountFromPreview(preview);

  return {
    externalOrderId: item.externalOrderId ?? stringValue(preview.external_order_id ?? preview.externalOrderId),
    displayOrderName: item.externalOrderName ?? stringValue(preview.external_order_name ?? preview.externalOrderName),
    buyerName: stringValue(buyer.name) ?? "Platform buyer pending review",
    city: stringValue(destination.city ?? buyer.city) ?? "Pending city",
    state: stringValue(destination.state ?? buyer.state) ?? "Pending state",
    pincode: stringValue(destination.postal_code ?? destination.postalCode ?? destination.pincode ?? buyer.pincode),
    country: stringValue(destination.country ?? buyer.country),
    orderValue,
    codAmount: paymentMode === "COD" ? orderValue : 0,
    paymentMode,
    itemCount,
    productDescription: firstProductName(preview) ?? (itemCount > 1 ? "Imported platform items" : "Imported platform item"),
    packageWeight: firstWeightGrams(preview)
  };
}

export function platformOrderExternalId(item: ConversionImportItem) {
  const fields = safeOrderFieldsFromImportItem(item);
  if (!fields.externalOrderId) return null;
  return `platform-import:${item.connectionId}:${fields.externalOrderId}`;
}

export function evaluatePlatformImportConversionEligibility(
  item: ConversionImportItem,
  existingConversion?: { orderId?: string | null } | null
): ConversionEligibility {
  const reconciliationStatus = reconciliationStatusForItem(item);
  const fields = safeOrderFieldsFromImportItem(item);
  const warnings = reconciliationWarnings(item);
  const reasonCodes: PlatformImportConversionReasonCode[] = [];

  if (existingConversion?.orderId || item.normalizedOrderId) reasonCodes.push("ALREADY_CONVERTED");
  if (!fields.externalOrderId) reasonCodes.push("MISSING_EXTERNAL_ORDER_ID");
  if (!fields.pincode) reasonCodes.push("MISSING_SHIPPING_PINCODE");
  if (!fields.country) reasonCodes.push("MISSING_COUNTRY");
  if (!fields.itemCount || fields.itemCount <= 0) reasonCodes.push("MISSING_LINE_ITEMS");

  if (reconciliationStatus === "FAILED") reasonCodes.push("ITEM_FAILED");
  if (reconciliationStatus === "DUPLICATE") reasonCodes.push("ITEM_DUPLICATE");
  if (reconciliationStatus === "IGNORED") reasonCodes.push("ITEM_IGNORED");
  if (reconciliationStatus === "NEEDS_REVIEW") reasonCodes.push("ITEM_NEEDS_REVIEW");

  const blocked = reasonCodes.some((code) => [
    "ALREADY_CONVERTED",
    "MISSING_EXTERNAL_ORDER_ID",
    "MISSING_SHIPPING_PINCODE",
    "MISSING_COUNTRY",
    "MISSING_LINE_ITEMS",
    "ITEM_FAILED",
    "ITEM_DUPLICATE",
    "ITEM_IGNORED",
    "ITEM_NEEDS_REVIEW"
  ].includes(code));

  const queue = !blocked && reconciliationStatus === "READY" ? "READY_TO_SHIP" : !blocked ? "NEEDS_ATTENTION" : null;
  return {
    eligible: !blocked,
    reconciliationStatus,
    queue,
    reasonCodes: Array.from(new Set(reasonCodes)),
    warnings,
    fields
  };
}

export function queueFromOrderStatus(status: OrderStatus | string): PlatformImportConversionQueue {
  return String(status) === "READY_TO_SHIP" ? "READY_TO_SHIP" : "NEEDS_ATTENTION";
}
