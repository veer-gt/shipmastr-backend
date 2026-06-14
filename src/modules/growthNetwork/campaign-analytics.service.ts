import type { GrowthPlacementSurface, MerchantCampaignEventType } from "@prisma/client";

import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  cleanString,
  rate
} from "./growth-network-maturity.shared.js";
import type {
  MerchantCampaignDb
} from "./merchant-campaign.service.js";
import type {
  MerchantCampaignEventRecord,
  MerchantCampaignRecord
} from "./merchant-campaign.serializer.js";
import {
  serializeCampaignAnalytics,
  serializeCampaignAnalyticsSummary,
  serializeGroupedCampaignAnalytics,
  type CampaignMetricSummary
} from "./campaign-analytics.serializer.js";
import type { CampaignAnalyticsQueryInput } from "./campaign-analytics.validation.js";

export type CampaignAnalyticsDb = MerchantCampaignDb;

const defaultClient = prisma as unknown as CampaignAnalyticsDb;

function eventCounts(events: MerchantCampaignEventRecord[]): CampaignMetricSummary {
  const count = (eventType: MerchantCampaignEventType) => events.filter((event) => event.eventType === eventType).length;
  const impressions = count("IMPRESSION");
  const clicks = count("CLICK");
  const dismissals = count("DISMISS");
  const simulatedConversions = count("CONVERSION_SIMULATED");
  return {
    impressions,
    clicks,
    dismissals,
    simulatedConversions,
    ctr: rate(clicks, impressions),
    conversionRate: rate(simulatedConversions, clicks),
    dismissRate: rate(dismissals, impressions)
  };
}

function topCampaign(
  campaigns: MerchantCampaignRecord[],
  events: MerchantCampaignEventRecord[],
  eventType: MerchantCampaignEventType,
  outputKey: "clicks" | "simulatedConversions"
) {
  const byCampaign = new Map<string, number>();
  for (const event of events) {
    if (event.eventType !== eventType) continue;
    byCampaign.set(event.campaignId, (byCampaign.get(event.campaignId) ?? 0) + 1);
  }
  const [campaignId, count] = [...byCampaign.entries()].sort((left, right) => right[1] - left[1])[0] ?? [];
  if (!campaignId || !count) return null;
  const campaign = campaigns.find((item) => item.id === campaignId);
  return {
    campaignId,
    title: campaign?.title ?? "Campaign",
    [outputKey]: count
  };
}

async function campaignsFor(query: CampaignAnalyticsQueryInput, client: CampaignAnalyticsDb) {
  const merchantId = cleanString(query.merchantId);
  return client.merchantCampaign.findMany({
    where: merchantId ? { merchantId } : {},
    orderBy: { createdAt: "desc" }
  });
}

async function eventsForCampaigns(campaigns: MerchantCampaignRecord[], client: CampaignAnalyticsDb) {
  const ids = campaigns.map((campaign) => campaign.id);
  if (ids.length === 0) return [];
  return client.merchantCampaignEvent.findMany({
    where: { campaignId: { in: ids } }
  });
}

export async function getCampaignAnalyticsSummary(
  query: CampaignAnalyticsQueryInput,
  client: CampaignAnalyticsDb = defaultClient
) {
  const campaigns = await campaignsFor(query, client);
  const events = await eventsForCampaigns(campaigns, client);

  return serializeCampaignAnalyticsSummary({
    metrics: eventCounts(events),
    activeCampaigns: campaigns.filter((campaign) => campaign.status === "ACTIVE").length,
    pendingReviewCampaigns: campaigns.filter((campaign) => campaign.reviewStatus === "PENDING").length,
    pausedCampaigns: campaigns.filter((campaign) => campaign.status === "PAUSED").length,
    topCampaignByClicks: topCampaign(campaigns, events, "CLICK", "clicks") as { campaignId: string; title: string; clicks: number } | null,
    topCampaignBySimulatedConversion: topCampaign(campaigns, events, "CONVERSION_SIMULATED", "simulatedConversions") as { campaignId: string; title: string; simulatedConversions: number } | null
  });
}

export async function getCampaignAnalytics(
  campaignId: string,
  client: CampaignAnalyticsDb = defaultClient
) {
  const campaign = await client.merchantCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new HttpError(404, "MERCHANT_CAMPAIGN_NOT_FOUND");
  const events = await client.merchantCampaignEvent.findMany({ where: { campaignId } });
  return serializeCampaignAnalytics({
    campaignId,
    metrics: eventCounts(events)
  });
}

export async function getCampaignAnalyticsBySurface(
  query: CampaignAnalyticsQueryInput,
  client: CampaignAnalyticsDb = defaultClient
) {
  const campaigns = await campaignsFor(query, client);
  const events = await eventsForCampaigns(campaigns, client);
  const surfaces = new Map<string, MerchantCampaignEventRecord[]>();

  for (const event of events) {
    const surface = (event.surface ?? "UNKNOWN") as GrowthPlacementSurface | "UNKNOWN";
    surfaces.set(surface, [...(surfaces.get(surface) ?? []), event]);
  }

  return serializeGroupedCampaignAnalytics({
    groups: [...surfaces.entries()].map(([surface, rows]) => ({
      surface,
      metrics: eventCounts(rows)
    }))
  });
}

export async function getCampaignAnalyticsByType(
  query: CampaignAnalyticsQueryInput,
  client: CampaignAnalyticsDb = defaultClient
) {
  const campaigns = await campaignsFor(query, client);
  const events = await eventsForCampaigns(campaigns, client);
  const eventsByCampaign = new Map<string, MerchantCampaignEventRecord[]>();
  for (const event of events) {
    eventsByCampaign.set(event.campaignId, [...(eventsByCampaign.get(event.campaignId) ?? []), event]);
  }

  const byType = new Map<string, MerchantCampaignEventRecord[]>();
  for (const campaign of campaigns) {
    const rows = eventsByCampaign.get(campaign.id) ?? [];
    byType.set(campaign.campaignType, [...(byType.get(campaign.campaignType) ?? []), ...rows]);
  }

  return serializeGroupedCampaignAnalytics({
    groups: [...byType.entries()].map(([campaignType, rows]) => ({
      campaignType,
      metrics: eventCounts(rows)
    }))
  });
}
