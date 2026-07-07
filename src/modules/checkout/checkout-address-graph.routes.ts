import { Router } from "express";
import { z } from "zod";

import { CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER } from "./checkout-address-session.service.js";
import {
  checkoutAddressGraphService,
  type CheckoutAddressGraphService
} from "./checkout-address-graph.service.js";

const checkoutAddressSchema = z.object({
  fullName: z.string().trim().min(1).max(180),
  line1: z.string().trim().min(1).max(500),
  line2: z.string().trim().min(1).max(500).optional(),
  landmark: z.string().trim().min(1).max(240).optional(),
  pincode: z.string().trim().regex(/^\d{6}$/),
  city: z.string().trim().min(1).max(120).optional(),
  state: z.string().trim().min(1).max(120).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  placeId: z.string().trim().min(1).max(240).optional(),
  source: z.enum(["manual", "places", "truecaller", "network_prefill"]).default("manual"),
  quality: z.number().int().min(0).max(3).default(0),
  consentScope: z.enum(["merchant", "network"]).default("merchant"),
  consentTextVersion: z.string().trim().min(1).max(120)
}).strict();

function checkoutSessionToken(req: { get(header: string): string | undefined }) {
  return req.get(CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER)?.trim() || "";
}

export function createCheckoutAddressGraphRouter(input: {
  service?: CheckoutAddressGraphService | undefined;
} = {}) {
  const router = Router();
  const service = input.service ?? checkoutAddressGraphService;

  router.post("/address", async (req, res) => {
    const body = checkoutAddressSchema.parse(req.body);
    const result = await service.persistCheckoutAddress(checkoutSessionToken(req), body);
    return res.status(result.deduped ? 200 : 201).json(result);
  });

  return router;
}

export const checkoutAddressGraphRouter = createCheckoutAddressGraphRouter();
