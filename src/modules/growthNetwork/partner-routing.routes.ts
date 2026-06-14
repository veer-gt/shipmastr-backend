import { Router } from "express";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import { campaignAliases } from "./merchant-campaign.routes.js";
import {
  createPartnerLeadConsent,
  createPartnerLeadRoutingIntent,
  getPartnerLeadConsent,
  getPartnerLeadRoutingIntent,
  getPartnerLeadRoutingReadiness,
  listPartnerLeadConsents,
  listPartnerLeadRoutingIntents,
  simulatePartnerLeadRouting,
  updatePartnerLeadConsentStatus,
  type PartnerRoutingDb
} from "./partner-routing.service.js";
import {
  consentIdParamsSchema,
  createPartnerLeadConsentSchema,
  createPartnerLeadRoutingIntentSchema,
  listPartnerLeadConsentsQuerySchema,
  listPartnerLeadRoutingIntentsQuerySchema,
  routingIntentIdParamsSchema,
  simulatePartnerLeadRoutingSchema,
  updatePartnerLeadConsentStatusSchema
} from "./partner-routing.validation.js";

type PartnerRoutingRouterDeps = {
  client?: PartnerRoutingDb;
};

function partnerRoutingAliases(record: Record<string, unknown>) {
  return {
    ...campaignAliases(record),
    partnerId: record.partnerId ?? record.partner_id,
    leadId: record.leadId ?? record.lead_id,
    consentId: record.consentId ?? record.consent_id,
    consentStatus: record.consentStatus ?? record.consent_status,
    consentScope: record.consentScope ?? record.consent_scope,
    consentText: record.consentText ?? record.consent_text,
    grantedAt: record.grantedAt ?? record.granted_at,
    revokedAt: record.revokedAt ?? record.revoked_at,
    expiresAt: record.expiresAt ?? record.expires_at,
    routingStatus: record.routingStatus ?? record.routing_status,
    routingSnapshot: record.routingSnapshot ?? record.routing_snapshot,
    idempotencyKey: record.idempotencyKey ?? record.idempotency_key
  };
}

export function createPartnerRoutingRouter(deps: PartnerRoutingRouterDeps = {}) {
  const router = Router();
  const client = deps.client;

  router.post("/lead-consents", async (req, res) => {
    const body = createPartnerLeadConsentSchema.parse(partnerRoutingAliases(req.body));
    const data = await createPartnerLeadConsent(body, client);
    return res.status(201).json(successEnvelope("Partner lead consent recorded.", data));
  });

  router.get("/lead-consents", async (req, res) => {
    const query = listPartnerLeadConsentsQuerySchema.parse(partnerRoutingAliases(req.query));
    const data = await listPartnerLeadConsents(query, client);
    return res.json(successEnvelope("Partner lead consents fetched.", data));
  });

  router.get("/lead-consents/:consentId", async (req, res) => {
    const { consentId } = consentIdParamsSchema.parse(partnerRoutingAliases(req.params));
    const data = await getPartnerLeadConsent(consentId, client);
    return res.json(successEnvelope("Partner lead consent fetched.", data));
  });

  router.patch("/lead-consents/:consentId/status", async (req, res) => {
    const { consentId } = consentIdParamsSchema.parse(partnerRoutingAliases(req.params));
    const body = updatePartnerLeadConsentStatusSchema.parse(partnerRoutingAliases(req.body));
    const data = await updatePartnerLeadConsentStatus(consentId, body, client);
    return res.json(successEnvelope("Partner lead consent status updated.", data));
  });

  router.post("/routing-intents", async (req, res) => {
    const body = createPartnerLeadRoutingIntentSchema.parse(partnerRoutingAliases(req.body));
    const data = await createPartnerLeadRoutingIntent(body, client);
    return res.status(201).json(successEnvelope("Partner lead routing intent created.", data));
  });

  router.get("/routing-intents", async (req, res) => {
    const query = listPartnerLeadRoutingIntentsQuerySchema.parse(partnerRoutingAliases(req.query));
    const data = await listPartnerLeadRoutingIntents(query, client);
    return res.json(successEnvelope("Partner lead routing intents fetched.", data));
  });

  router.get("/routing-intents/:intentId", async (req, res) => {
    const { intentId } = routingIntentIdParamsSchema.parse(partnerRoutingAliases(req.params));
    const data = await getPartnerLeadRoutingIntent(intentId, client);
    return res.json(successEnvelope("Partner lead routing intent fetched.", data));
  });

  router.get("/routing-intents/:intentId/readiness", async (req, res) => {
    const { intentId } = routingIntentIdParamsSchema.parse(partnerRoutingAliases(req.params));
    const data = await getPartnerLeadRoutingReadiness(intentId, client);
    return res.json(successEnvelope("Partner lead routing readiness fetched.", data));
  });

  router.post("/routing-intents/:intentId/simulate-route", async (req, res) => {
    const { intentId } = routingIntentIdParamsSchema.parse(partnerRoutingAliases(req.params));
    const body = simulatePartnerLeadRoutingSchema.parse(partnerRoutingAliases(req.body));
    const data = await simulatePartnerLeadRouting(intentId, body, client);
    return res.json(successEnvelope("Partner lead routing simulated.", data));
  });

  return router;
}
