import { Router } from "express";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  addGrowthOfferPlacement,
  createGrowthOffer,
  listGrowthOffers,
  recordGrowthEvent,
  recordTrackingPageView,
  resolvePublicGrowthOffersForSurface,
  updateGrowthOfferStatus,
  type GrowthNetworkDb
} from "./growth-network.service.js";
import {
  createGrowthOfferPlacementSchema,
  createGrowthOfferSchema,
  listGrowthOffersQuerySchema,
  offerIdParamsSchema,
  recordOfferEventSchema,
  recordTrackingPageViewSchema,
  resolveGrowthOffersQuerySchema,
  surfaceParamsSchema,
  updateGrowthOfferStatusSchema
} from "./growth-network.validation.js";

type GrowthNetworkRouterDeps = {
  client?: GrowthNetworkDb;
};

function queryWithAliases(query: Record<string, unknown>) {
  return {
    ...query,
    merchantId: query.merchantId ?? query.merchant_id,
    sellerId: query.sellerId ?? query.seller_id,
    shipmentId: query.shipmentId ?? query.shipment_id,
    orderId: query.orderId ?? query.order_id,
    anonymousBuyerRef: query.anonymousBuyerRef ?? query.anonymous_buyer_ref,
    sessionRef: query.sessionRef ?? query.session_ref,
    perPage: query.perPage ?? query.per_page
  };
}

export function createGrowthNetworkRouter(deps: GrowthNetworkRouterDeps = {}) {
  const router = Router();
  const client = deps.client;

  router.post("/offers", async (req, res) => {
    const body = createGrowthOfferSchema.parse(req.body);
    const data = await createGrowthOffer(body, client);
    return res.status(201).json(successEnvelope("Growth offer created.", data));
  });

  router.get("/offers", async (req, res) => {
    const query = listGrowthOffersQuerySchema.parse(queryWithAliases(req.query));
    const data = await listGrowthOffers(query, client);
    return res.json(successEnvelope("Growth offers fetched.", data));
  });

  router.patch("/offers/:offerId/status", async (req, res) => {
    const { offerId } = offerIdParamsSchema.parse(req.params);
    const body = updateGrowthOfferStatusSchema.parse(req.body);
    const data = await updateGrowthOfferStatus(offerId, body, client);
    return res.json(successEnvelope("Growth offer status updated.", data));
  });

  router.post("/offers/:offerId/placements", async (req, res) => {
    const { offerId } = offerIdParamsSchema.parse(req.params);
    const body = createGrowthOfferPlacementSchema.parse(req.body);
    const data = await addGrowthOfferPlacement(offerId, body, client);
    return res.status(201).json(successEnvelope("Growth offer placement created.", data));
  });

  router.get("/placements/:surface/offers", async (req, res) => {
    const { surface } = surfaceParamsSchema.parse(req.params);
    const query = resolveGrowthOffersQuerySchema.parse(queryWithAliases(req.query));
    const data = await resolvePublicGrowthOffersForSurface(surface, query, client);
    return res.json(successEnvelope("Growth offer cards resolved.", data));
  });

  router.post("/events", async (req, res) => {
    const body = recordOfferEventSchema.parse(req.body);
    const data = await recordGrowthEvent(body, client);
    return res.status(201).json(successEnvelope("Growth offer event recorded.", data));
  });

  router.post("/tracking-page/view", async (req, res) => {
    const body = recordTrackingPageViewSchema.parse(req.body);
    const data = await recordTrackingPageView(body, client);
    return res.status(201).json(successEnvelope("Tracking page view recorded.", data));
  });

  return router;
}

export const growthNetworkRouter = createGrowthNetworkRouter();
