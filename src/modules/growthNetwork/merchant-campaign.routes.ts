import { Router } from "express";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import { getCampaignAnalytics } from "./campaign-analytics.service.js";
import {
  activateMerchantCampaign,
  approveMerchantCampaign,
  archiveMerchantCampaign,
  createMerchantCampaign,
  getMerchantCampaignPerformanceSummary,
  listMerchantCampaigns,
  pauseMerchantCampaign,
  recordMerchantCampaignEvent,
  rejectMerchantCampaign,
  resolveMerchantCampaignCardsForSurface,
  submitMerchantCampaign,
  updateMerchantCampaign,
  type MerchantCampaignDb
} from "./merchant-campaign.service.js";
import {
  campaignDecisionSchema,
  campaignIdParamsSchema,
  campaignSurfaceParamsSchema,
  createMerchantCampaignSchema,
  listMerchantCampaignsQuerySchema,
  recordMerchantCampaignEventSchema,
  rejectCampaignSchema,
  resolveMerchantCampaignCardsQuerySchema,
  updateMerchantCampaignSchema
} from "./merchant-campaign.validation.js";

type MerchantCampaignRouterDeps = {
  client?: MerchantCampaignDb;
};

export function campaignAliases(record: Record<string, unknown>) {
  return {
    ...record,
    merchantId: record.merchantId ?? record.merchant_id,
    sellerId: record.sellerId ?? record.seller_id,
    campaignId: record.campaignId ?? record.campaign_id,
    campaignType: record.campaignType ?? record.campaign_type,
    ctaLabel: record.ctaLabel ?? record.cta_label,
    ctaUrl: record.ctaUrl ?? record.cta_url,
    rulesJson: record.rulesJson ?? record.rules_json,
    startsAt: record.startsAt ?? record.starts_at,
    endsAt: record.endsAt ?? record.ends_at,
    reviewerRef: record.reviewerRef ?? record.reviewer_ref,
    policyChecklist: record.policyChecklist ?? record.policy_checklist,
    eventType: record.eventType ?? record.event_type,
    growthOfferEventId: record.growthOfferEventId ?? record.growth_offer_event_id,
    perPage: record.perPage ?? record.per_page
  };
}

export function createMerchantCampaignRouter(deps: MerchantCampaignRouterDeps = {}) {
  const router = Router();
  const client = deps.client;

  router.post("/", async (req, res) => {
    const body = createMerchantCampaignSchema.parse(campaignAliases(req.body));
    const data = await createMerchantCampaign(body, client);
    return res.status(201).json(successEnvelope("Merchant campaign created.", data));
  });

  router.get("/", async (req, res) => {
    const query = listMerchantCampaignsQuerySchema.parse(campaignAliases(req.query));
    const data = await listMerchantCampaigns(query, client);
    return res.json(successEnvelope("Merchant campaigns fetched.", data));
  });

  router.patch("/:campaignId", async (req, res) => {
    const { campaignId } = campaignIdParamsSchema.parse(req.params);
    const body = updateMerchantCampaignSchema.parse(campaignAliases(req.body));
    const data = await updateMerchantCampaign(campaignId, body, client);
    return res.json(successEnvelope("Merchant campaign updated.", data));
  });

  router.post("/:campaignId/submit", async (req, res) => {
    const { campaignId } = campaignIdParamsSchema.parse(req.params);
    const data = await submitMerchantCampaign(campaignId, client);
    return res.json(successEnvelope("Merchant campaign submitted for review.", data));
  });

  router.post("/:campaignId/approve", async (req, res) => {
    const { campaignId } = campaignIdParamsSchema.parse(req.params);
    const body = campaignDecisionSchema.parse(campaignAliases(req.body));
    const data = await approveMerchantCampaign(campaignId, body, client);
    return res.json(successEnvelope("Merchant campaign approved.", data));
  });

  router.post("/:campaignId/reject", async (req, res) => {
    const { campaignId } = campaignIdParamsSchema.parse(req.params);
    const body = rejectCampaignSchema.parse(campaignAliases(req.body));
    const data = await rejectMerchantCampaign(campaignId, body, client);
    return res.json(successEnvelope("Merchant campaign rejected.", data));
  });

  router.post("/:campaignId/activate", async (req, res) => {
    const { campaignId } = campaignIdParamsSchema.parse(req.params);
    const data = await activateMerchantCampaign(campaignId, client);
    return res.json(successEnvelope("Merchant campaign activated.", data));
  });

  router.post("/:campaignId/pause", async (req, res) => {
    const { campaignId } = campaignIdParamsSchema.parse(req.params);
    const data = await pauseMerchantCampaign(campaignId, client);
    return res.json(successEnvelope("Merchant campaign paused.", data));
  });

  router.post("/:campaignId/archive", async (req, res) => {
    const { campaignId } = campaignIdParamsSchema.parse(req.params);
    const data = await archiveMerchantCampaign(campaignId, client);
    return res.json(successEnvelope("Merchant campaign archived.", data));
  });

  router.get("/placements/:surface/offers", async (req, res) => {
    const { surface } = campaignSurfaceParamsSchema.parse(req.params);
    const query = resolveMerchantCampaignCardsQuerySchema.parse(campaignAliases(req.query));
    const data = await resolveMerchantCampaignCardsForSurface(surface, query, client);
    return res.json(successEnvelope("Merchant campaign offer cards resolved.", data));
  });

  router.post("/events", async (req, res) => {
    const body = recordMerchantCampaignEventSchema.parse(campaignAliases(req.body));
    const data = await recordMerchantCampaignEvent(body, client);
    return res.status(201).json(successEnvelope("Merchant campaign event recorded.", data));
  });

  router.get("/:campaignId/performance-summary", async (req, res) => {
    const { campaignId } = campaignIdParamsSchema.parse(req.params);
    const data = await getMerchantCampaignPerformanceSummary(campaignId, client);
    return res.json(successEnvelope("Merchant campaign performance summary fetched.", data));
  });

  router.get("/:campaignId/analytics", async (req, res) => {
    const { campaignId } = campaignIdParamsSchema.parse(req.params);
    const data = await getCampaignAnalytics(campaignId, client);
    return res.json(successEnvelope("Merchant campaign analytics fetched.", data));
  });

  return router;
}
