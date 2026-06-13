import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getCourierAwbCertificationProviderStatus,
  runCourierAwbCertificationDryRun
} from "./courier-awb-certification.service.js";
import {
  serializeCourierAwbCertificationAdmin,
  serializeCourierAwbCertificationProviderStatus
} from "./courier-awb-certification.serializer.js";
import {
  courierAwbCertificationDryRunSchema,
  parseCourierAwbCertificationProvider
} from "./courier-awb-certification.validation.js";

export const courierAwbCertificationRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function routeProvider(value: string | string[] | undefined) {
  const providerKey = parseCourierAwbCertificationProvider(value);
  if (!providerKey) throw new HttpError(400, "AWB_CERTIFICATION_PROVIDER_UNSUPPORTED");
  return providerKey;
}

courierAwbCertificationRouter.get("/awb-certification/providers/:providerKey/status", async (req, res) => {
  const data = await getCourierAwbCertificationProviderStatus(req.auth!.merchantId, routeProvider(req.params.providerKey));
  return res.json(successEnvelope(
    "AWB certification sandbox status fetched safely.",
    serializeCourierAwbCertificationProviderStatus(data)
  ));
});

courierAwbCertificationRouter.post("/awb-certification/providers/:providerKey/shipments/:shipmentId/dry-run", async (req, res) => {
  const body = courierAwbCertificationDryRunSchema.parse(req.body ?? {});
  const data = await runCourierAwbCertificationDryRun(req.auth!.merchantId, routeProvider(req.params.providerKey), {
    shipmentId: routeParam(req.params.shipmentId),
    ...(body.pickup_location_id ? { pickupLocationId: body.pickup_location_id } : {}),
    ...(body.requested_tier === undefined ? {} : { requestedTier: body.requested_tier })
  });
  return res.json(successEnvelope(
    "AWB certification sandbox dry-run evaluated safely. No AWB or label was created.",
    serializeCourierAwbCertificationAdmin(data)
  ));
});
