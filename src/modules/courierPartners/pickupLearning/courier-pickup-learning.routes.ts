import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getCourierPickupLearningForPickup,
  getCourierPickupLearningForShipment,
  getCourierPickupLearningProvider,
  listCourierPickupLearningProviders
} from "./courier-pickup-learning.service.js";
import {
  serializeCourierPickupLearningClassification,
  serializeCourierPickupLearningProvider,
  serializeCourierPickupLearningProviders
} from "./courier-pickup-learning.serializer.js";
import {
  parsePickupLearningProvider,
  pickupLearningQuerySchema
} from "./courier-pickup-learning.validation.js";

export const courierPickupLearningRouter = Router();

function routeProvider(value: string | string[] | undefined) {
  const providerKey = parsePickupLearningProvider(value);
  if (!providerKey) throw new HttpError(400, "PICKUP_LEARNING_UNSUPPORTED_PROVIDER");
  return providerKey;
}

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

courierPickupLearningRouter.get("/pickup-learning/providers", async (req, res) => {
  const query = pickupLearningQuerySchema.parse(req.query ?? {});
  const data = await listCourierPickupLearningProviders(req.auth!.merchantId, { limit: query.limit });
  return res.json(successEnvelope(
    "Pickup learning providers fetched safely.",
    serializeCourierPickupLearningProviders(data)
  ));
});

courierPickupLearningRouter.get("/pickup-learning/providers/:providerKey", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const query = pickupLearningQuerySchema.parse(req.query ?? {});
  const data = await getCourierPickupLearningProvider(req.auth!.merchantId, providerKey, { limit: query.limit });
  return res.json(successEnvelope(
    "Pickup learning provider fetched safely.",
    serializeCourierPickupLearningProvider(data)
  ));
});

courierPickupLearningRouter.get("/pickup-learning/providers/:providerKey/pickups/:pickupPincode", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const query = pickupLearningQuerySchema.parse(req.query ?? {});
  const data = await getCourierPickupLearningForPickup(req.auth!.merchantId, providerKey, routeParam(req.params.pickupPincode), {
    limit: query.limit,
    ...(query.delivery_pincode ? { deliveryPincode: query.delivery_pincode } : {})
  });
  return res.json(successEnvelope(
    "Pickup learning classification fetched safely.",
    serializeCourierPickupLearningClassification(data)
  ));
});

courierPickupLearningRouter.get("/pickup-learning/providers/:providerKey/shipments/:shipmentId", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const query = pickupLearningQuerySchema.parse(req.query ?? {});
  const data = await getCourierPickupLearningForShipment(req.auth!.merchantId, providerKey, routeParam(req.params.shipmentId), {
    limit: query.limit
  });
  return res.json(successEnvelope(
    "Shipment pickup learning classification fetched safely.",
    serializeCourierPickupLearningClassification(data)
  ));
});
