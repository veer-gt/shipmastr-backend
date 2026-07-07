import { Router } from "express";
import { z } from "zod";

import {
  CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER,
  requireCheckoutAddressSession,
  type CheckoutAddressSessionContext
} from "./checkout-address-session.service.js";
import {
  checkoutPlacesProvider,
  type PlacesProvider
} from "./checkout-places-provider.js";

type CheckoutSessionResolver = (sessionToken: string) => Promise<CheckoutAddressSessionContext>;

const autocompleteQuerySchema = z.object({
  q: z.string().trim().max(160).default(""),
  pincode: z.string().trim().regex(/^\d{6}$/).optional()
}).strict();

const detailsBodySchema = z.object({
  placeId: z.string().trim().min(1).max(240)
}).strict();

function checkoutSessionToken(req: { get(header: string): string | undefined }) {
  return req.get(CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER)?.trim() || "";
}

export function createCheckoutPlacesRouter(input: {
  provider?: PlacesProvider | undefined;
  sessionResolver?: CheckoutSessionResolver | undefined;
} = {}) {
  const router = Router();
  const provider = input.provider ?? checkoutPlacesProvider;
  const sessionResolver = input.sessionResolver ?? requireCheckoutAddressSession;

  router.get("/places/autocomplete", async (req, res) => {
    await sessionResolver(checkoutSessionToken(req));
    const query = autocompleteQuerySchema.parse(req.query);
    const result = await provider.autocomplete({
      q: query.q,
      pincode: query.pincode
    });
    return res.json(result);
  });

  router.post("/places/details", async (req, res) => {
    await sessionResolver(checkoutSessionToken(req));
    const body = detailsBodySchema.parse(req.body);
    const result = await provider.details({ placeId: body.placeId });
    return res.json(result);
  });

  return router;
}

export const checkoutPlacesRouter = createCheckoutPlacesRouter();
