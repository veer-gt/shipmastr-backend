import { Router } from "express";
import { isAdminRole } from "../../../lib/accountRoles.js";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  createControlledCourierPickupRateRefresh,
  createControlledCourierPickupTrial
} from "./courier-pickup-trial.service.js";
import { serializeCourierPickupTrial } from "./courier-pickup-trial.serializer.js";
import {
  createCourierPickupTrialSchema,
  parseCourierPickupTrialProvider,
  refreshCourierPickupTrialRatesSchema
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

function requireInternalAdminRole(req: { auth?: { role?: string | null } }) {
  if (!isAdminRole(req.auth?.role)) throw new HttpError(403, "COURIER_PICKUP_TRIAL_ADMIN_ONLY");
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

courierPickupTrialRouter.post("/courier-pickup-trials/providers/:providerKey/shipments/:shipmentId/rate-refresh", async (req, res) => {
  requireInternalAdminRole(req);
  const providerKey = routeProvider(req.params.providerKey);
  const body = refreshCourierPickupTrialRatesSchema.parse(req.body ?? {});
  const data = await createControlledCourierPickupRateRefresh(req.auth!.merchantId, {
    providerKey,
    shipmentId: routeParam(req.params.shipmentId),
    pickupLocationId: body.pickup_location_id,
    mode: body.mode
  });
  return res.status(201).json(successEnvelope(
    "Controlled alternate pickup rate refresh completed safely. No shipment pickup, AWB, label, or tracking mutation was performed.",
    serializeCourierPickupTrial(data)
  ));
});
