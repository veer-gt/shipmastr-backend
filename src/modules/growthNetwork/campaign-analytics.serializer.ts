export type CampaignMetricSummary = {
  impressions: number;
  clicks: number;
  dismissals: number;
  simulatedConversions: number;
  leadsCaptured?: number;
  ctr: number;
  conversionRate: number;
  dismissRate: number;
  leadConversionRate?: number;
};

export function serializeCampaignAnalyticsSummary(input: {
  metrics: CampaignMetricSummary;
  activeCampaigns: number;
  pendingReviewCampaigns: number;
  pausedCampaigns: number;
  topCampaignByClicks: { campaignId: string; title: string; clicks: number } | null;
  topCampaignBySimulatedConversion: { campaignId: string; title: string; simulatedConversions: number } | null;
}) {
  return {
    ...input,
    revenueMode: "none",
    roasMode: "not_calculated",
    billingMode: "none"
  };
}

export function serializeCampaignAnalytics(input: {
  campaignId: string;
  metrics: CampaignMetricSummary;
}) {
  return {
    ...input,
    revenueMode: "none",
    roasMode: "not_calculated",
    billingMode: "none"
  };
}

export function serializeGroupedCampaignAnalytics(input: {
  groups: Array<Record<string, unknown>>;
}) {
  return {
    groups: input.groups,
    revenueMode: "none",
    roasMode: "not_calculated",
    billingMode: "none"
  };
}
