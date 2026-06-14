import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import { arbitrateCourierPickup } from "./courier-arbitration.service.js";
import { serializeCourierArbitrationAdmin } from "./courier-arbitration.serializer.js";
import {
  courierArbitrationQuerySchema,
  parseCourierArbitrationProvider
} from "./courier-arbitration.validation.js";

export const courierArbitrationRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

courierArbitrationRouter.get("/courier-arbitration/shipments/:shipmentId", async (req, res) => {
  const query = courierArbitrationQuerySchema.parse(req.query ?? {});
  const providerKey = parseCourierArbitrationProvider(query.provider_key);
  if (query.provider_key && !providerKey) throw new HttpError(400, "COURIER_ARBITRATION_UNSUPPORTED_PROVIDER");
  const data = await arbitrateCourierPickup(req.auth!.merchantId, {
    shipmentId: routeParam(req.params.shipmentId),
    requestedCapability: query.requested_capability,
    ...(providerKey ? { preferredProviderKey: providerKey } : {}),
    ...(query.pickup_location_id ? { pickupLocationId: query.pickup_location_id } : {})
  });
  return res.json(successEnvelope(
    "Courier arbitration evaluated safely.",
    serializeCourierArbitrationAdmin(data)
  ));
});
