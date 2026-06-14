import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  diagnoseCourierPickupServiceability,
  listCourierPickupServiceabilityTrials
} from "./courier-pickup-serviceability.service.js";
import {
  courierPickupServiceabilityQuerySchema,
  parseCourierPickupServiceabilityProvider
} from "./courier-pickup-serviceability.validation.js";
import {
  serializeCourierPickupServiceability,
  serializeCourierPickupTrial
} from "./courier-pickup-serviceability.serializer.js";

export const courierPickupServiceabilityRouter = Router();

function routeProvider(value: string | string[] | undefined) {
  const providerKey = parseCourierPickupServiceabilityProvider(value);
  if (!providerKey) throw new HttpError(400, "COURIER_PICKUP_SERVICEABILITY_UNSUPPORTED_PROVIDER");
  return providerKey;
}

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

courierPickupServiceabilityRouter.get("/courier-pickup-serviceability/providers/:providerKey/shipments/:shipmentId", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const query = courierPickupServiceabilityQuerySchema.parse(req.query ?? {});
  const data = await diagnoseCourierPickupServiceability(req.auth!.merchantId, {
    providerKey,
    shipmentId: routeParam(req.params.shipmentId),
    ...(query.pickup_location_id ? { pickupLocationId: query.pickup_location_id } : {}),
    ...(query.delivery_pincode ? { deliveryPincode: query.delivery_pincode } : {})
  });
  return res.json(successEnvelope(
    "Courier pickup serviceability diagnosis fetched safely.",
    serializeCourierPickupServiceability(data)
  ));
});

courierPickupServiceabilityRouter.get("/courier-pickup-serviceability/providers/:providerKey/shipments/:shipmentId/pickups", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const query = courierPickupServiceabilityQuerySchema.parse(req.query ?? {});
  const data = await listCourierPickupServiceabilityTrials(req.auth!.merchantId, {
    providerKey,
    shipmentId: routeParam(req.params.shipmentId),
    ...(query.pickup_location_id ? { pickupLocationId: query.pickup_location_id } : {}),
    ...(query.delivery_pincode ? { deliveryPincode: query.delivery_pincode } : {})
  });
  return res.json(successEnvelope(
    "Courier pickup serviceability trial fetched safely.",
    serializeCourierPickupTrial(data)
  ));
});
