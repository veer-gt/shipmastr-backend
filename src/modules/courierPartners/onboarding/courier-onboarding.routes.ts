import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getCourierOnboardingProvider,
  getCourierOnboardingSummary,
  listCourierOnboardingProviders
} from "./courier-onboarding.service.js";
import {
  courierOnboardingQuerySchema,
  parseCourierOnboardingProvider
} from "./courier-onboarding.validation.js";

export const courierOnboardingRouter = Router();

function routeProvider(value: string | string[] | undefined) {
  const providerKey = parseCourierOnboardingProvider(value);
  if (!providerKey) throw new HttpError(400, "COURIER_ONBOARDING_PROVIDER_UNSUPPORTED");
  return providerKey;
}

function scopedMerchantId(authMerchantId: string, requested?: string | null) {
  if (!requested || requested === authMerchantId) return authMerchantId;
  throw new HttpError(403, "COURIER_ONBOARDING_MERCHANT_SCOPE_MISMATCH");
}

function onboardingOptions(query: ReturnType<typeof courierOnboardingQuerySchema.parse>) {
  return {
    includePickupProbe: query.include_pickup_probe,
    ...(query.shipment_id ? { shipmentId: query.shipment_id } : {}),
    ...(query.pickup_location_id ? { pickupLocationId: query.pickup_location_id } : {})
  };
}

courierOnboardingRouter.get("/courier-onboarding/providers", async (req, res) => {
  const query = courierOnboardingQuerySchema.parse(req.query ?? {});
  const merchantId = scopedMerchantId(req.auth!.merchantId, query.merchant_id);
  const data = await listCourierOnboardingProviders(merchantId, onboardingOptions(query));
  return res.json(successEnvelope("Courier provider onboarding checklists fetched safely.", data));
});

courierOnboardingRouter.get("/courier-onboarding/providers/:providerKey", async (req, res) => {
  const query = courierOnboardingQuerySchema.parse(req.query ?? {});
  const merchantId = scopedMerchantId(req.auth!.merchantId, query.merchant_id);
  const data = await getCourierOnboardingProvider(
    merchantId,
    routeProvider(req.params.providerKey),
    onboardingOptions(query)
  );
  return res.json(successEnvelope("Courier provider onboarding checklist fetched safely.", data));
});

courierOnboardingRouter.get("/courier-onboarding/summary", async (req, res) => {
  const query = courierOnboardingQuerySchema.parse(req.query ?? {});
  const merchantId = scopedMerchantId(req.auth!.merchantId, query.merchant_id);
  const data = await getCourierOnboardingSummary(merchantId, onboardingOptions(query));
  return res.json(successEnvelope("Courier provider onboarding summary fetched safely.", data));
});
