import { z } from "zod";
import { isShipmastrWorkerName } from "./worker-registry.js";

export const workerRunOnceSchema = z.object({
  dry_run: z.boolean().optional(),
  max_batch: z.coerce.number().int().min(1).max(100).optional()
}).default({});

export const listWorkerRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20),
  worker_name: z.string().optional().refine((value) => !value || isShipmastrWorkerName(value), "Unsupported worker name."),
  status: z.enum(["RUNNING", "COMPLETED", "FAILED", "SKIPPED"]).optional()
});

export type WorkerRunOnceInputSchema = z.infer<typeof workerRunOnceSchema>;
export type ListWorkerRunsQueryInput = z.infer<typeof listWorkerRunsQuerySchema>;
