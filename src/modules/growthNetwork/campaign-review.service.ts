import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  cleanString,
  hasUnsafePublicText,
  isSafeInternalCtaUrl
} from "./growth-network-maturity.shared.js";
import {
  approveMerchantCampaign,
  rejectMerchantCampaign,
  type MerchantCampaignDb
} from "./merchant-campaign.service.js";
import type { MerchantCampaignRecord } from "./merchant-campaign.serializer.js";
import {
  serializeCampaignPolicyCheck,
  serializeCampaignReviewDetail,
  serializeCampaignReviewQueue,
  type CampaignPolicyCheck,
  type MerchantCampaignReviewRecord
} from "./campaign-review.serializer.js";
import type {
  CampaignReviewDecisionInput,
  CampaignReviewQueueQueryInput,
  CampaignReviewRejectInput
} from "./campaign-review.validation.js";

export type CampaignReviewDb = MerchantCampaignDb & {
  merchantCampaignReview: {
    create(input: { data: Record<string, unknown> }): Promise<MerchantCampaignReviewRecord>;
    findMany(input?: Record<string, unknown>): Promise<MerchantCampaignReviewRecord[]>;
  };
};

const defaultClient = prisma as unknown as CampaignReviewDb;

async function ensureCampaign(campaignId: string, client: CampaignReviewDb) {
  const campaign = await client.merchantCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new HttpError(404, "MERCHANT_CAMPAIGN_NOT_FOUND");
  return campaign;
}

function check(key: string, passed: boolean, message: string) {
  return { key, passed, message };
}

export function evaluateCampaignPolicy(campaign: MerchantCampaignRecord): CampaignPolicyCheck {
  const checks = [
    check("no_prohibited_terms", !hasUnsafePublicText(`${campaign.title} ${campaign.description ?? ""}`), "Public text must avoid buyer PII, payment, sponsor, courier, or provider leakage."),
    check("safe_cta_url", isSafeInternalCtaUrl(campaign.ctaUrl), "CTA URL must be a safe internal Shipmastr path or empty."),
    check("clear_label", true, "Campaign cards use Merchant Offer labeling."),
    check("valid_campaign_dates", !(campaign.startsAt && campaign.endsAt && new Date(campaign.endsAt) <= new Date(campaign.startsAt)), "Campaign end date must be after start date."),
    check("public_safe_offer_card", !hasUnsafePublicText(campaign.ctaLabel), "CTA label must not include unsafe public text.")
  ];

  return {
    passed: checks.every((item) => item.passed),
    checks
  };
}

export async function listCampaignReviewQueue(
  query: CampaignReviewQueueQueryInput,
  client: CampaignReviewDb = defaultClient
) {
  const where = {
    reviewStatus: "PENDING",
    ...(cleanString(query.merchantId) ? { merchantId: cleanString(query.merchantId) } : {})
  };
  const [campaigns, total] = await Promise.all([
    client.merchantCampaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage
    }),
    client.merchantCampaign.count({ where })
  ]);

  return serializeCampaignReviewQueue({
    campaigns,
    total,
    page: query.page,
    perPage: query.perPage
  });
}

export async function getCampaignReviewDetail(
  campaignId: string,
  client: CampaignReviewDb = defaultClient
) {
  const campaign = await ensureCampaign(campaignId, client);
  const reviews = await client.merchantCampaignReview.findMany({
    where: { campaignId },
    orderBy: { createdAt: "desc" }
  });
  return serializeCampaignReviewDetail({ campaign, reviews });
}

export async function runCampaignPolicyCheck(
  campaignId: string,
  client: CampaignReviewDb = defaultClient
) {
  const campaign = await ensureCampaign(campaignId, client);
  return serializeCampaignPolicyCheck(evaluateCampaignPolicy(campaign));
}

export async function approveCampaignFromReview(
  campaignId: string,
  input: CampaignReviewDecisionInput,
  client: CampaignReviewDb = defaultClient
) {
  const policy = evaluateCampaignPolicy(await ensureCampaign(campaignId, client));
  if (!policy.passed) throw new HttpError(409, "MERCHANT_CAMPAIGN_POLICY_CHECK_FAILED", policy);
  return approveMerchantCampaign(campaignId, {
    ...input,
    policyChecklist: input.policyChecklist ?? policy
  }, client);
}

export async function rejectCampaignFromReview(
  campaignId: string,
  input: CampaignReviewRejectInput,
  client: CampaignReviewDb = defaultClient
) {
  const policy = evaluateCampaignPolicy(await ensureCampaign(campaignId, client));
  return rejectMerchantCampaign(campaignId, {
    ...input,
    reason: input.reason,
    policyChecklist: input.policyChecklist ?? policy
  }, client);
}
