import type { MerchantCampaignReviewStatus } from "@prisma/client";

import {
  safePublicText,
  timestamp
} from "./growth-network-maturity.shared.js";
import {
  serializeMerchantCampaign,
  type MerchantCampaignRecord
} from "./merchant-campaign.serializer.js";

export type MerchantCampaignReviewRecord = {
  id: string;
  campaignId: string;
  reviewerRef?: string | null;
  reviewStatus: MerchantCampaignReviewStatus | string;
  decisionReason?: string | null;
  policyChecklist?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export type CampaignPolicyCheck = {
  passed: boolean;
  checks: Array<{
    key: string;
    passed: boolean;
    message: string;
  }>;
};

export function serializeCampaignReview(record: MerchantCampaignReviewRecord) {
  return {
    reviewId: record.id,
    campaignId: record.campaignId,
    reviewerRef: record.reviewerRef ?? null,
    reviewStatus: record.reviewStatus,
    decisionReason: safePublicText(record.decisionReason),
    policyChecklist: record.policyChecklist ?? null,
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializeCampaignReviewQueue(input: {
  campaigns: MerchantCampaignRecord[];
  total: number;
  page: number;
  perPage: number;
}) {
  return {
    campaigns: input.campaigns.map(serializeMerchantCampaign),
    pagination: {
      page: input.page,
      perPage: input.perPage,
      total: input.total,
      hasMore: input.page * input.perPage < input.total
    }
  };
}

export function serializeCampaignReviewDetail(input: {
  campaign: MerchantCampaignRecord;
  reviews: MerchantCampaignReviewRecord[];
}) {
  return {
    campaign: serializeMerchantCampaign(input.campaign),
    reviews: input.reviews.map(serializeCampaignReview)
  };
}

export function serializeCampaignPolicyCheck(result: CampaignPolicyCheck) {
  return result;
}
