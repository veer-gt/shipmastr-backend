import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getCourierTrackingCertificationProviderStatus,
  runCourierTrackingCertificationDryRun
} from "./courier-tracking-certification.service.js";
import {
  serializeCourierTrackingCertificationAdmin,
  serializeCourierTrackingCertificationProviderStatus
} from "./courier-tracking-certification.serializer.js";
import {
  courierTrackingCertificationDryRunSchema,
  parseCourierTrackingCertificationProvider
} from "./courier-tracking-certification.validation.js";

export const courierTrackingCertificationRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function routeProvider(value: string | string[] | undefined) {
  const providerKey = parseCourierTrackingCertificationProvider(value);
  if (!providerKey) throw new HttpError(400, "TRACKING_CERTIFICATION_PROVIDER_UNSUPPORTED");
  return providerKey;
}

courierTrackingCertificationRouter.get("/tracking-certification/providers/:providerKey/status", async (req, res) => {
  const data = await getCourierTrackingCertificationProviderStatus(req.auth!.merchantId, routeProvider(req.params.providerKey));
  return res.json(successEnvelope(
    "Tracking certification foundation status fetched safely.",
    serializeCourierTrackingCertificationProviderStatus(data)
  ));
});

courierTrackingCertificationRouter.post("/tracking-certification/providers/:providerKey/shipments/:shipmentId/dry-run", async (req, res) => {
  const body = courierTrackingCertificationDryRunSchema.parse(req.body ?? {});
  const data = await runCourierTrackingCertificationDryRun(req.auth!.merchantId, routeProvider(req.params.providerKey), {
    shipmentId: routeParam(req.params.shipmentId),
    ...(body.pickup_location_id ? { pickupLocationId: body.pickup_location_id } : {})
  });
  return res.json(successEnvelope(
    "Tracking certification foundation dry-run evaluated safely. No live tracking call was made.",
    serializeCourierTrackingCertificationAdmin(data)
  ));
});
