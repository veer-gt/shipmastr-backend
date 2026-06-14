import { Router } from "express";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  approveCampaignFromReview,
  getCampaignReviewDetail,
  listCampaignReviewQueue,
  rejectCampaignFromReview,
  runCampaignPolicyCheck,
  type CampaignReviewDb
} from "./campaign-review.service.js";
import {
  campaignReviewDecisionSchema,
  campaignReviewParamsSchema,
  campaignReviewQueueQuerySchema,
  campaignReviewRejectSchema
} from "./campaign-review.validation.js";
import { campaignAliases } from "./merchant-campaign.routes.js";

type CampaignReviewRouterDeps = {
  client?: CampaignReviewDb;
};

export function createCampaignReviewRouter(deps: CampaignReviewRouterDeps = {}) {
  const router = Router();
  const client = deps.client;

  router.get("/review-queue", async (req, res) => {
    const query = campaignReviewQueueQuerySchema.parse(campaignAliases(req.query));
    const data = await listCampaignReviewQueue(query, client);
    return res.json(successEnvelope("Campaign review queue fetched.", data));
  });

  router.get("/:campaignId", async (req, res) => {
    const { campaignId } = campaignReviewParamsSchema.parse(req.params);
    const data = await getCampaignReviewDetail(campaignId, client);
    return res.json(successEnvelope("Campaign review detail fetched.", data));
  });

  router.post("/:campaignId/approve", async (req, res) => {
    const { campaignId } = campaignReviewParamsSchema.parse(req.params);
    const body = campaignReviewDecisionSchema.parse(campaignAliases(req.body));
    const data = await approveCampaignFromReview(campaignId, body, client);
    return res.json(successEnvelope("Campaign approved.", data));
  });

  router.post("/:campaignId/reject", async (req, res) => {
    const { campaignId } = campaignReviewParamsSchema.parse(req.params);
    const body = campaignReviewRejectSchema.parse(campaignAliases(req.body));
    const data = await rejectCampaignFromReview(campaignId, body, client);
    return res.json(successEnvelope("Campaign rejected.", data));
  });

  router.post("/:campaignId/policy-check", async (req, res) => {
    const { campaignId } = campaignReviewParamsSchema.parse(req.params);
    const data = await runCampaignPolicyCheck(campaignId, client);
    return res.json(successEnvelope("Campaign policy check complete.", data));
  });

  return router;
}
