import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getCourierCertificationProvider,
  getCourierCertificationSummary,
  listCourierCertificationProviders
} from "./courier-certification.service.js";
import {
  courierCertificationQuerySchema,
  parseCourierCertificationProvider
} from "./courier-certification.validation.js";

export const courierCertificationRouter = Router();

function routeProvider(value: string | string[] | undefined) {
  const providerKey = parseCourierCertificationProvider(value);
  if (!providerKey) throw new HttpError(400, "COURIER_PROVIDER_UNSUPPORTED");
  return providerKey;
}

function scopedMerchantId(authMerchantId: string, requested?: string | null) {
  if (!requested || requested === authMerchantId) return authMerchantId;
  throw new HttpError(403, "COURIER_CERTIFICATION_MERCHANT_SCOPE_MISMATCH");
}

courierCertificationRouter.get("/courier-certification/providers", async (req, res) => {
  const query = courierCertificationQuerySchema.parse(req.query ?? {});
  const merchantId = scopedMerchantId(req.auth!.merchantId, query.merchant_id);
  const data = await listCourierCertificationProviders(merchantId, {
    includePickupProbe: query.include_pickup_probe,
    ...(query.shipment_id ? { shipmentId: query.shipment_id } : {}),
    ...(query.pickup_location_id ? { pickupLocationId: query.pickup_location_id } : {})
  });
  return res.json(successEnvelope("Courier partner certification providers fetched safely.", data));
});

courierCertificationRouter.get("/courier-certification/providers/:providerKey", async (req, res) => {
  const query = courierCertificationQuerySchema.parse(req.query ?? {});
  const merchantId = scopedMerchantId(req.auth!.merchantId, query.merchant_id);
  const data = await getCourierCertificationProvider(merchantId, routeProvider(req.params.providerKey), {
    includePickupProbe: query.include_pickup_probe,
    ...(query.shipment_id ? { shipmentId: query.shipment_id } : {}),
    ...(query.pickup_location_id ? { pickupLocationId: query.pickup_location_id } : {})
  });
  return res.json(successEnvelope("Courier partner certification provider fetched safely.", data));
});

courierCertificationRouter.get("/courier-certification/summary", async (req, res) => {
  const query = courierCertificationQuerySchema.parse(req.query ?? {});
  const merchantId = scopedMerchantId(req.auth!.merchantId, query.merchant_id);
  const data = await getCourierCertificationSummary(merchantId, {
    includePickupProbe: query.include_pickup_probe,
    ...(query.shipment_id ? { shipmentId: query.shipment_id } : {}),
    ...(query.pickup_location_id ? { pickupLocationId: query.pickup_location_id } : {})
  });
  return res.json(successEnvelope("Courier partner certification summary fetched safely.", data));
});
