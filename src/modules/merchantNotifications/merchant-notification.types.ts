export type MerchantNotificationType =
  | "IMPORT_JOB_FAILED"
  | "IMPORT_ITEM_FAILED"
  | "IMPORT_ITEM_NEEDS_REVIEW"
  | "IMPORT_ITEM_DUPLICATE"
  | "IMPORT_ITEM_RETRY_READY"
  | "CONVERSION_BLOCKED"
  | "CONVERSION_NEEDS_ATTENTION"
  | "CONVERSION_COMPLETED"
  | "IMPORT_DIGEST";

export type MerchantNotificationSeverity = "INFO" | "WARNING" | "ERROR" | "SUCCESS";

export type MerchantNotificationStatus = "UNREAD" | "READ" | "ARCHIVED";

export type MerchantNotificationSourceType =
  | "PLATFORM_IMPORT_JOB"
  | "PLATFORM_IMPORT_ITEM"
  | "PLATFORM_IMPORT_CONVERSION"
  | "IMPORT_DIGEST";

export type MerchantNotificationInput = {
  type: MerchantNotificationType;
  severity: MerchantNotificationSeverity;
  title: string;
  message: string;
  actionLabel?: string | null;
  actionUrl?: string | null;
  sourceType?: MerchantNotificationSourceType | null;
  sourceId?: string | null;
  sourceMeta?: unknown;
  dedupeKey: string;
};
