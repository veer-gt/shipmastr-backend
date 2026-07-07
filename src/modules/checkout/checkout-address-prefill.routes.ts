import { Router } from "express";

import { CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER } from "./checkout-address-session.service.js";
import {
  checkoutAddressPrefillService,
  type CheckoutAddressPrefillService
} from "./checkout-address-prefill.service.js";

function checkoutSessionToken(req: { get(header: string): string | undefined }) {
  return req.get(CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER)?.trim() || "";
}

export function createCheckoutAddressPrefillRouter(input: {
  service?: CheckoutAddressPrefillService | undefined;
} = {}) {
  const router = Router();
  const service = input.service ?? checkoutAddressPrefillService;

  router.get("/address-book", async (req, res) => {
    const result = await service.getSameMerchantAddressBook(checkoutSessionToken(req));
    return res.json(result);
  });

  router.post("/address-book/:addressId/select", async (req, res) => {
    const result = await service.selectSameMerchantAddress(checkoutSessionToken(req), req.params.addressId);
    return res.json(result);
  });

  return router;
}

export const checkoutAddressPrefillRouter = createCheckoutAddressPrefillRouter();
