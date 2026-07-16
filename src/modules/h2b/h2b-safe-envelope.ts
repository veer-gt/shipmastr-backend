import { HttpError } from "../../lib/httpError.js";
import type { H2BProvider } from "./h2b.types.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function stringValue(value: unknown, max = 256): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new HttpError(400, "H2B_ENVELOPE_FIELD_TOO_LONG");
  return text;
}

function integerValue(value: unknown, max = 1_000_000_000): number | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > max) throw new HttpError(400, "H2B_ENVELOPE_NUMBER_INVALID");
  return numeric;
}

function firstString(source: RecordValue, fields: string[]) {
  for (const field of fields) {
    const value = stringValue(source[field]);
    if (value) return value;
  }
  return null;
}

function lineItems(source: RecordValue) {
  const raw = Array.isArray(source.line_items) ? source.line_items : Array.isArray(source.items) ? source.items : [];
  if (raw.length > 100) throw new HttpError(400, "H2B_ENVELOPE_LINE_ITEMS_TOO_LARGE");
  return raw.map((value) => {
    const item = record(value);
    return {
      externalProductId: firstString(item, ["product_id", "external_product_id"]),
      externalVariantId: firstString(item, ["variant_id", "external_variant_id"]),
      externalSku: firstString(item, ["sku", "external_sku"]),
      quantity: integerValue(item.quantity ?? item.qty ?? item.qty_ordered, 1_000_000) ?? 1
    };
  });
}

export function extractH2BSafeEnvelope(provider: H2BProvider, topic: string, payload: unknown) {
  const source = record(payload);
  const externalOrderId = firstString(source, provider === "MAGENTO"
    ? ["entity_id", "id", "increment_id"]
    : ["id", "order_id", "external_order_id"]);
  if (!externalOrderId) throw new HttpError(400, "H2B_EXTERNAL_ORDER_ID_REQUIRED");
  const total = source.total_price ?? source.total ?? source.grand_total ?? source.base_grand_total;
  const safeEnvelope = {
    schemaVersion: "h2b-admission-v1",
    provider,
    topic,
    externalOrderId,
    externalOrderName: firstString(source, ["name", "number", "increment_id", "order_number"]),
    providerEventTimestamp: firstString(source, ["updated_at", "updatedAt", "created_at", "createdAt"],),
    currency: firstString(source, ["currency", "currency_code"]),
    orderStatus: firstString(source, ["status", "state"]),
    paymentStatus: firstString(source, ["financial_status", "payment_status"]),
    fulfilmentStatus: firstString(source, ["fulfillment_status", "fulfilment_status"]),
    totalMinor: integerValue(total, Number.MAX_SAFE_INTEGER),
    lineItems: lineItems(source)
  };
  const encoded = JSON.stringify(safeEnvelope);
  if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new HttpError(400, "H2B_ENVELOPE_TOO_LARGE");
  return safeEnvelope;
}
