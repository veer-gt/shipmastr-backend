import { Router } from "express";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import { evaluateCertifiedProviderRouting } from "./certified-provider-routing.service.js";
import { serializeCertifiedProviderRouting } from "./certified-provider-routing.serializer.js";
import {
  certifiedProviderRoutingBodySchema,
  certifiedProviderRoutingQuerySchema
} from "./certified-provider-routing.validation.js";

export const certifiedProviderRoutingRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

certifiedProviderRoutingRouter.get("/certified-provider-routing/shipments/:shipmentId", async (req, res) => {
  const query = certifiedProviderRoutingQuerySchema.parse(req.query ?? {});
  const data = await evaluateCertifiedProviderRouting(req.auth!.merchantId, {
    shipmentId: routeParam(req.params.shipmentId),
    requestedCapability: query.requested_capability,
    requestedOutcome: query.requested_outcome,
    ...(query.pickup_location_id ? { pickupLocationId: query.pickup_location_id } : {}),
    ...(query.preferred_public_tier ? { preferredPublicTier: query.preferred_public_tier } : {})
  });
  return res.json(successEnvelope(
    "Certified provider routing evaluated safely.",
    serializeCertifiedProviderRouting(data)
  ));
});

certifiedProviderRoutingRouter.post("/certified-provider-routing/shipments/:shipmentId/evaluate", async (req, res) => {
  const body = certifiedProviderRoutingBodySchema.parse(req.body ?? {});
  const data = await evaluateCertifiedProviderRouting(req.auth!.merchantId, {
    shipmentId: routeParam(req.params.shipmentId),
    requestedCapability: body.requested_capability,
    requestedOutcome: body.requested_outcome,
    ...(body.pickup_location_id ? { pickupLocationId: body.pickup_location_id } : {}),
    ...(body.preferred_public_tier ? { preferredPublicTier: body.preferred_public_tier } : {})
  });
  return res.json(successEnvelope(
    "Certified provider routing evaluated safely.",
    serializeCertifiedProviderRouting(data)
  ));
});
