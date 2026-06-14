import { z } from "zod";

import { growthPlacementSurfaces } from "./growth-network.types.js";
import {
  merchantCampaignEventTypes,
  merchantCampaignStatuses,
  merchantCampaignTypes
} from "./merchant-campaign.types.js";

const optionalId = z.string().trim().min(1).max(160).optional().nullable();
const optionalText = z.string().trim().max(2000).optional().nullable();
const optionalUrl = z.string().trim().max(2048).optional().nullable();
const jsonObject = z.record(z.string(), z.unknown()).optional().nullable();

function dateWindowRefinement(
  value: { startsAt?: Date | null | undefined; endsAt?: Date | null | undefined },
  ctx: z.RefinementCtx
) {
  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    ctx.addIssue({
      code: "custom",
      path: ["endsAt"],
      message: "endsAt must be after startsAt"
    });
  }
}

export const createMerchantCampaignSchema = z.object({
  merchantId: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(160),
  description: optionalText,
  campaignType: z.enum(merchantCampaignTypes),
  surface: z.enum(growthPlacementSurfaces).default("SELLER_DASHBOARD"),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  ctaLabel: z.string().trim().min(1).max(80),
  ctaUrl: optionalUrl,
  rulesJson: jsonObject,
  metadata: jsonObject
}).superRefine(dateWindowRefinement);

export const updateMerchantCampaignSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: optionalText,
  campaignType: z.enum(merchantCampaignTypes).optional(),
  surface: z.enum(growthPlacementSurfaces).optional(),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  ctaLabel: z.string().trim().min(1).max(80).optional(),
  ctaUrl: optionalUrl,
  rulesJson: jsonObject,
  metadata: jsonObject
}).superRefine(dateWindowRefinement);

export const listMerchantCampaignsQuerySchema = z.object({
  merchantId: optionalId,
  status: z.enum(merchantCampaignStatuses).optional(),
  campaignType: z.enum(merchantCampaignTypes).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50)
});

export const campaignDecisionSchema = z.object({
  reviewerRef: z.string().trim().min(1).max(160).optional().nullable(),
  reason: z.string().trim().max(1000).optional().nullable(),
  policyChecklist: jsonObject
});

export const rejectCampaignSchema = campaignDecisionSchema.extend({
  reason: z.string().trim().min(1).max(1000)
});

export const recordMerchantCampaignEventSchema = z.object({
  campaignId: z.string().trim().min(1).max(160),
  merchantId: optionalId,
  sellerId: optionalId,
  eventType: z.enum(merchantCampaignEventTypes),
  surface: z.enum(growthPlacementSurfaces).optional().nullable(),
  growthOfferEventId: optionalId,
  metadata: jsonObject
});

export const resolveMerchantCampaignCardsQuerySchema = z.object({
  merchantId: optionalId,
  sellerId: optionalId,
  max: z.coerce.number().int().min(1).max(12).default(3)
});

export const campaignIdParamsSchema = z.object({
  campaignId: z.string().trim().min(1).max(160)
});

export const campaignSurfaceParamsSchema = z.object({
  surface: z.enum(growthPlacementSurfaces)
});

export type CreateMerchantCampaignInput = z.infer<typeof createMerchantCampaignSchema>;
export type UpdateMerchantCampaignInput = z.infer<typeof updateMerchantCampaignSchema>;
export type ListMerchantCampaignsQueryInput = z.infer<typeof listMerchantCampaignsQuerySchema>;
export type CampaignDecisionInput = z.infer<typeof campaignDecisionSchema>;
export type RejectCampaignInput = z.infer<typeof rejectCampaignSchema>;
export type RecordMerchantCampaignEventInput = z.infer<typeof recordMerchantCampaignEventSchema>;
export type ResolveMerchantCampaignCardsQueryInput = z.infer<typeof resolveMerchantCampaignCardsQuerySchema>;
