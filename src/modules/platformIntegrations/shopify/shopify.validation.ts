import { z } from "zod";

export const shopifyInstallModeSchema = z.enum(["CUSTOM_APP", "PUBLIC_APP_PLACEHOLDER"]);

export const createShopifyConnectionSchema = z.object({
  storeName: z.string().trim().max(160).nullable().optional(),
  shopDomain: z.string().trim().min(3).max(255),
  storeUrl: z.string().trim().url(),
  apiVersion: z.string().trim().regex(/^[0-9]{4}-(01|04|07|10)$/).nullable().optional(),
  installMode: shopifyInstallModeSchema.optional(),
  credentialsRef: z.string().trim().max(240).nullable().optional()
}).catchall(z.unknown());

export const updateShopifyConnectionSchema = z.object({
  storeName: z.string().trim().max(160).nullable().optional(),
  shopDomain: z.string().trim().min(3).max(255).optional(),
  storeUrl: z.string().trim().url().optional(),
  apiVersion: z.string().trim().regex(/^[0-9]{4}-(01|04|07|10)$/).nullable().optional(),
  installMode: shopifyInstallModeSchema.optional(),
  webhookStatus: z.enum(["NOT_CONFIGURED", "SIMULATED", "ACTIVE_PLACEHOLDER", "DISABLED", "ERROR"]).optional()
}).catchall(z.unknown());

export const shopifyOrderWebhookSchema = z.object({
  payload: z.unknown(),
  headers: z.record(z.string(), z.unknown()).optional(),
  pickupLocationId: z.string().trim().min(1).optional()
}).strict();

export const shopifyFulfillmentSyncSchema = z.object({
  shipmentId: z.string().trim().min(1),
  externalOrderId: z.string().trim().max(180).nullable().optional(),
  trackingNumber: z.string().trim().max(180).nullable().optional(),
  trackingUrl: z.string().trim().url().nullable().optional(),
  trackingCompany: z.literal("Shipmastr").optional(),
  notifyCustomer: z.boolean().optional()
}).strict();

export const listShopifyRecordsQuerySchema = z.object({
  status: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export const shopifyWebhookValidationSchema = z.object({
  headers: z.record(z.string(), z.unknown()),
  body: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  secret: z.string().trim().min(1).optional()
}).strict();

export type CreateShopifyConnectionInput = z.infer<typeof createShopifyConnectionSchema>;
export type UpdateShopifyConnectionInput = z.infer<typeof updateShopifyConnectionSchema>;
export type ShopifyOrderWebhookInput = z.infer<typeof shopifyOrderWebhookSchema>;
export type ShopifyFulfillmentSyncInput = z.infer<typeof shopifyFulfillmentSyncSchema>;
export type ListShopifyRecordsQueryInput = z.infer<typeof listShopifyRecordsQuerySchema>;
export type ShopifyWebhookValidationInput = z.infer<typeof shopifyWebhookValidationSchema>;
