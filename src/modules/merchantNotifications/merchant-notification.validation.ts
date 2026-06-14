import { z } from "zod";

export const listMerchantNotificationsQuerySchema = z.object({
  status: z.enum(["UNREAD", "READ", "ARCHIVED"]).optional(),
  type: z.string().trim().min(1).max(80).optional(),
  severity: z.enum(["INFO", "WARNING", "ERROR", "SUCCESS"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
});

export const updateMerchantNotificationPreferencesSchema = z.object({
  in_app_enabled: z.boolean().optional(),
  import_failed_enabled: z.boolean().optional(),
  needs_review_enabled: z.boolean().optional(),
  duplicate_enabled: z.boolean().optional(),
  conversion_blocked_enabled: z.boolean().optional(),
  digest_enabled: z.boolean().optional(),
  email_enabled: z.boolean().optional()
});

export type ListMerchantNotificationsQueryInput = z.infer<typeof listMerchantNotificationsQuerySchema>;
export type UpdateMerchantNotificationPreferencesInput = z.infer<typeof updateMerchantNotificationPreferencesSchema>;
