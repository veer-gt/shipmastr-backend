import { Router } from "express";
import { ActorType, actorTypeForAccount } from "../../lib/accountRoles.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { buildMerchantAccountCommandCenter } from "./merchant-account-command-center.service.js";

export const merchantAccountRouter = Router();

export async function requireMerchantCommandCenterActor(input: {
  userId: string;
  merchantId: string;
}, client: Pick<typeof prisma, "user"> | Record<string, any> = prisma) {
  const user = await (client as any).user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      merchantId: true,
      role: true,
      userType: true,
      merchant: {
        select: {
          onboardingStatus: true
        }
      }
    }
  });

  if (!user || user.merchantId !== input.merchantId) {
    throw new HttpError(403, "MERCHANT_SCOPE_DENIED");
  }

  const actorType = actorTypeForAccount({
    role: user.role,
    userType: user.userType,
    onboardingStatus: user.merchant?.onboardingStatus
  });

  if (actorType !== ActorType.MERCHANT) {
    throw new HttpError(403, "MERCHANT_ACCOUNT_ONLY");
  }

  return user;
}

merchantAccountRouter.get("/command-center", async (req, res) => {
  await requireMerchantCommandCenterActor({
    userId: req.auth!.userId,
    merchantId: req.auth!.merchantId!
  });

  const commandCenter = await buildMerchantAccountCommandCenter(req.auth!.merchantId!);
  res.json({ data: commandCenter });
});
