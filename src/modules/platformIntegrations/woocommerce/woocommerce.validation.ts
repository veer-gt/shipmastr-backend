import { z } from "zod";

export const wooCommerceInstallModeSchema = z.enum(["REST_KEY_PLACEHOLDER", "PLUGIN_PLACEHOLDER"]);

export const createWooCommerceConnectionSchema = z.object({
  storeName: z.string().trim().max(160).nullable().optional(),
  siteUrl: z.string().trim().url(),
  apiVersion: z.string().trim().regex(/^wc\/v[1-9][0-9]*$/).nullable().optional(),
  installMode: wooCommerceInstallModeSchema.optional(),
  credentialsRef: z.string().trim().max(240).nullable().optional()
}).catchall(z.unknown());

export const updateWooCommerceConnectionSchema = z.object({
  storeName: z.string().trim().max(160).nullable().optional(),
  siteUrl: z.string().trim().url().optional(),
  apiVersion: z.string().trim().regex(/^wc\/v[1-9][0-9]*$/).nullable().optional(),
  installMode: wooCommerceInstallModeSchema.optional(),
  webhookStatus: z.enum(["NOT_CONFIGURED", "SIMULATED", "ACTIVE_PLACEHOLDER", "DISABLED", "ERROR"]).optional()
}).catchall(z.unknown());

export const wooCommerceOrderWebhookSchema = z.object({
  payload: z.unknown(),
  headers: z.record(z.string(), z.unknown()).optional(),
  pickupLocationId: z.string().trim().min(1).optional()
}).strict();

export const wooCommerceTrackingSyncSchema = z.object({
  shipmentId: z.string().trim().min(1),
  externalOrderId: z.string().trim().max(180).nullable().optional(),
  trackingNumber: z.string().trim().max(180).nullable().optional(),
  trackingUrl: z.string().trim().url().nullable().optional(),
  trackingProvider: z.literal("Shipmastr").optional(),
  customerNote: z.string().trim().max(500).nullable().optional(),
  notifyCustomer: z.boolean().optional()
}).strict();

export const listWooCommerceRecordsQuerySchema = z.object({
  status: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export const wooCommerceWebhookValidationSchema = z.object({
  headers: z.record(z.string(), z.unknown()),
  body: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  secret: z.string().trim().min(1).optional()
}).strict();

export type CreateWooCommerceConnectionInput = z.infer<typeof createWooCommerceConnectionSchema>;
export type UpdateWooCommerceConnectionInput = z.infer<typeof updateWooCommerceConnectionSchema>;
export type WooCommerceOrderWebhookInput = z.infer<typeof wooCommerceOrderWebhookSchema>;
export type WooCommerceTrackingSyncInput = z.infer<typeof wooCommerceTrackingSyncSchema>;
export type ListWooCommerceRecordsQueryInput = z.infer<typeof listWooCommerceRecordsQuerySchema>;
export type WooCommerceWebhookValidationInput = z.infer<typeof wooCommerceWebhookValidationSchema>;
