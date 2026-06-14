import { z } from "zod";
import { storePlatformSchema } from "../platform-integrations.validation.js";

export const reconciliationStatusSchema = z.enum([
  "READY",
  "DUPLICATE",
  "WARNING",
  "FAILED",
  "IGNORED",
  "NEEDS_REVIEW"
]);

const booleanQuerySchema = z.union([
  z.boolean(),
  z.enum(["true", "false", "1", "0"])
]).transform((value) => value === true || value === "true" || value === "1");

const optionalDateSchema = z.string().datetime().optional();

const baseReconciliationQuerySchema = z.object({
  platform: storePlatformSchema.optional(),
  connectionId: z.string().trim().min(1).optional(),
  jobId: z.string().trim().min(1).optional(),
  status: reconciliationStatusSchema.optional(),
  dateFrom: optionalDateSchema,
  dateTo: optionalDateSchema,
  hasWarnings: booleanQuerySchema.optional(),
  hasErrors: booleanQuerySchema.optional()
}).strict();

export const reconciliationSummaryQuerySchema = baseReconciliationQuerySchema;

export const reconciliationItemsQuerySchema = baseReconciliationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  sort: z.enum([
    "created_at_desc",
    "created_at_asc",
    "updated_at_desc",
    "updated_at_asc"
  ]).default("updated_at_desc")
}).strict();

export type ReconciliationSummaryQueryInput = z.infer<typeof reconciliationSummaryQuerySchema>;
export type ReconciliationItemsQueryInput = z.infer<typeof reconciliationItemsQuerySchema>;
export type ReconciliationStatusInput = z.infer<typeof reconciliationStatusSchema>;
