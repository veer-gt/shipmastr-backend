import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getShiprocketPickupDiagnostics,
  serializeShiprocketPickupDiagnostics
} from "../../shippingNetwork/shipping-shiprocket-pickup-alignment.service.js";
import {
  createCourierProviderCredential,
  getCourierLiveProvider,
  getCourierLiveReadinessSnapshot,
  getCourierProviderCredential,
  listCourierLiveProviders,
  listCourierProviderCredentials,
  revokeCourierProviderCredential,
  testCourierProviderCredential
} from "./courier-live-readiness.service.js";
import {
  courierCredentialInputSchema,
  courierCredentialQuerySchema,
  courierPickupDiagnosticsQuerySchema,
  courierProbeInputSchema,
  courierReadinessQuerySchema,
  parseCourierLiveProviderKey
} from "./courier-live-readiness.validation.js";

export const courierLiveReadinessRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function routeProvider(value: string | string[] | undefined) {
  const providerKey = parseCourierLiveProviderKey(value);
  if (!providerKey) throw new HttpError(400, "COURIER_PROVIDER_UNSUPPORTED");
  return providerKey;
}

function scopedMerchantId(authMerchantId: string, requested?: string | null) {
  if (!requested || requested === authMerchantId) return authMerchantId;
  throw new HttpError(403, "COURIER_PROVIDER_MERCHANT_SCOPE_MISMATCH");
}

courierLiveReadinessRouter.get("/courier-live-readiness/providers", async (_req, res) => {
  const data = await listCourierLiveProviders();
  return res.json(successEnvelope("Courier live readiness providers fetched safely.", data));
});

courierLiveReadinessRouter.get("/courier-live-readiness/providers/:providerKey", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const data = await getCourierLiveProvider(providerKey);
  return res.json(successEnvelope("Courier live readiness provider fetched safely.", data));
});

courierLiveReadinessRouter.get("/courier-live-readiness/providers/:providerKey/pickups", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  if (providerKey !== "SHIPROCKET") throw new HttpError(400, "COURIER_PROVIDER_PICKUP_DIAGNOSTICS_UNSUPPORTED");
  const query = courierPickupDiagnosticsQuerySchema.parse(req.query ?? {});
  const merchantId = scopedMerchantId(req.auth!.merchantId, query.merchant_id);
  const diagnostics = await getShiprocketPickupDiagnostics(merchantId, {
    ...(query.shipment_id ? { shipmentId: query.shipment_id } : {}),
    ...(query.pickup_location_id ? { pickupLocationId: query.pickup_location_id } : {})
  });
  return res.json(successEnvelope(
    "Courier provider pickup diagnostics fetched safely.",
    serializeShiprocketPickupDiagnostics(diagnostics, { includePickups: true })
  ));
});

courierLiveReadinessRouter.get("/courier-live-readiness/providers/:providerKey/credentials", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const query = courierCredentialQuerySchema.parse(req.query ?? {});
  const merchantId = scopedMerchantId(req.auth!.merchantId, query.merchant_id);
  const data = await listCourierProviderCredentials(merchantId, providerKey, query);
  return res.json(successEnvelope("Courier provider credentials fetched safely.", data));
});

courierLiveReadinessRouter.post("/courier-live-readiness/providers/:providerKey/credentials", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const body = courierCredentialInputSchema.parse(req.body ?? {});
  const merchantId = scopedMerchantId(req.auth!.merchantId, body.merchant_id);
  const data = await createCourierProviderCredential(merchantId, providerKey, body);
  return res.status(201).json(successEnvelope("Courier provider credential reference stored safely.", data));
});

courierLiveReadinessRouter.get("/courier-live-readiness/providers/:providerKey/credentials/:credentialId", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const data = await getCourierProviderCredential(req.auth!.merchantId, providerKey, routeParam(req.params.credentialId));
  return res.json(successEnvelope("Courier provider credential status fetched safely.", data));
});

courierLiveReadinessRouter.post("/courier-live-readiness/providers/:providerKey/credentials/:credentialId/revoke", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const data = await revokeCourierProviderCredential(req.auth!.merchantId, providerKey, routeParam(req.params.credentialId));
  return res.json(successEnvelope("Courier provider credential revoked safely.", data));
});

courierLiveReadinessRouter.post("/courier-live-readiness/providers/:providerKey/credentials/:credentialId/test", async (req, res) => {
  const providerKey = routeProvider(req.params.providerKey);
  const body = courierProbeInputSchema.parse(req.body ?? {});
  const data = await testCourierProviderCredential(req.auth!.merchantId, providerKey, routeParam(req.params.credentialId), body);
  return res.json(successEnvelope("Courier provider readiness probe completed safely.", data));
});

courierLiveReadinessRouter.get("/courier-live-readiness/readiness", async (req, res) => {
  const query = courierReadinessQuerySchema.parse(req.query ?? {});
  const merchantId = scopedMerchantId(req.auth!.merchantId, query.merchant_id);
  const data = await getCourierLiveReadinessSnapshot(merchantId);
  return res.json(successEnvelope("Courier live readiness snapshot fetched safely.", data));
});
