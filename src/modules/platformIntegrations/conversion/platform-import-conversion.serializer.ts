import { sanitizeImportPreview } from "../importQueue/platform-import-queue.serializers.js";
import type {
  PlatformImportConversionQueue,
  PlatformImportConversionReasonCode,
  PlatformImportConversionResult,
  PlatformImportConversionStatus
} from "./platform-import-conversion.types.js";

type ConversionRecord = {
  importItemId: string;
  orderId?: string | null;
  shipmentId?: string | null;
  status: string;
  queue?: string | null;
  warnings?: unknown;
  reasonCodes?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown) {
  return asArray(sanitizeImportPreview(value)).filter((entry): entry is string => typeof entry === "string");
}

export function conversionNextActions(input: {
  status: PlatformImportConversionStatus;
  queue?: PlatformImportConversionQueue | null;
  orderId?: string | null;
  shipmentId?: string | null;
}) {
  if (input.status === "BLOCKED") return ["REVIEW"];
  if (input.status === "ALREADY_CONVERTED" || input.status === "CONVERTED" || input.status === "NEEDS_ATTENTION") {
    return [
      ...(input.orderId ? ["VIEW_ORDER"] : []),
      ...(input.shipmentId ? ["VIEW_SHIPMENT_CANDIDATE"] : []),
      ...(input.queue === "NEEDS_ATTENTION" ? ["REVIEW_ATTENTION"] : [])
    ];
  }
  return ["REVIEW"];
}

export function serializePlatformImportConversionResult(result: PlatformImportConversionResult) {
  return {
    item_id: result.itemId,
    status: result.status,
    order_id: result.orderId ?? null,
    shipment_id: result.shipmentId ?? null,
    queue: result.queue ?? null,
    reason_codes: result.reasonCodes,
    warnings: sanitizeImportPreview(result.warnings) ?? [],
    next_actions: result.nextActions
  };
}

export function serializePlatformImportConversionRecord(record: ConversionRecord | null | undefined) {
  if (!record) {
    return {
      status: "NOT_CONVERTED",
      order_id: null,
      shipment_id: null,
      queue: null,
      reason_codes: [],
      warnings: [],
      converted_at: null,
      updated_at: null,
      next_actions: []
    };
  }

  const status = record.status as PlatformImportConversionStatus;
  const queue = record.queue as PlatformImportConversionQueue | null;
  const orderId = record.orderId ?? null;
  const shipmentId = record.shipmentId ?? null;
  return {
    status,
    order_id: orderId,
    shipment_id: shipmentId,
    queue,
    reason_codes: stringArray(record.reasonCodes) as PlatformImportConversionReasonCode[],
    warnings: stringArray(record.warnings),
    converted_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt),
    next_actions: conversionNextActions({ status, queue, orderId, shipmentId })
  };
}
