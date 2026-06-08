import { z } from "zod";
import { storePlatformSchema } from "../platform-integrations.validation.js";

export const platformImportJobStatusSchema = z.enum([
  "DRAFT",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "COMPLETED_WITH_WARNINGS",
  "FAILED",
  "CANCELLED"
]);

export const platformImportJobModeSchema = z.enum([
  "DRY_RUN",
  "IMPORT_FOUNDATION",
  "READ_ONLY_FETCH_PLACEHOLDER"
]);

export const platformImportSourceSchema = z.enum([
  "MANUAL_PAYLOAD",
  "WEBHOOK_PAYLOAD",
  "POLLING_PLACEHOLDER",
  "FILE_UPLOAD_PLACEHOLDER"
]);

const platformOrderObjectSchema = z.record(z.string(), z.unknown());

export const platformImportReadOptionsSchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).max(500).nullable().optional()
}).strict();

export const createPlatformImportJobSchema = z.object({
  connectionId: z.string().trim().min(1),
  mode: platformImportJobModeSchema.default("DRY_RUN"),
  source: platformImportSourceSchema.default("MANUAL_PAYLOAD"),
  requestedBy: z.string().trim().max(160).nullable().optional(),
  pickupLocationId: z.string().trim().min(1).nullable().optional(),
  readOptions: platformImportReadOptionsSchema.optional(),
  orders: z.array(platformOrderObjectSchema).max(50).default([])
}).strict();

export const listPlatformImportJobsQuerySchema = z.object({
  platform: storePlatformSchema.optional(),
  status: platformImportJobStatusSchema.optional(),
  mode: platformImportJobModeSchema.optional(),
  connectionId: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export const runPlatformImportJobSchema = z.object({}).strict();

export const continuePlatformImportJobSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional()
}).strict();

export const listPlatformImportCursorsQuerySchema = z.object({
  platform: storePlatformSchema.optional(),
  connectionId: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export const runPlatformImportCursorNextPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional()
}).strict();

export const resetPlatformImportCursorSchema = z.object({}).strict();

export type CreatePlatformImportJobInput = z.infer<typeof createPlatformImportJobSchema>;
export type ListPlatformImportJobsQueryInput = z.infer<typeof listPlatformImportJobsQuerySchema>;
export type ContinuePlatformImportJobInput = z.infer<typeof continuePlatformImportJobSchema>;
export type ListPlatformImportCursorsQueryInput = z.infer<typeof listPlatformImportCursorsQuerySchema>;
export type RunPlatformImportCursorNextPageInput = z.infer<typeof runPlatformImportCursorNextPageSchema>;
