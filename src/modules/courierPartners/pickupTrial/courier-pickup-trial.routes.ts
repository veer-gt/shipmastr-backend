import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import { createControlledCourierPickupTrial } from "./courier-pickup-trial.service.js";
import { serializeCourierPickupTrial } from "./courier-pickup-trial.serializer.js";
import {
  createCourierPickupTrialSchema,
  parseCourierPickupTrialProvider
} from "./courier-pickup-trial.validation.js";

export const courierPickupTrialRouter = Router();

function routeProvider(value: string | string[] | undefined) {
  const providerKey = parseCourierPickupTrialProvider(value);
  if (!providerKey) throw new HttpError(400, "COURIER_PICKUP_TRIAL_UNSUPPORTED_PROVIDER");
  return providerKey;
}

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

courierPickupTrialRouter.post("/courier-pickup-trials/providers/:providerKey/shipments/:shipmentId", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const body = createCourierPickupTrialSchema.parse(req.body ?? {});
  const data = await createControlledCourierPickupTrial(req.auth!.merchantId, {
    providerKey,
    shipmentId: routeParam(req.params.shipmentId),
    pickupLocationId: body.pickup_location_id,
    mode: body.mode
  });
  return res.status(201).json(successEnvelope(
    "Controlled alternate pickup trial evaluated safely.",
    serializeCourierPickupTrial(data)
  ));
});
