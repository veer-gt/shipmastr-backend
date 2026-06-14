import { z } from "zod";

import {
  campaignDecisionSchema,
  campaignIdParamsSchema,
  rejectCampaignSchema
} from "./merchant-campaign.validation.js";

export const campaignReviewQueueQuerySchema = z.object({
  merchantId: z.string().trim().min(1).max(160).optional().nullable(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50)
});

export const campaignReviewDecisionSchema = campaignDecisionSchema;
export const campaignReviewRejectSchema = rejectCampaignSchema;
export const campaignReviewParamsSchema = campaignIdParamsSchema;

export type CampaignReviewQueueQueryInput = z.infer<typeof campaignReviewQueueQuerySchema>;
export type CampaignReviewDecisionInput = z.infer<typeof campaignReviewDecisionSchema>;
export type CampaignReviewRejectInput = z.infer<typeof campaignReviewRejectSchema>;
