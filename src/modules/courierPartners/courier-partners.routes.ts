import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import {
  autoEnableCourierPartnersMessage,
  autoEnableCourierPartners,
  serializePublicAutoEnableResult
} from "./courier-partners.service.js";

export const courierPartnersRouter = Router();

const autoEnableSchema = z.object({
  seller_id: z.string().trim().min(1),
  country: z.string().trim().min(2).max(2),
  segments: z.array(z.string().trim().min(1)).min(1)
});

export async function autoEnableCourierPartnersHandler(req: Request, res: Response) {
  const body = autoEnableSchema.parse(req.body);
  const result = await autoEnableCourierPartners({
    sellerId: body.seller_id,
    country: body.country,
    segments: body.segments
  });

  return res.json({
    success: true,
    message: autoEnableCourierPartnersMessage(result),
    data: serializePublicAutoEnableResult(result),
    error: null
  });
}

courierPartnersRouter.post("/auto-enable", autoEnableCourierPartnersHandler);
