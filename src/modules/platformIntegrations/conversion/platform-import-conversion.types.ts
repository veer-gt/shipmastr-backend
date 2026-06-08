export type PlatformImportConversionStatus =
  | "CONVERTED"
  | "NEEDS_ATTENTION"
  | "BLOCKED"
  | "ALREADY_CONVERTED";

export type PlatformImportConversionQueue =
  | "READY_TO_SHIP"
  | "NEEDS_ATTENTION";

export type PlatformImportConversionReasonCode =
  | "ITEM_NOT_READY"
  | "ITEM_FAILED"
  | "ITEM_DUPLICATE"
  | "ITEM_IGNORED"
  | "ITEM_NEEDS_REVIEW"
  | "MISSING_EXTERNAL_ORDER_ID"
  | "MISSING_SHIPPING_PINCODE"
  | "MISSING_COUNTRY"
  | "MISSING_LINE_ITEMS"
  | "ALREADY_CONVERTED"
  | "MERCHANT_SCOPE_MISMATCH"
  | "ORDER_ALREADY_EXISTS"
  | "SHIPMENT_CANDIDATE_NOT_READY";

export type PlatformImportConversionResult = {
  itemId: string;
  status: PlatformImportConversionStatus;
  orderId?: string | null;
  shipmentId?: string | null;
  queue?: PlatformImportConversionQueue | null;
  reasonCodes: PlatformImportConversionReasonCode[];
  warnings: string[];
  nextActions: string[];
};
