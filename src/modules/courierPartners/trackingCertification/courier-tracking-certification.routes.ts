import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { isAdminRole } from "../../../lib/accountRoles.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getCourierTrackingCertificationProviderStatus,
  runCourierTrackingCertificationDryRun,
  runCourierTrackingCertificationLiveReadOneShot
} from "./courier-tracking-certification.service.js";
import {
  serializeCourierTrackingCertificationAdmin,
  serializeCourierTrackingCertificationLiveRead,
  serializeCourierTrackingCertificationProviderStatus
} from "./courier-tracking-certification.serializer.js";
import {
  courierTrackingCertificationDryRunSchema,
  courierTrackingCertificationLiveReadSchema,
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

function requireInternalAdminRole(req: { auth?: { role?: string | null } }) {
  if (!isAdminRole(req.auth?.role)) throw new HttpError(403, "TRACKING_CERTIFICATION_ADMIN_ONLY");
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

courierTrackingCertificationRouter.post("/tracking-certification/providers/:providerKey/shipments/:shipmentId/live-read-one-shot", async (req, res) => {
  requireInternalAdminRole(req);
  const approvalHeader = req.header("x-shipmastr-live-tracking-approval")?.trim();
  if (!approvalHeader) throw new HttpError(401, "TRACKING_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED");
  const body = courierTrackingCertificationLiveReadSchema.parse(req.body ?? {});
  const data = await runCourierTrackingCertificationLiveReadOneShot(req.auth!.merchantId, routeProvider(req.params.providerKey), {
    shipmentId: routeParam(req.params.shipmentId),
    ...(body.operator_note ? { operatorNote: body.operator_note } : {})
  }, {
    source: {
      SHIPMASTR_LIVE_SHIPROCKET_TRACKING_ONE_SHOT_HEADER: approvalHeader
    }
  });
  return res.json(successEnvelope(
    "Tracking certification live-read one-shot evaluated safely.",
    serializeCourierTrackingCertificationLiveRead(data)
  ));
});
