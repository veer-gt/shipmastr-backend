import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { isAdminRole } from "../../../lib/accountRoles.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getCourierAwbCertificationProviderStatus,
  runCourierAwbCertificationDryRun,
  runCourierAwbCertificationLiveOneShot
} from "./courier-awb-certification.service.js";
import {
  serializeCourierAwbCertificationAdmin,
  serializeCourierAwbCertificationLiveOneShot,
  serializeCourierAwbCertificationProviderStatus
} from "./courier-awb-certification.serializer.js";
import {
  courierAwbCertificationDryRunSchema,
  courierAwbCertificationLiveOneShotSchema,
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

function requireInternalAdminRole(req: { auth?: { role?: string | null } }) {
  if (!isAdminRole(req.auth?.role)) throw new HttpError(403, "AWB_CERTIFICATION_ADMIN_ONLY");
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

courierAwbCertificationRouter.post("/awb-certification/providers/:providerKey/shipments/:shipmentId/live-one-shot", async (req, res) => {
  requireInternalAdminRole(req);
  const approvalHeader = req.header("x-shipmastr-live-awb-approval")?.trim();
  if (!approvalHeader) throw new HttpError(401, "AWB_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED");
  const body = courierAwbCertificationLiveOneShotSchema.parse(req.body ?? {});
  const data = await runCourierAwbCertificationLiveOneShot(req.auth!.merchantId, routeProvider(req.params.providerKey), {
    shipmentId: routeParam(req.params.shipmentId),
    ...(body.pickup_location_id ? { pickupLocationId: body.pickup_location_id } : {}),
    requestedTier: body.requested_tier,
    ...(body.operator_note ? { operatorNote: body.operator_note } : {})
  }, {
    source: {
      SHIPMASTR_LIVE_SHIPROCKET_ONE_SHOT_HEADER: approvalHeader
    }
  });
  return res.json(successEnvelope(
    "AWB certification live one-shot evaluated safely.",
    serializeCourierAwbCertificationLiveOneShot(data)
  ));
});
