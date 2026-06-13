import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { isAdminRole } from "../../../lib/accountRoles.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getCourierLabelCertificationProviderStatus,
  runCourierLabelCertificationDryRun,
  runCourierLabelCertificationLiveOneShot
} from "./courier-label-certification.service.js";
import {
  serializeCourierLabelCertificationAdmin,
  serializeCourierLabelCertificationLiveOneShot,
  serializeCourierLabelCertificationProviderStatus
} from "./courier-label-certification.serializer.js";
import {
  courierLabelCertificationDryRunSchema,
  courierLabelCertificationLiveOneShotSchema,
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

function requireInternalAdminRole(req: { auth?: { role?: string | null } }) {
  if (!isAdminRole(req.auth?.role)) throw new HttpError(403, "LABEL_CERTIFICATION_ADMIN_ONLY");
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

courierLabelCertificationRouter.post("/label-certification/providers/:providerKey/shipments/:shipmentId/live-one-shot", async (req, res) => {
  requireInternalAdminRole(req);
  const approvalHeader = req.header("x-shipmastr-live-label-approval")?.trim();
  if (!approvalHeader) throw new HttpError(401, "LABEL_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED");
  const body = courierLabelCertificationLiveOneShotSchema.parse(req.body ?? {});
  const data = await runCourierLabelCertificationLiveOneShot(req.auth!.merchantId, routeProvider(req.params.providerKey), {
    shipmentId: routeParam(req.params.shipmentId),
    ...(body.operator_note ? { operatorNote: body.operator_note } : {})
  }, {
    source: {
      SHIPMASTR_LIVE_SHIPROCKET_LABEL_ONE_SHOT_HEADER: approvalHeader
    }
  });
  return res.json(successEnvelope(
    "Label certification live one-shot evaluated safely.",
    serializeCourierLabelCertificationLiveOneShot(data)
  ));
});
