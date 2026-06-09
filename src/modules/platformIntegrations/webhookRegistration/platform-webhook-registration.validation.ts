import { z } from "zod";

export const platformWebhookRegistrationStatusSchema = z.enum([
  "DRAFT",
  "READY",
  "REGISTERED",
  "DISABLED",
  "BLOCKED",
  "FAILED"
]);

export const platformWebhookRegistrationTopicSchema = z.enum(["ORDER_CREATED", "ORDER_UPDATED"]);

export const listPlatformWebhookRegistrationsQuerySchema = z.object({
  platform: z.enum(["SHOPIFY", "WOOCOMMERCE", "MAGENTO"]).optional(),
  connectionId: z.string().trim().min(1).optional(),
  status: platformWebhookRegistrationStatusSchema.optional(),
  topic: platformWebhookRegistrationTopicSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export const dryRunPlatformWebhookRegistrationSchema = z.object({
  connectionId: z.string().trim().min(1),
  topics: z.array(platformWebhookRegistrationTopicSchema).max(2).optional()
}).strict();

export const registerPlatformWebhooksSchema = z.object({
  topics: z.array(platformWebhookRegistrationTopicSchema).max(2).optional()
}).strict();

export const disablePlatformWebhookRegistrationSchema = z.object({
  reason: z.string().trim().max(240).optional()
}).strict();

export type ListPlatformWebhookRegistrationsQueryInput = z.infer<typeof listPlatformWebhookRegistrationsQuerySchema>;
export type DryRunPlatformWebhookRegistrationInput = z.infer<typeof dryRunPlatformWebhookRegistrationSchema>;
export type RegisterPlatformWebhooksInput = z.infer<typeof registerPlatformWebhooksSchema>;
export type DisablePlatformWebhookRegistrationInput = z.infer<typeof disablePlatformWebhookRegistrationSchema>;
