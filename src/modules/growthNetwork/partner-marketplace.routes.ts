import { Router } from "express";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  addGrowthPartnerPlacement,
  captureGrowthPartnerLead,
  createGrowthPartner,
  getGrowthPartnerPerformanceSummary,
  listGrowthPartners,
  recordGrowthPartnerAttributionEvent,
  resolvePublicGrowthPartnerSuggestions,
  updateGrowthPartnerStatus,
  type PartnerMarketplaceDb
} from "./partner-marketplace.service.js";
import {
  captureGrowthPartnerLeadSchema,
  createGrowthPartnerPlacementSchema,
  createGrowthPartnerSchema,
  listGrowthPartnersQuerySchema,
  partnerIdParamsSchema,
  partnerSuggestionSurfaceParamsSchema,
  recordGrowthPartnerAttributionEventSchema,
  resolveGrowthPartnerSuggestionsQuerySchema,
  updateGrowthPartnerStatusSchema
} from "./partner-marketplace.validation.js";

type PartnerMarketplaceRouterDeps = {
  client?: PartnerMarketplaceDb;
};

function withAliases(record: Record<string, unknown>) {
  return {
    ...record,
    displayName: record.displayName ?? record.display_name,
    websiteUrl: record.websiteUrl ?? record.website_url,
    isSponsored: record.isSponsored ?? record.is_sponsored,
    offerId: record.offerId ?? record.offer_id,
    partnerId: record.partnerId ?? record.partner_id,
    leadId: record.leadId ?? record.lead_id,
    merchantId: record.merchantId ?? record.merchant_id,
    sellerId: record.sellerId ?? record.seller_id,
    shipmentId: record.shipmentId ?? record.shipment_id,
    orderId: record.orderId ?? record.order_id,
    sourceSurface: record.sourceSurface ?? record.source_surface,
    attributionRef: record.attributionRef ?? record.attribution_ref,
    sessionRef: record.sessionRef ?? record.session_ref,
    eventType: record.eventType ?? record.event_type,
    idempotencyKey: record.idempotencyKey ?? record.idempotency_key,
    rulesJson: record.rulesJson ?? record.rules_json,
    startsAt: record.startsAt ?? record.starts_at,
    endsAt: record.endsAt ?? record.ends_at,
    perPage: record.perPage ?? record.per_page
  };
}

export function createPartnerMarketplaceRouter(deps: PartnerMarketplaceRouterDeps = {}) {
  const router = Router();
  const client = deps.client;

  router.post("/", async (req, res) => {
    const body = createGrowthPartnerSchema.parse(withAliases(req.body));
    const data = await createGrowthPartner(body, client);
    return res.status(201).json(successEnvelope("Growth partner created.", data));
  });

  router.get("/", async (req, res) => {
    const query = listGrowthPartnersQuerySchema.parse(withAliases(req.query));
    const data = await listGrowthPartners(query, client);
    return res.json(successEnvelope("Growth partners fetched.", data));
  });

  router.patch("/:partnerId/status", async (req, res) => {
    const { partnerId } = partnerIdParamsSchema.parse(req.params);
    const body = updateGrowthPartnerStatusSchema.parse(withAliases(req.body));
    const data = await updateGrowthPartnerStatus(partnerId, body, client);
    return res.json(successEnvelope("Growth partner status updated.", data));
  });

  router.post("/:partnerId/placements", async (req, res) => {
    const { partnerId } = partnerIdParamsSchema.parse(req.params);
    const body = createGrowthPartnerPlacementSchema.parse(withAliases(req.body));
    const data = await addGrowthPartnerPlacement(partnerId, body, client);
    return res.status(201).json(successEnvelope("Growth partner placement created.", data));
  });

  router.get("/placements/:surface/suggestions", async (req, res) => {
    const { surface } = partnerSuggestionSurfaceParamsSchema.parse(req.params);
    const query = resolveGrowthPartnerSuggestionsQuerySchema.parse(withAliases(req.query));
    const data = await resolvePublicGrowthPartnerSuggestions(surface, query, client);
    return res.json(successEnvelope("Growth partner suggestions resolved.", data));
  });

  router.post("/leads", async (req, res) => {
    const body = captureGrowthPartnerLeadSchema.parse(withAliases(req.body));
    const data = await captureGrowthPartnerLead(body, client);
    return res.status(201).json(successEnvelope("Growth partner lead captured.", data));
  });

  router.post("/attribution-events", async (req, res) => {
    const body = recordGrowthPartnerAttributionEventSchema.parse(withAliases(req.body));
    const data = await recordGrowthPartnerAttributionEvent(body, client);
    return res.status(201).json(successEnvelope("Growth partner attribution event recorded.", data));
  });

  router.get("/:partnerId/performance-summary", async (req, res) => {
    const { partnerId } = partnerIdParamsSchema.parse(req.params);
    const data = await getGrowthPartnerPerformanceSummary(partnerId, client);
    return res.json(successEnvelope("Growth partner performance summary fetched.", data));
  });

  return router;
}
