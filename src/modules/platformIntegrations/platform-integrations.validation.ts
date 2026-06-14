import { z } from "zod";

export const storePlatformSchema = z.enum(["SHOPIFY", "WOOCOMMERCE", "MAGENTO", "CUSTOM"]);
export const platformConnectionStatusSchema = z.enum(["DRAFT", "ACTIVE", "DISABLED", "ERROR"]);
export const platformSyncDirectionSchema = z.enum(["IMPORT_ONLY", "EXPORT_ONLY", "BIDIRECTIONAL"]);

export const createPlatformConnectionSchema = z.object({
  platform: storePlatformSchema,
  storeName: z.string().trim().max(160).nullable().optional(),
  storeUrl: z.string().trim().url(),
  status: platformConnectionStatusSchema.optional(),
  syncDirection: platformSyncDirectionSchema.optional(),
  credentialsRef: z.string().trim().max(240).nullable().optional(),
  credentialsMeta: z.record(z.string(), z.unknown()).nullable().optional()
}).strict();

export const updatePlatformConnectionSchema = z.object({
  status: platformConnectionStatusSchema.optional(),
  storeName: z.string().trim().max(160).nullable().optional(),
  syncDirection: platformSyncDirectionSchema.optional()
}).strict();

export const platformOrderPayloadSchema = z.object({
  payload: z.unknown(),
  pickupLocationId: z.string().trim().min(1).optional()
}).strict();

export const listPlatformConnectionsQuerySchema = z.object({
  platform: storePlatformSchema.optional(),
  status: platformConnectionStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export const listPlatformOrderImportsQuerySchema = z.object({
  platform: storePlatformSchema.optional(),
  status: z.enum(["RECEIVED", "MAPPED", "SKIPPED", "FAILED", "IMPORTED"]).optional(),
  connectionId: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export const createPlatformTrackingSyncSchema = z.object({
  shipmentId: z.string().trim().min(1),
  externalOrderId: z.string().trim().max(180).nullable().optional(),
  trackingNumber: z.string().trim().max(180).nullable().optional(),
  trackingUrl: z.string().trim().url().nullable().optional()
}).strict();

export const listPlatformTrackingSyncsQuerySchema = z.object({
  platform: storePlatformSchema.optional(),
  status: z.enum(["PENDING", "SYNCED", "FAILED", "SKIPPED"]).optional(),
  connectionId: z.string().trim().min(1).optional(),
  shipmentId: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export type CreatePlatformConnectionInput = z.infer<typeof createPlatformConnectionSchema>;
export type UpdatePlatformConnectionInput = z.infer<typeof updatePlatformConnectionSchema>;
export type PlatformOrderPayloadInput = z.infer<typeof platformOrderPayloadSchema>;
export type ListPlatformConnectionsQueryInput = z.infer<typeof listPlatformConnectionsQuerySchema>;
export type ListPlatformOrderImportsQueryInput = z.infer<typeof listPlatformOrderImportsQuerySchema>;
export type CreatePlatformTrackingSyncInput = z.infer<typeof createPlatformTrackingSyncSchema>;
export type ListPlatformTrackingSyncsQueryInput = z.infer<typeof listPlatformTrackingSyncsQuerySchema>;
