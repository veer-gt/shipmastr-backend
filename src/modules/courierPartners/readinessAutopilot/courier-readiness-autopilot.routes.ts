import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  evaluateCourierReadinessAutopilotProvider,
  evaluateCourierShipmentProviderReadinessAutopilot,
  evaluateCourierShipmentReadinessAutopilot,
  listCourierReadinessAutopilotProviders
} from "./courier-readiness-autopilot.service.js";
import {
  serializeCourierReadinessAutopilotList,
  serializeCourierReadinessAutopilotProvider
} from "./courier-readiness-autopilot.serializer.js";
import {
  courierReadinessAutopilotQuerySchema,
  parseCourierReadinessAutopilotProvider
} from "./courier-readiness-autopilot.validation.js";

export const courierReadinessAutopilotRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function routeProvider(value: string | string[] | undefined) {
  const providerKey = parseCourierReadinessAutopilotProvider(value);
  if (!providerKey) throw new HttpError(400, "COURIER_READINESS_AUTOPILOT_UNSUPPORTED_PROVIDER");
  return providerKey;
}

function inputFromQuery(query: ReturnType<typeof courierReadinessAutopilotQuerySchema.parse>) {
  return {
    requestedCapability: query.requested_capability,
    includeArbitration: query.include_arbitration,
    includePickupLearning: query.include_pickup_learning,
    includeSandboxes: query.include_sandboxes,
    ...(query.pickup_location_id ? { pickupLocationId: query.pickup_location_id } : {})
  };
}

courierReadinessAutopilotRouter.get("/provider-readiness-autopilot/providers", async (req, res) => {
  const query = courierReadinessAutopilotQuerySchema.parse(req.query ?? {});
  const data = await listCourierReadinessAutopilotProviders(req.auth!.merchantId, inputFromQuery(query));
  return res.json(successEnvelope(
    "Provider readiness autopilot providers evaluated safely.",
    serializeCourierReadinessAutopilotList(data)
  ));
});

courierReadinessAutopilotRouter.get("/provider-readiness-autopilot/providers/:providerKey", async (req, res) => {
  const query = courierReadinessAutopilotQuerySchema.parse(req.query ?? {});
  const data = await evaluateCourierReadinessAutopilotProvider(
    req.auth!.merchantId,
    routeProvider(req.params.providerKey),
    inputFromQuery(query)
  );
  return res.json(successEnvelope(
    "Provider readiness autopilot provider evaluated safely.",
    serializeCourierReadinessAutopilotProvider(data)
  ));
});

courierReadinessAutopilotRouter.get("/provider-readiness-autopilot/shipments/:shipmentId", async (req, res) => {
  const query = courierReadinessAutopilotQuerySchema.parse(req.query ?? {});
  const data = await evaluateCourierShipmentReadinessAutopilot(
    req.auth!.merchantId,
    routeParam(req.params.shipmentId),
    inputFromQuery(query)
  );
  return res.json(successEnvelope(
    "Provider readiness autopilot shipment evaluated safely.",
    serializeCourierReadinessAutopilotList(data)
  ));
});

courierReadinessAutopilotRouter.get("/provider-readiness-autopilot/shipments/:shipmentId/providers/:providerKey", async (req, res) => {
  const query = courierReadinessAutopilotQuerySchema.parse(req.query ?? {});
  const data = await evaluateCourierShipmentProviderReadinessAutopilot(
    req.auth!.merchantId,
    routeParam(req.params.shipmentId),
    routeProvider(req.params.providerKey),
    inputFromQuery(query)
  );
  return res.json(successEnvelope(
    "Provider readiness autopilot shipment provider evaluated safely.",
    serializeCourierReadinessAutopilotProvider(data)
  ));
});
