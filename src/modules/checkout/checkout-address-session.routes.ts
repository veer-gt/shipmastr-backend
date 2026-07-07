import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import {
  CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER,
  checkoutAddressSessionService,
  type CheckoutAddressSessionService
} from "./checkout-address-session.service.js";

const sessionSchema = z.object({
  merchantId: z.string().trim().min(1).max(160),
  cartId: z.string().trim().min(1).max(160).optional()
}).strict();

const startSchema = z.object({
  phone: z.string().trim().min(6).max(32),
  provider: z.enum(["otp", "truecaller"])
}).strict();

const confirmSchema = z.object({
  verificationHandle: z.string().trim().min(1).max(2048),
  proof: z.string().trim().min(1).max(120)
}).strict();

export const checkoutPhoneVerificationRateLimit = {
  windowMs: 60 * 1000,
  limit: 20
};

function checkoutSessionToken(req: { get(header: string): string | undefined }) {
  return req.get(CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER)?.trim() || "";
}

export function createCheckoutAddressSessionRouter(input: {
  service?: CheckoutAddressSessionService | undefined;
  enableRateLimit?: boolean | undefined;
} = {}) {
  const router = Router();
  const service = input.service ?? checkoutAddressSessionService;
  const limiter = rateLimit({
    ...checkoutPhoneVerificationRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "CHECKOUT_PHONE_RATE_LIMITED" }
  });
  const rateLimitMiddleware = input.enableRateLimit === false ? [] : [limiter];

  router.post("/session", async (req, res) => {
    const body = sessionSchema.parse(req.body);
    const result = await service.createSession(body);
    return res.status(201).json(result);
  });

  router.post("/verify-phone/start", ...rateLimitMiddleware, async (req, res) => {
    const body = startSchema.parse(req.body);
    const result = await service.startPhoneVerification({
      sessionToken: checkoutSessionToken(req),
      phone: body.phone,
      provider: body.provider
    });
    return res.json(result);
  });

  router.post("/verify-phone/confirm", ...rateLimitMiddleware, async (req, res) => {
    const body = confirmSchema.parse(req.body);
    const result = await service.confirmPhoneVerification({
      sessionToken: checkoutSessionToken(req),
      verificationHandle: body.verificationHandle,
      proof: body.proof
    });
    return res.json(result);
  });

  return router;
}

export const checkoutAddressSessionRouter = createCheckoutAddressSessionRouter();
