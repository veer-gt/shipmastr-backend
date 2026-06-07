import { z } from "zod";

export const magentoInstallModeSchema = z.enum([
  "INTEGRATION_TOKEN_PLACEHOLDER",
  "EXTENSION_PLACEHOLDER",
  "ADOBE_COMMERCE_PLACEHOLDER"
]);
const safeSlugSchema = z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(80);

export const createMagentoConnectionSchema = z.object({
  storeName: z.string().trim().max(160).nullable().optional(),
  baseUrl: z.string().trim().url(),
  storeViewCode: safeSlugSchema.nullable().optional(),
  websiteCode: safeSlugSchema.nullable().optional(),
  apiVersion: z.string().trim().max(40).nullable().optional(),
  installMode: magentoInstallModeSchema.optional(),
  credentialsRef: z.string().trim().max(240).nullable().optional()
}).catchall(z.unknown());

export const updateMagentoConnectionSchema = z.object({
  storeName: z.string().trim().max(160).nullable().optional(),
  baseUrl: z.string().trim().url().optional(),
  storeViewCode: safeSlugSchema.nullable().optional(),
  websiteCode: safeSlugSchema.nullable().optional(),
  apiVersion: z.string().trim().max(40).nullable().optional(),
  installMode: magentoInstallModeSchema.optional(),
  webhookStatus: z.enum(["NOT_CONFIGURED", "SIMULATED", "ACTIVE_PLACEHOLDER", "DISABLED", "ERROR"]).optional()
}).catchall(z.unknown());

export const magentoOrderWebhookSchema = z.object({
  payload: z.unknown(),
  headers: z.record(z.string(), z.unknown()).optional(),
  pickupLocationId: z.string().trim().min(1).optional()
}).strict();

export const magentoShippingSyncSchema = z.object({
  shipmentId: z.string().trim().min(1),
  externalOrderId: z.string().trim().max(180).nullable().optional(),
  incrementId: z.string().trim().max(180).nullable().optional(),
  trackingNumber: z.string().trim().max(180).nullable().optional(),
  trackingUrl: z.string().trim().url().nullable().optional(),
  carrierTitle: z.literal("Shipmastr").optional(),
  comment: z.string().trim().max(500).nullable().optional(),
  notifyCustomer: z.boolean().optional()
}).strict();

export const listMagentoRecordsQuerySchema = z.object({
  status: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export const magentoWebhookValidationSchema = z.object({
  headers: z.record(z.string(), z.unknown()),
  body: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  secret: z.string().trim().min(1).optional()
}).strict();

export type CreateMagentoConnectionInput = z.infer<typeof createMagentoConnectionSchema>;
export type UpdateMagentoConnectionInput = z.infer<typeof updateMagentoConnectionSchema>;
export type MagentoOrderWebhookInput = z.infer<typeof magentoOrderWebhookSchema>;
export type MagentoShippingSyncInput = z.infer<typeof magentoShippingSyncSchema>;
export type ListMagentoRecordsQueryInput = z.infer<typeof listMagentoRecordsQuerySchema>;
export type MagentoWebhookValidationInput = z.infer<typeof magentoWebhookValidationSchema>;
