import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { calculateRisk } from "./risk.service.js";

export const riskRouter = Router();

riskRouter.use(requireAuth);

const schema = z.object({
  buyerPhone: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  state: z.string(),
  pincode: z.string(),
  orderValue: z.number(),
  codAmount: z.number(),
  paymentMode: z.enum(["PREPAID", "COD"])
});

riskRouter.post("/preview", async (req, res) => {
  const body = schema.parse(req.body);
  const risk = calculateRisk({
    ...body,
    addressLine2: body.addressLine2 ?? null
  });

  res.json({ risk });
});
