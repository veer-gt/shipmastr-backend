import { Router } from "express";
import { z } from "zod";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import { runCheckoutTelemetryAbandonmentWorkerOnce } from "./checkout-telemetry-abandonment.worker.js";

export const adminCheckoutIntelligenceRouter = Router();

const runAbandonmentWorkerSchema = z.object({
  dryRun: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  maxBatch: z.number().int().positive().max(100).optional(),
  max_batch: z.number().int().positive().max(100).optional(),
  olderThanMinutes: z.number().int().positive().max(1440).optional(),
  older_than_minutes: z.number().int().positive().max(1440).optional(),
  now: z.string().trim().datetime().optional()
}).strict();

adminCheckoutIntelligenceRouter.post("/abandonment-worker/run-once", async (req, res) => {
  const body = runAbandonmentWorkerSchema.parse(req.body ?? {});
  const data = await runCheckoutTelemetryAbandonmentWorkerOnce({
    dryRun: body.dryRun,
    dry_run: body.dry_run,
    maxBatch: body.maxBatch,
    max_batch: body.max_batch,
    olderThanMinutes: body.olderThanMinutes,
    older_than_minutes: body.older_than_minutes,
    now: body.now
  });
  return res.json(successEnvelope("Checkout telemetry abandonment worker run-once evaluated safely.", data));
});
