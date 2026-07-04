import { createHash } from "node:crypto";
import type { ImportCorrectionParsedRow } from "./import-correction.types.js";

const FINGERPRINT_LENGTH = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : null;
}

export function normalizeCorrectionAmountMinor(value: unknown) {
  const text = typeof value === "bigint" ? value.toString() : cleanText(value);
  if (!text || !/^-?[0-9]+$/.test(text)) return null;
  const amount = BigInt(text);
  if (amount === 0n) return null;
  return (amount < 0n ? -amount : amount).toString();
}

export function correctionSemanticKey(row: Pick<ImportCorrectionParsedRow, "shipmentId" | "eventClass">) {
  const shipmentId = cleanText(row.shipmentId);
  const eventClass = cleanText(row.eventClass);
  if (!shipmentId || !eventClass) return null;
  return `${shipmentId}|${eventClass}`;
}

export function correctionShipmentKey(row: Pick<ImportCorrectionParsedRow, "shipmentId">) {
  const shipmentId = cleanText(row.shipmentId);
  return shipmentId || null;
}

export function correctionRowFingerprint(row: ImportCorrectionParsedRow) {
  const parsed = isRecord(row.parsed) ? row.parsed : {};
  const amountMinor = normalizeCorrectionAmountMinor(parsed.amount_minor);
  const components = {
    shipmentId: cleanText(row.shipmentId),
    eventClass: cleanText(row.eventClass),
    amountMinor,
    status: cleanText(row.status),
    exceptionCode: cleanText(row.exceptionCode),
    eventDate: cleanText(parsed.event_date),
    chargeCode: cleanText(parsed.charge_code),
    sourceEventCategory: cleanText(parsed.source_event_category),
    duplicateKey: parsed.duplicate_key ?? null
  };
  return createHash("sha256")
    .update(stableJson(components))
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}
