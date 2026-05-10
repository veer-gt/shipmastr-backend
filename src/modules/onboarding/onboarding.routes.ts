import { MerchantOnboardingStepStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import { isAdminRole } from "../../lib/accountRoles.js";
import { prisma } from "../../lib/prisma.js";
import { getMerchantOnboarding, updateMerchantOnboarding } from "./onboarding.service.js";

export const onboardingRouter = Router();

const onboardingPatchSchema = z.object({
  merchantId: z.string().trim().min(1).optional(),
  gstin: z.string().trim().max(15).nullable().optional().or(z.literal("")),
  pan: z.string().trim().max(10).nullable().optional().or(z.literal("")),
  pickupAddressStatus: z.nativeEnum(MerchantOnboardingStepStatus).optional(),
  kycStatus: z.nativeEnum(MerchantOnboardingStepStatus).optional(),
  bankStatus: z.nativeEnum(MerchantOnboardingStepStatus).optional(),
  firstShipmentStatus: z.nativeEnum(MerchantOnboardingStepStatus).optional(),
  onboardingNotes: z.string().trim().max(2000).nullable().optional()
}).refine((body) => (
  body.gstin !== undefined ||
  body.pan !== undefined ||
  body.pickupAddressStatus !== undefined ||
  body.kycStatus !== undefined ||
  body.bankStatus !== undefined ||
  body.firstShipmentStatus !== undefined ||
  body.onboardingNotes !== undefined
), {
  message: "At least one onboarding field is required"
});

const onboardingQuerySchema = z.object({
  merchantId: z.string().trim().min(1).optional()
});

async function isInternalAdmin(actorId: string, role?: string) {
  if (!isAdminRole(role)) return false;

  const user = await prisma.user.findUnique({
    where: { id: actorId },
    select: { role: true, userType: true }
  });

  return Boolean(user?.userType === "INTERNAL_SHIPMASTR" && isAdminRole(user.role));
}

async function resolveMerchantId(input: {
  requestedMerchantId?: string | undefined;
  actorId: string;
  actorMerchantId: string;
  role?: string | undefined;
}) {
  if (!input.requestedMerchantId || input.requestedMerchantId === input.actorMerchantId) {
    return input.actorMerchantId;
  }

  if (await isInternalAdmin(input.actorId, input.role)) {
    return input.requestedMerchantId;
  }

  throw new HttpError(403, "MERCHANT_SCOPE_DENIED");
}

onboardingRouter.get("/", async (req, res) => {
  const query = onboardingQuerySchema.parse(req.query);
  const merchantId = await resolveMerchantId({
    requestedMerchantId: query.merchantId,
    actorId: req.auth!.userId,
    actorMerchantId: req.auth!.merchantId!,
    role: req.auth!.role
  });

  const result = await getMerchantOnboarding(merchantId);
  if (!result) throw new HttpError(404, "MERCHANT_NOT_FOUND");

  res.json(result);
});

onboardingRouter.patch("/", async (req, res) => {
  const body = onboardingPatchSchema.parse(req.body);
  const merchantId = await resolveMerchantId({
    requestedMerchantId: body.merchantId,
    actorId: req.auth!.userId,
    actorMerchantId: req.auth!.merchantId!,
    role: req.auth!.role
  });

  const patch: Parameters<typeof updateMerchantOnboarding>[0]["patch"] = {};
  if (body.gstin !== undefined) patch.gstin = body.gstin;
  if (body.pan !== undefined) patch.pan = body.pan;
  if (body.pickupAddressStatus !== undefined) patch.pickupAddressStatus = body.pickupAddressStatus;
  if (body.kycStatus !== undefined) patch.kycStatus = body.kycStatus;
  if (body.bankStatus !== undefined) patch.bankStatus = body.bankStatus;
  if (body.firstShipmentStatus !== undefined) patch.firstShipmentStatus = body.firstShipmentStatus;
  if (body.onboardingNotes !== undefined) patch.onboardingNotes = body.onboardingNotes;

  const input: Parameters<typeof updateMerchantOnboarding>[0] = {
    merchantId,
    patch
  };
  if (req.auth?.userId) input.actorId = req.auth.userId;

  const result = await updateMerchantOnboarding(input);

  if (!result) throw new HttpError(404, "MERCHANT_NOT_FOUND");

  res.json(result);
});
