import { HttpError } from "../../lib/httpError.js";
import { decimalMajorToMinor, type H2BProvider } from "./h2b.types.js";

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

function boundedStructure(value: unknown, depth = 0, scalars = { count: 0 }): void {
  if (depth > 10) throw new HttpError(400, "H2B_JSON_DEPTH_TOO_LARGE");
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      if (value.length > 100) throw new HttpError(400, "H2B_ENVELOPE_ARRAY_TOO_LARGE");
      for (const item of value) boundedStructure(item, depth + 1, scalars);
    } else {
      for (const item of Object.values(value as Record<string, unknown>)) boundedStructure(item, depth + 1, scalars);
    }
    return;
  }
  scalars.count += 1;
  if (scalars.count > 1000) throw new HttpError(400, "H2B_JSON_SCALAR_COUNT_TOO_LARGE");
  if (typeof value === "string" && value.length > 2048) throw new HttpError(400, "H2B_ENVELOPE_FIELD_TOO_LONG");
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
  boundedStructure(payload);
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
    totalMinor: total === undefined || total === null || total === ""
      ? null
      : (() => {
        try {
          return decimalMajorToMinor(total, firstString(source, ["currency", "currency_code"]) ?? "");
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : "H2B_TOTAL_INVALID");
        }
      })(),
    lineItems: lineItems(source)
  };
  const encoded = JSON.stringify(safeEnvelope);
  if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new HttpError(400, "H2B_ENVELOPE_TOO_LARGE");
  return safeEnvelope;
}
