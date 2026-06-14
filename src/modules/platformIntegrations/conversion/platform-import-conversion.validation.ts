import { z } from "zod";
import { storePlatformSchema } from "../platform-integrations.validation.js";
import { reconciliationStatusSchema } from "../reconciliation/platform-import-reconciliation.validation.js";

const booleanFilterSchema = z.union([
  z.boolean(),
  z.enum(["true", "false", "1", "0"])
]).transform((value) => value === true || value === "true" || value === "1");

const optionalDateSchema = z.string().datetime().optional();

export const convertPlatformImportItemSchema = z.object({
  createShipmentCandidate: z.boolean().default(true).optional()
}).strict();

export const bulkConvertPlatformImportItemsSchema = z.object({
  itemIds: z.array(z.string().trim().min(1)).max(50).optional(),
  filters: z.object({
    platform: storePlatformSchema.optional(),
    connectionId: z.string().trim().min(1).optional(),
    jobId: z.string().trim().min(1).optional(),
    status: reconciliationStatusSchema.optional(),
    dateFrom: optionalDateSchema,
    dateTo: optionalDateSchema,
    hasWarnings: booleanFilterSchema.optional()
  }).strict().optional(),
  createShipmentCandidates: z.boolean().default(true).optional(),
  limit: z.number().int().min(1).max(50).default(25).optional()
}).strict().refine((value) => Boolean(value.itemIds?.length || value.filters), {
  message: "Provide itemIds or filters for bulk conversion."
});

export type ConvertPlatformImportItemInput = z.infer<typeof convertPlatformImportItemSchema>;
export type BulkConvertPlatformImportItemsInput = z.infer<typeof bulkConvertPlatformImportItemsSchema>;
