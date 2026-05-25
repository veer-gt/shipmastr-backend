import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

export async function requireReadyMerchantAutopilotAccess(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const auth = req.auth;

  if (!auth?.userId) {
    return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  }

  if (!auth.merchantId) {
    return res.status(403).json({
      error: "MERCHANT_AUTOPILOT_REQUIRES_READY_MERCHANT",
      message: "Shipmastr Autopilot opens for ready Merchant accounts that use Shipmastr Website Hosting, Checkout, and Shipping."
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: {
      id: true,
      merchantId: true,
      merchant: {
        select: {
          id: true,
          onboardingStatus: true
        }
      }
    }
  });

  if (
    !user ||
    user.merchantId !== auth.merchantId ||
    user.merchant.id !== auth.merchantId ||
    user.merchant.onboardingStatus !== "READY_TO_SHIP"
  ) {
    return res.status(403).json({
      error: "MERCHANT_AUTOPILOT_REQUIRES_READY_MERCHANT",
      message: "Shipmastr Autopilot opens for ready Merchant accounts that use Shipmastr Website Hosting, Checkout, and Shipping."
    });
  }

  return next();
}
