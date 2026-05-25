import { Router } from "express";
import { z } from "zod";
import { getNdrActionCenter, resolveNdrEvent, resolveNdrEvents } from "./ndr.service.js";

export const ndrRouter = Router();

const resolutionSchema = z.object({
  preferredAction: z.enum(["reattempt", "reschedule", "hold", "return_to_origin"]).default("reattempt"),
  preferredSlot: z.string().trim().max(120).optional().default(""),
  note: z.string().trim().max(500).optional().default(""),
  attempted: z.boolean().optional().default(true)
});

const bulkResolutionSchema = resolutionSchema.extend({
  ids: z.array(z.string().min(1)).min(1).max(100)
});

ndrRouter.get("/action-center", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const actionCenter = await getNdrActionCenter(merchantId);
  res.json(actionCenter);
});

ndrRouter.post("/bulk-resolve", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const body = bulkResolutionSchema.parse(req.body);
  const result = await resolveNdrEvents(merchantId, body.ids, body);
  res.json(result);
});

ndrRouter.post("/:id/resolve", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const body = resolutionSchema.parse(req.body);
  const ndrEvent = await resolveNdrEvent(merchantId, String(req.params.id), body);
  res.json({ ndrEvent });
});
