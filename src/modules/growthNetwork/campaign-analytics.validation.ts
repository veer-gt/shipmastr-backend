import { z } from "zod";

import { campaignIdParamsSchema } from "./merchant-campaign.validation.js";

export const campaignAnalyticsQuerySchema = z.object({
  merchantId: z.string().trim().min(1).max(160).optional().nullable()
});

export const campaignAnalyticsParamsSchema = campaignIdParamsSchema;

export type CampaignAnalyticsQueryInput = z.infer<typeof campaignAnalyticsQuerySchema>;
