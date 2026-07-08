import { Router } from "express";
import { z } from "zod";
import { createStorefrontCheckoutQuote } from "./storefront-checkout.service.js";
import { serializeCheckoutQuote } from "../checkout/checkout-serializers.js";

// SF5 Layer 3 — public, shopper-facing router. No auth (shoppers are anonymous), but no
// pricing input is ever trusted from the client either: see storefront-checkout.service.ts.
export const storefrontCheckoutRouter = Router();

const storefrontQuoteItemSchema = z.object({
  productId: z.string().trim().min(1).max(160),
  quantity: z.number().int().positive().max(1000)
}).strict();

const storefrontQuoteSchema = z.object({
  storefrontId: z.string().trim().min(1).max(160),
  items: z.array(storefrontQuoteItemSchema).min(1).max(200),
  pincode: z.string().trim().regex(/^\d{6}$/)
}).strict();

storefrontCheckoutRouter.post("/quote", async (req, res) => {
  const body = storefrontQuoteSchema.parse(req.body);
  const quote = await createStorefrontCheckoutQuote(body);
  return res.status(201).json(serializeCheckoutQuote(quote));
});
