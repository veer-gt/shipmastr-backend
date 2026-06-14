import { Router } from "express";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  recordSellerGrowthSuggestionEvent,
  resolveSellerDashboardGrowthSuggestions,
  type SellerGrowthSuggestionsDb
} from "./seller-growth-suggestions.service.js";
import {
  recordSellerGrowthSuggestionEventSchema,
  resolveSellerGrowthSuggestionsQuerySchema
} from "./seller-growth-suggestions.validation.js";

type SellerGrowthSuggestionsRouterDeps = {
  client?: SellerGrowthSuggestionsDb;
};

function withAliases(record: Record<string, unknown>) {
  return {
    ...record,
    merchantId: record.merchantId ?? record.merchant_id,
    sellerId: record.sellerId ?? record.seller_id,
    shipmentId: record.shipmentId ?? record.shipment_id,
    orderId: record.orderId ?? record.order_id,
    suggestionId: record.suggestionId ?? record.suggestion_id,
    offerId: record.offerId ?? record.offer_id,
    eventType: record.eventType ?? record.event_type,
    idempotencyKey: record.idempotencyKey ?? record.idempotency_key
  };
}

export function createSellerGrowthSuggestionsRouter(
  deps: SellerGrowthSuggestionsRouterDeps = {}
) {
  const router = Router();
  const client = deps.client;

  router.get("/suggestions", async (req, res) => {
    const query = resolveSellerGrowthSuggestionsQuerySchema.parse(withAliases(req.query));
    const data = await resolveSellerDashboardGrowthSuggestions(query, client);
    return res.json(successEnvelope("Seller dashboard growth suggestions resolved.", data));
  });

  router.post("/suggestions/events", async (req, res) => {
    const body = recordSellerGrowthSuggestionEventSchema.parse(withAliases(req.body));
    const data = await recordSellerGrowthSuggestionEvent(body, client);
    return res.status(201).json(successEnvelope("Seller dashboard growth suggestion event recorded.", data));
  });

  return router;
}
