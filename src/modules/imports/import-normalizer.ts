import { z } from "zod";
import type { ParsedImportRow } from "./file-parser.types.js";

type NormalizedRow<T> = {
  rowNumber: number;
  rawData: Record<string, unknown>;
  normalizedData: T | null;
  awb: string | null;
  orderId: string | null;
  externalOrderId: string | null;
  valid: boolean;
  duplicateAwb: boolean;
  errors: string[];
};

const invoiceSchema = z.object({
  courierId: z.string().min(1),
  awb: z.string().min(1).nullable(),
  orderId: z.string().min(1).nullable(),
  externalOrderId: z.string().min(1).nullable(),
  chargedWeightGrams: z.number().int().positive().nullable(),
  billedWeightGrams: z.number().int().positive().nullable(),
  zone: z.string().min(1).nullable(),
  forwardFreight: z.number().nonnegative(),
  rtoFreight: z.number().nonnegative(),
  codFee: z.number().nonnegative(),
  otherCharges: z.number(),
  gstAmount: z.number().nonnegative(),
  totalCharge: z.number().nonnegative()
});

const codSchema = z.object({
  courierId: z.string().min(1).nullable(),
  awb: z.string().min(1).nullable(),
  orderId: z.string().min(1).nullable(),
  externalOrderId: z.string().min(1).nullable(),
  codAmount: z.number().nonnegative(),
  remittedAmount: z.number().nonnegative(),
  remittedAt: z.coerce.date().nullable(),
  utr: z.string().min(1).nullable()
});

export type NormalizedInvoiceRow = z.infer<typeof invoiceSchema>;
export type NormalizedCodRemittanceRow = z.infer<typeof codSchema>;

function stringValue(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return null;
}

function numberValue(row: Record<string, unknown>, keys: string[], fallback = 0) {
  const text = stringValue(row, keys);
  if (text === null) return fallback;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function optionalNumber(row: Record<string, unknown>, keys: string[]) {
  const text = stringValue(row, keys);
  if (text === null) return null;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function rowErrors(result: { success: true } | { success: false; error: z.ZodError }) {
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`);
}

function matcherErrors(row: { awb: string | null; orderId: string | null; externalOrderId: string | null }) {
  return row.awb || row.orderId || row.externalOrderId ? [] : ["AWB, orderId, or externalOrderId is required"];
}

function duplicateAwbs<T extends { awb: string | null }>(rows: T[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.awb) continue;
    counts.set(row.awb, (counts.get(row.awb) ?? 0) + 1);
  }
  return counts;
}

export function normalizeInvoiceRows(input: {
  rows: ParsedImportRow[];
  courierId: string;
}) {
  const normalized = input.rows.map((row) => {
    const normalizedData = {
      courierId: stringValue(row.data, ["courier_id", "courier", "courier_code"]) ?? input.courierId,
      awb: stringValue(row.data, ["awb", "awb_number", "waybill", "tracking_number"]),
      orderId: stringValue(row.data, ["order_id", "shipmastr_order_id"]),
      externalOrderId: stringValue(row.data, ["external_order_id", "seller_order_id", "client_order_id"]),
      chargedWeightGrams: optionalNumber(row.data, ["charged_weight_grams", "charged_weight", "billed_weight_grams"]),
      billedWeightGrams: optionalNumber(row.data, ["billed_weight_grams", "billed_weight"]),
      zone: stringValue(row.data, ["zone", "billing_zone"]),
      forwardFreight: numberValue(row.data, ["forward_freight", "freight", "forward_charge"]),
      rtoFreight: numberValue(row.data, ["rto_freight", "rto_charge"]),
      codFee: numberValue(row.data, ["cod_fee", "cod_charge"]),
      otherCharges: numberValue(row.data, ["other_charges", "adjustments"]),
      gstAmount: numberValue(row.data, ["gst_amount", "gst", "tax"]),
      totalCharge: numberValue(row.data, ["total_charge", "total_amount", "invoice_amount", "amount"], Number.NaN)
    };
    const parsed = invoiceSchema.safeParse(normalizedData);
    const errors = [...rowErrors(parsed), ...matcherErrors(normalizedData)];

    return {
      rowNumber: row.rowNumber,
      rawData: row.data,
      normalizedData: parsed.success ? parsed.data : null,
      awb: normalizedData.awb,
      orderId: normalizedData.orderId,
      externalOrderId: normalizedData.externalOrderId,
      valid: parsed.success && errors.length === 0,
      duplicateAwb: false,
      errors
    } satisfies NormalizedRow<NormalizedInvoiceRow>;
  });
  const counts = duplicateAwbs(normalized);

  return normalized.map((row) => ({
    ...row,
    duplicateAwb: Boolean(row.awb && (counts.get(row.awb) ?? 0) > 1)
  }));
}

export function normalizeCodRemittanceRows(input: {
  rows: ParsedImportRow[];
  defaultCourierId?: string | undefined;
}) {
  const normalized = input.rows.map((row) => {
    const normalizedData = {
      courierId: stringValue(row.data, ["courier_id", "courier", "courier_code"]) ?? input.defaultCourierId ?? null,
      awb: stringValue(row.data, ["awb", "awb_number", "waybill", "tracking_number"]),
      orderId: stringValue(row.data, ["order_id", "shipmastr_order_id"]),
      externalOrderId: stringValue(row.data, ["external_order_id", "seller_order_id", "client_order_id"]),
      codAmount: numberValue(row.data, ["cod_amount", "expected_cod"]),
      remittedAmount: numberValue(row.data, ["remitted_amount", "cod_remitted", "amount"], Number.NaN),
      remittedAt: stringValue(row.data, ["remitted_at", "remittance_date", "payment_date"]),
      utr: stringValue(row.data, ["utr", "utr_number", "reference"])
    };
    const parsed = codSchema.safeParse(normalizedData);
    const errors = [...rowErrors(parsed), ...matcherErrors(normalizedData)];

    return {
      rowNumber: row.rowNumber,
      rawData: row.data,
      normalizedData: parsed.success ? parsed.data : null,
      awb: normalizedData.awb,
      orderId: normalizedData.orderId,
      externalOrderId: normalizedData.externalOrderId,
      valid: parsed.success && errors.length === 0,
      duplicateAwb: false,
      errors
    } satisfies NormalizedRow<NormalizedCodRemittanceRow>;
  });
  const counts = duplicateAwbs(normalized);

  return normalized.map((row) => ({
    ...row,
    duplicateAwb: Boolean(row.awb && (counts.get(row.awb) ?? 0) > 1)
  }));
}
