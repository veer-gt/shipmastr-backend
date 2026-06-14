import { Router } from "express";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import { campaignAliases } from "./merchant-campaign.routes.js";
import {
  checkBillingReadiness,
  createBillingSimulationEvent,
  getBillingReadinessProfile,
  listBillingReadinessProfiles,
  listBillingSimulationEvents,
  updateBillingReadinessProfileStatus,
  upsertBillingReadinessProfile,
  type BillingReadinessDb
} from "./billing-readiness.service.js";
import {
  billingReadinessProfileIdParamsSchema,
  createBillingSimulationEventSchema,
  listBillingReadinessProfilesQuerySchema,
  listBillingSimulationEventsQuerySchema,
  updateBillingReadinessProfileStatusSchema,
  upsertBillingReadinessProfileSchema
} from "./billing-readiness.validation.js";

type BillingReadinessRouterDeps = {
  client?: BillingReadinessDb;
};

function billingAliases(record: Record<string, unknown>) {
  return {
    ...campaignAliases(record),
    partnerId: record.partnerId ?? record.partner_id,
    leadId: record.leadId ?? record.lead_id,
    profileId: record.profileId ?? record.profile_id,
    readinessStatus: record.readinessStatus ?? record.readiness_status,
    legalReviewRef: record.legalReviewRef ?? record.legal_review_ref,
    financeReviewRef: record.financeReviewRef ?? record.finance_review_ref,
    amountPaise: record.amountPaise ?? record.amount_paise,
    eventType: record.eventType ?? record.event_type,
    simulationSnapshot: record.simulationSnapshot ?? record.simulation_snapshot
  };
}

export function createBillingReadinessRouter(deps: BillingReadinessRouterDeps = {}) {
  const router = Router();
  const client = deps.client;

  router.post("/profiles", async (req, res) => {
    const body = upsertBillingReadinessProfileSchema.parse(billingAliases(req.body));
    const data = await upsertBillingReadinessProfile(body, client);
    return res.status(201).json(successEnvelope("Growth billing readiness profile saved.", data));
  });

  router.get("/profiles", async (req, res) => {
    const query = listBillingReadinessProfilesQuerySchema.parse(billingAliases(req.query));
    const data = await listBillingReadinessProfiles(query, client);
    return res.json(successEnvelope("Growth billing readiness profiles fetched.", data));
  });

  router.get("/check", async (req, res) => {
    const query = listBillingReadinessProfilesQuerySchema.pick({
      merchantId: true,
      partnerId: true
    }).parse(billingAliases(req.query));
    const data = await checkBillingReadiness(query, client);
    return res.json(successEnvelope("Growth billing readiness checked.", data));
  });

  router.get("/profiles/:profileId", async (req, res) => {
    const { profileId } = billingReadinessProfileIdParamsSchema.parse(billingAliases(req.params));
    const data = await getBillingReadinessProfile(profileId, client);
    return res.json(successEnvelope("Growth billing readiness profile fetched.", data));
  });

  router.patch("/profiles/:profileId/status", async (req, res) => {
    const { profileId } = billingReadinessProfileIdParamsSchema.parse(billingAliases(req.params));
    const body = updateBillingReadinessProfileStatusSchema.parse(billingAliases(req.body));
    const data = await updateBillingReadinessProfileStatus(profileId, body, client);
    return res.json(successEnvelope("Growth billing readiness profile updated.", data));
  });

  router.post("/simulation-events", async (req, res) => {
    const body = createBillingSimulationEventSchema.parse(billingAliases(req.body));
    const data = await createBillingSimulationEvent(body, client);
    return res.status(201).json(successEnvelope("Growth billing simulation event recorded.", data));
  });

  router.get("/simulation-events", async (req, res) => {
    const query = listBillingSimulationEventsQuerySchema.parse(billingAliases(req.query));
    const data = await listBillingSimulationEvents(query, client);
    return res.json(successEnvelope("Growth billing simulation events fetched.", data));
  });

  return router;
}
