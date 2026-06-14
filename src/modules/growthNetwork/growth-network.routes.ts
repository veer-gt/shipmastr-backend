import { Router } from "express";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import { createBillingReadinessRouter } from "./billing-readiness.routes.js";
import type { BillingReadinessDb } from "./billing-readiness.service.js";
import { createCampaignAnalyticsRouter } from "./campaign-analytics.routes.js";
import type { CampaignAnalyticsDb } from "./campaign-analytics.service.js";
import { createCampaignReviewRouter } from "./campaign-review.routes.js";
import type { CampaignReviewDb } from "./campaign-review.service.js";
import { createCodPrepaidIncentiveRouter } from "./cod-prepaid-incentive.routes.js";
import type { CodPrepaidIncentiveDb } from "./cod-prepaid-incentive.service.js";
import { createMerchantCampaignRouter } from "./merchant-campaign.routes.js";
import type { MerchantCampaignDb } from "./merchant-campaign.service.js";
import { createPartnerMarketplaceRouter } from "./partner-marketplace.routes.js";
import type { PartnerMarketplaceDb } from "./partner-marketplace.service.js";
import { createPartnerRoutingRouter } from "./partner-routing.routes.js";
import type { PartnerRoutingDb } from "./partner-routing.service.js";
import { createRtoNdrRecoveryRouter } from "./rto-ndr-recovery.routes.js";
import type { RtoNdrRecoveryDb } from "./rto-ndr-recovery.service.js";
import { createSellerGrowthSuggestionsRouter } from "./seller-growth-suggestions.routes.js";
import type { SellerGrowthSuggestionsDb } from "./seller-growth-suggestions.service.js";
import {
  currentGrowthNetworkRuntime,
  requireGrowthNetworkAudience,
  requireGrowthNetworkEnabled,
  serializeGrowthNetworkRuntimeStatus,
  type GrowthNetworkRuntimeConfig
} from "./growth-network-runtime.js";
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
  enforceRuntimeGuard?: boolean;
  runtime?: GrowthNetworkRuntimeConfig;
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
  const runtime = deps.runtime ?? currentGrowthNetworkRuntime();

  if (deps.enforceRuntimeGuard) {
    router.use(requireGrowthNetworkAudience(runtime));
  }

  router.get("/status", (_req, res) => {
    return res.json(successEnvelope(
      runtime.enabled
        ? "Growth Network is available for authenticated Shipmastr merchants and sellers."
        : "This Growth Network capability is currently disabled.",
      serializeGrowthNetworkRuntimeStatus(runtime)
    ));
  });

  if (deps.enforceRuntimeGuard) {
    router.use(requireGrowthNetworkEnabled(runtime));
  }

  router.use(
    "/prepaid-incentives",
    createCodPrepaidIncentiveRouter(client ? { client: client as CodPrepaidIncentiveDb } : {})
  );
  router.use(
    "/rto-ndr-recovery",
    createRtoNdrRecoveryRouter(client ? { client: client as RtoNdrRecoveryDb } : {})
  );
  router.use(
    "/seller-dashboard",
    createSellerGrowthSuggestionsRouter(client ? { client: client as SellerGrowthSuggestionsDb } : {})
  );
  router.use(
    "/partners",
    createPartnerMarketplaceRouter(client ? { client: client as unknown as PartnerMarketplaceDb } : {})
  );
  router.use(
    "/partners",
    createPartnerRoutingRouter(client ? { client: client as unknown as PartnerRoutingDb } : {})
  );
  router.use(
    "/admin/campaigns",
    createCampaignReviewRouter(client ? { client: client as unknown as CampaignReviewDb } : {})
  );
  router.use(
    "/merchant-campaigns/analytics",
    createCampaignAnalyticsRouter(client ? { client: client as unknown as CampaignAnalyticsDb } : {})
  );
  router.use(
    "/merchant-campaigns",
    createMerchantCampaignRouter(client ? { client: client as unknown as MerchantCampaignDb } : {})
  );
  router.use(
    "/billing-readiness",
    createBillingReadinessRouter(client ? { client: client as unknown as BillingReadinessDb } : {})
  );

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

export const growthNetworkRouter = createGrowthNetworkRouter({ enforceRuntimeGuard: true });
