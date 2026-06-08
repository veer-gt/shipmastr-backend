import { z } from "zod";

export const platformWebhookPlatformSchema = z.enum(["SHOPIFY", "WOOCOMMERCE", "MAGENTO"]);

export const platformWebhookStatusSchema = z.enum([
  "RECEIVED",
  "VERIFIED",
  "REJECTED",
  "DUPLICATE",
  "STAGED_FOR_IMPORT",
  "FAILED",
  "IGNORED"
]);

export const platformWebhookEventListQuerySchema = z.object({
  platform: platformWebhookPlatformSchema.optional(),
  status: platformWebhookStatusSchema.optional(),
  connectionId: z.string().trim().min(1).optional(),
  topic: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export const stagePlatformWebhookEventImportSchema = z.object({}).strict();

export type PlatformWebhookEventListQueryInput = z.infer<typeof platformWebhookEventListQuerySchema>;
