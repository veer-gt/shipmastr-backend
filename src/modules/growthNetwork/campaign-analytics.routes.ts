import { Router } from "express";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  getCampaignAnalyticsBySurface,
  getCampaignAnalyticsByType,
  getCampaignAnalyticsSummary,
  type CampaignAnalyticsDb
} from "./campaign-analytics.service.js";
import { campaignAliases } from "./merchant-campaign.routes.js";
import { campaignAnalyticsQuerySchema } from "./campaign-analytics.validation.js";

type CampaignAnalyticsRouterDeps = {
  client?: CampaignAnalyticsDb;
};

export function createCampaignAnalyticsRouter(deps: CampaignAnalyticsRouterDeps = {}) {
  const router = Router();
  const client = deps.client;

  router.get("/summary", async (req, res) => {
    const query = campaignAnalyticsQuerySchema.parse(campaignAliases(req.query));
    const data = await getCampaignAnalyticsSummary(query, client);
    return res.json(successEnvelope("Merchant campaign analytics summary fetched.", data));
  });

  router.get("/by-surface", async (req, res) => {
    const query = campaignAnalyticsQuerySchema.parse(campaignAliases(req.query));
    const data = await getCampaignAnalyticsBySurface(query, client);
    return res.json(successEnvelope("Merchant campaign analytics by surface fetched.", data));
  });

  router.get("/by-type", async (req, res) => {
    const query = campaignAnalyticsQuerySchema.parse(campaignAliases(req.query));
    const data = await getCampaignAnalyticsByType(query, client);
    return res.json(successEnvelope("Merchant campaign analytics by type fetched.", data));
  });

  return router;
}
