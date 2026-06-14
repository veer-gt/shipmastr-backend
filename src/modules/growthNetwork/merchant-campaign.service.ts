import type {
  GrowthPlacementSurface,
  MerchantCampaignEventType,
  MerchantCampaignReviewStatus,
  MerchantCampaignStatus,
  MerchantCampaignType
} from "@prisma/client";

import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import type { GrowthNetworkDb } from "./growth-network.service.js";
import {
  activeDateWhere,
  cleanString,
  dateIsLive,
  rate,
  safeInternalCtaUrl,
  toStoredJson
} from "./growth-network-maturity.shared.js";
import {
  serializeMerchantCampaign,
  serializeMerchantCampaignEvent,
  serializeMerchantCampaignPerformanceSummary,
  serializePublicMerchantCampaignCard,
  type MerchantCampaignEventRecord,
  type MerchantCampaignRecord
} from "./merchant-campaign.serializer.js";
import { campaignTypeToGrowthOfferType } from "./merchant-campaign.types.js";
import type {
  CampaignDecisionInput,
  CreateMerchantCampaignInput,
  ListMerchantCampaignsQueryInput,
  RecordMerchantCampaignEventInput,
  RejectCampaignInput,
  ResolveMerchantCampaignCardsQueryInput,
  UpdateMerchantCampaignInput
} from "./merchant-campaign.validation.js";

type MerchantCampaignReviewRecord = {
  id: string;
  campaignId: string;
  reviewerRef?: string | null;
  reviewStatus: MerchantCampaignReviewStatus;
  decisionReason?: string | null;
  policyChecklist?: unknown;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
};

export type MerchantCampaignDb = {
  growthOffer?: GrowthNetworkDb["growthOffer"];
  growthOfferPlacement?: GrowthNetworkDb["growthOfferPlacement"];
  merchantCampaign: {
    create(input: { data: Record<string, unknown> }): Promise<MerchantCampaignRecord>;
    findMany(input?: Record<string, unknown>): Promise<MerchantCampaignRecord[]>;
    findUnique(input: { where: Record<string, unknown> }): Promise<MerchantCampaignRecord | null>;
    update(input: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<MerchantCampaignRecord>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
  merchantCampaignEvent: {
    create(input: { data: Record<string, unknown> }): Promise<MerchantCampaignEventRecord>;
    findMany(input?: Record<string, unknown>): Promise<MerchantCampaignEventRecord[]>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
  merchantCampaignReview?: {
    create(input: { data: Record<string, unknown> }): Promise<MerchantCampaignReviewRecord>;
    findMany(input?: Record<string, unknown>): Promise<MerchantCampaignReviewRecord[]>;
  };
};

const defaultClient = prisma as unknown as MerchantCampaignDb;

function safeCtaOrThrow(value: string | null | undefined) {
  const text = cleanString(value);
  if (!text) return null;
  const safe = safeInternalCtaUrl(text);
  if (!safe) throw new HttpError(400, "MERCHANT_CAMPAIGN_UNSAFE_CTA_URL");
  return safe;
}

async function ensureCampaign(campaignId: string, client: MerchantCampaignDb) {
  const campaign = await client.merchantCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new HttpError(404, "MERCHANT_CAMPAIGN_NOT_FOUND");
  return campaign;
}

async function appendCampaignEvent(
  campaign: MerchantCampaignRecord,
  eventType: MerchantCampaignEventType,
  client: MerchantCampaignDb,
  metadata?: Record<string, unknown>
) {
  await client.merchantCampaignEvent.create({
    data: {
      campaignId: campaign.id,
      merchantId: campaign.merchantId,
      eventType,
      surface: campaign.surface,
      metadata: toStoredJson(metadata)
    }
  });
}

function editableData(input: UpdateMerchantCampaignInput) {
  const data: Record<string, unknown> = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = cleanString(input.description);
  if (input.campaignType !== undefined) data.campaignType = input.campaignType;
  if (input.surface !== undefined) data.surface = input.surface;
  if (input.startsAt !== undefined) data.startsAt = input.startsAt ?? null;
  if (input.endsAt !== undefined) data.endsAt = input.endsAt ?? null;
  if (input.ctaLabel !== undefined) data.ctaLabel = input.ctaLabel;
  if (input.ctaUrl !== undefined) data.ctaUrl = safeCtaOrThrow(input.ctaUrl);
  if (input.rulesJson !== undefined) data.rulesJson = toStoredJson(input.rulesJson);
  if (input.metadata !== undefined) data.metadata = toStoredJson(input.metadata);
  return data;
}

async function createActivationOffer(campaign: MerchantCampaignRecord, client: MerchantCampaignDb) {
  if (!client.growthOffer || !client.growthOfferPlacement || campaign.growthOfferId) return campaign.growthOfferId ?? null;

  const offer = await client.growthOffer.create({
    data: {
      merchantId: campaign.merchantId,
      title: campaign.title,
      description: campaign.description ?? null,
      type: campaignTypeToGrowthOfferType(campaign.campaignType),
      status: "ACTIVE",
      isSponsored: false,
      sponsorName: null,
      ctaLabel: campaign.ctaLabel,
      ctaUrl: safeInternalCtaUrl(campaign.ctaUrl),
      metadata: toStoredJson({
        source: "merchant_campaign_builder",
        merchantCampaignId: campaign.id
      }),
      startsAt: campaign.startsAt ?? null,
      endsAt: campaign.endsAt ?? null
    }
  });

  await client.growthOfferPlacement.create({
    data: {
      offerId: offer.id,
      surface: campaign.surface,
      priority: 100,
      rulesJson: toStoredJson({ source: "merchant_campaign_builder", campaignId: campaign.id })
    }
  });

  return offer.id;
}

async function updateLinkedOfferStatus(
  campaign: MerchantCampaignRecord,
  status: "ACTIVE" | "PAUSED" | "ARCHIVED",
  client: MerchantCampaignDb
) {
  if (!campaign.growthOfferId || !client.growthOffer) return;
  await client.growthOffer.update({
    where: { id: campaign.growthOfferId },
    data: { status }
  });
}

export async function createMerchantCampaign(
  input: CreateMerchantCampaignInput,
  client: MerchantCampaignDb = defaultClient
) {
  const campaign = await client.merchantCampaign.create({
    data: {
      merchantId: input.merchantId,
      title: input.title,
      description: cleanString(input.description),
      campaignType: input.campaignType,
      status: "DRAFT",
      reviewStatus: "NOT_REQUIRED",
      surface: input.surface,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      ctaLabel: input.ctaLabel,
      ctaUrl: safeCtaOrThrow(input.ctaUrl),
      rulesJson: toStoredJson(input.rulesJson),
      metadata: toStoredJson(input.metadata)
    }
  });
  await appendCampaignEvent(campaign, "CREATED", client);
  return serializeMerchantCampaign(campaign);
}

export async function listMerchantCampaigns(
  query: ListMerchantCampaignsQueryInput,
  client: MerchantCampaignDb = defaultClient
) {
  const where = {
    ...(cleanString(query.merchantId) ? { merchantId: cleanString(query.merchantId) } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.campaignType ? { campaignType: query.campaignType } : {})
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

  return {
    campaigns: campaigns.map(serializeMerchantCampaign),
    pagination: {
      page: query.page,
      perPage: query.perPage,
      total,
      hasMore: query.page * query.perPage < total
    }
  };
}

export async function updateMerchantCampaign(
  campaignId: string,
  input: UpdateMerchantCampaignInput,
  client: MerchantCampaignDb = defaultClient
) {
  const campaign = await ensureCampaign(campaignId, client);
  if (campaign.status !== "DRAFT" && campaign.status !== "PENDING_REVIEW") {
    throw new HttpError(409, "MERCHANT_CAMPAIGN_NOT_EDITABLE");
  }

  const updated = await client.merchantCampaign.update({
    where: { id: campaignId },
    data: {
      ...editableData(input),
      ...(campaign.status === "PENDING_REVIEW" ? { reviewStatus: "PENDING" } : {})
    }
  });
  await appendCampaignEvent(updated, "UPDATED", client);
  return serializeMerchantCampaign(updated);
}

export async function submitMerchantCampaign(
  campaignId: string,
  client: MerchantCampaignDb = defaultClient
) {
  const campaign = await ensureCampaign(campaignId, client);
  if (campaign.status !== "DRAFT") throw new HttpError(409, "MERCHANT_CAMPAIGN_NOT_SUBMITTABLE");

  const updated = await client.merchantCampaign.update({
    where: { id: campaignId },
    data: { status: "PENDING_REVIEW", reviewStatus: "PENDING", rejectionReason: null }
  });
  await appendCampaignEvent(updated, "SUBMITTED", client);
  return serializeMerchantCampaign(updated);
}

export async function approveMerchantCampaign(
  campaignId: string,
  input: CampaignDecisionInput,
  client: MerchantCampaignDb = defaultClient
) {
  const campaign = await ensureCampaign(campaignId, client);
  if (campaign.status === "REJECTED" || campaign.status === "ARCHIVED") {
    throw new HttpError(409, "MERCHANT_CAMPAIGN_NOT_APPROVABLE");
  }

  const updated = await client.merchantCampaign.update({
    where: { id: campaignId },
    data: { reviewStatus: "APPROVED", rejectionReason: null }
  });
  if (client.merchantCampaignReview) {
    await client.merchantCampaignReview.create({
      data: {
        campaignId,
        reviewerRef: cleanString(input.reviewerRef),
        reviewStatus: "APPROVED",
        decisionReason: cleanString(input.reason),
        policyChecklist: toStoredJson(input.policyChecklist)
      }
    });
  }
  await appendCampaignEvent(updated, "APPROVED", client);
  return serializeMerchantCampaign(updated);
}

export async function rejectMerchantCampaign(
  campaignId: string,
  input: RejectCampaignInput,
  client: MerchantCampaignDb = defaultClient
) {
  const campaign = await ensureCampaign(campaignId, client);
  if (campaign.status === "ACTIVE") throw new HttpError(409, "MERCHANT_CAMPAIGN_ACTIVE_REJECTION_BLOCKED");

  const updated = await client.merchantCampaign.update({
    where: { id: campaignId },
    data: {
      status: "REJECTED",
      reviewStatus: "REJECTED",
      rejectionReason: cleanString(input.reason)
    }
  });
  if (client.merchantCampaignReview) {
    await client.merchantCampaignReview.create({
      data: {
        campaignId,
        reviewerRef: cleanString(input.reviewerRef),
        reviewStatus: "REJECTED",
        decisionReason: cleanString(input.reason),
        policyChecklist: toStoredJson(input.policyChecklist)
      }
    });
  }
  await appendCampaignEvent(updated, "REJECTED", client);
  return serializeMerchantCampaign(updated);
}

export async function activateMerchantCampaign(
  campaignId: string,
  client: MerchantCampaignDb = defaultClient
) {
  const campaign = await ensureCampaign(campaignId, client);
  if (campaign.status === "REJECTED") throw new HttpError(409, "MERCHANT_CAMPAIGN_REJECTED");
  if (campaign.reviewStatus !== "APPROVED") throw new HttpError(409, "MERCHANT_CAMPAIGN_REVIEW_NOT_APPROVED");
  const growthOfferId = await createActivationOffer(campaign, client);

  const updated = await client.merchantCampaign.update({
    where: { id: campaignId },
    data: {
      status: "ACTIVE",
      ...(growthOfferId ? { growthOfferId } : {})
    }
  });
  await appendCampaignEvent(updated, "ACTIVATED", client);
  return serializeMerchantCampaign(updated);
}

export async function pauseMerchantCampaign(
  campaignId: string,
  client: MerchantCampaignDb = defaultClient
) {
  const campaign = await ensureCampaign(campaignId, client);
  if (campaign.status !== "ACTIVE") throw new HttpError(409, "MERCHANT_CAMPAIGN_NOT_ACTIVE");
  await updateLinkedOfferStatus(campaign, "PAUSED", client);
  const updated = await client.merchantCampaign.update({
    where: { id: campaignId },
    data: { status: "PAUSED" }
  });
  await appendCampaignEvent(updated, "PAUSED", client);
  return serializeMerchantCampaign(updated);
}

export async function archiveMerchantCampaign(
  campaignId: string,
  client: MerchantCampaignDb = defaultClient
) {
  const campaign = await ensureCampaign(campaignId, client);
  await updateLinkedOfferStatus(campaign, "ARCHIVED", client);
  const updated = await client.merchantCampaign.update({
    where: { id: campaignId },
    data: { status: "ARCHIVED" }
  });
  await appendCampaignEvent(updated, "ARCHIVED", client);
  return serializeMerchantCampaign(updated);
}

export async function resolveMerchantCampaignCardsForSurface(
  surface: GrowthPlacementSurface,
  query: ResolveMerchantCampaignCardsQueryInput,
  client: MerchantCampaignDb = defaultClient,
  now = new Date()
) {
  const campaigns = await client.merchantCampaign.findMany({
    where: {
      status: "ACTIVE",
      reviewStatus: "APPROVED",
      surface,
      ...(cleanString(query.merchantId) ? { merchantId: cleanString(query.merchantId) } : {}),
      AND: activeDateWhere(now)
    },
    orderBy: { createdAt: "desc" }
  });

  return {
    surface,
    offers: campaigns
      .filter((campaign) => dateIsLive(campaign.startsAt, campaign.endsAt, now))
      .slice(0, query.max)
      .map((campaign) => serializePublicMerchantCampaignCard(campaign, surface))
  };
}

export async function recordMerchantCampaignEvent(
  input: RecordMerchantCampaignEventInput,
  client: MerchantCampaignDb = defaultClient
) {
  const campaign = await ensureCampaign(input.campaignId, client);
  const event = await client.merchantCampaignEvent.create({
    data: {
      campaignId: campaign.id,
      merchantId: cleanString(input.merchantId) ?? campaign.merchantId,
      sellerId: cleanString(input.sellerId),
      eventType: input.eventType,
      surface: input.surface ?? campaign.surface,
      growthOfferEventId: cleanString(input.growthOfferEventId),
      metadata: toStoredJson(input.metadata)
    }
  });
  return serializeMerchantCampaignEvent(event);
}

export async function getMerchantCampaignPerformanceSummary(
  campaignId: string,
  client: MerchantCampaignDb = defaultClient
) {
  await ensureCampaign(campaignId, client);
  const [impressions, clicks, dismissals, simulatedConversions] = await Promise.all([
    client.merchantCampaignEvent.count({ where: { campaignId, eventType: "IMPRESSION" } }),
    client.merchantCampaignEvent.count({ where: { campaignId, eventType: "CLICK" } }),
    client.merchantCampaignEvent.count({ where: { campaignId, eventType: "DISMISS" } }),
    client.merchantCampaignEvent.count({ where: { campaignId, eventType: "CONVERSION_SIMULATED" } })
  ]);

  return serializeMerchantCampaignPerformanceSummary({
    campaignId,
    impressions,
    clicks,
    dismissals,
    simulatedConversions,
    ctr: rate(clicks, impressions),
    conversionRate: rate(simulatedConversions, clicks),
    dismissRate: rate(dismissals, impressions)
  });
}
