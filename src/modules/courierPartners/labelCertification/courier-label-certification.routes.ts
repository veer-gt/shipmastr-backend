import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getCourierLabelCertificationProviderStatus,
  runCourierLabelCertificationDryRun
} from "./courier-label-certification.service.js";
import {
  serializeCourierLabelCertificationAdmin,
  serializeCourierLabelCertificationProviderStatus
} from "./courier-label-certification.serializer.js";
import {
  courierLabelCertificationDryRunSchema,
  parseCourierLabelCertificationProvider
} from "./courier-label-certification.validation.js";

export const courierLabelCertificationRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function routeProvider(value: string | string[] | undefined) {
  const providerKey = parseCourierLabelCertificationProvider(value);
  if (!providerKey) throw new HttpError(400, "LABEL_CERTIFICATION_PROVIDER_UNSUPPORTED");
  return providerKey;
}

courierLabelCertificationRouter.get("/label-certification/providers/:providerKey/status", async (req, res) => {
  const data = await getCourierLabelCertificationProviderStatus(req.auth!.merchantId, routeProvider(req.params.providerKey));
  return res.json(successEnvelope(
    "Label certification sandbox status fetched safely.",
    serializeCourierLabelCertificationProviderStatus(data)
  ));
});

courierLabelCertificationRouter.post("/label-certification/providers/:providerKey/shipments/:shipmentId/dry-run", async (req, res) => {
  const body = courierLabelCertificationDryRunSchema.parse(req.body ?? {});
  const data = await runCourierLabelCertificationDryRun(req.auth!.merchantId, routeProvider(req.params.providerKey), {
    shipmentId: routeParam(req.params.shipmentId),
    ...(body.pickup_location_id ? { pickupLocationId: body.pickup_location_id } : {})
  });
  return res.json(successEnvelope(
    "Label certification sandbox dry-run evaluated safely. No AWB or label was created.",
    serializeCourierLabelCertificationAdmin(data)
  ));
});
