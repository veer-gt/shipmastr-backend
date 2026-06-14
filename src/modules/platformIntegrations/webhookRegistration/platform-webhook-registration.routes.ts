import { Router } from "express";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  disablePlatformWebhookRegistration,
  dryRunPlatformWebhookRegistration,
  getPlatformWebhookRegistration,
  getPlatformWebhookRegistrationReadiness,
  listPlatformWebhookRegistrations,
  registerPlatformConnectionWebhooks
} from "./platform-webhook-registration.service.js";
import {
  disablePlatformWebhookRegistrationSchema,
  dryRunPlatformWebhookRegistrationSchema,
  listPlatformWebhookRegistrationsQuerySchema,
  registerPlatformWebhooksSchema
} from "./platform-webhook-registration.validation.js";

export const platformWebhookRegistrationRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

platformWebhookRegistrationRouter.get("/platform-webhook-registrations", async (req, res) => {
  const query = listPlatformWebhookRegistrationsQuerySchema.parse(req.query);
  const data = await listPlatformWebhookRegistrations(req.auth!.merchantId, query);
  return res.json(successEnvelope("Platform webhook registrations fetched safely.", data));
});

platformWebhookRegistrationRouter.post("/platform-webhook-registrations/dry-run", async (req, res) => {
  const body = dryRunPlatformWebhookRegistrationSchema.parse(req.body);
  const data = await dryRunPlatformWebhookRegistration(req.auth!.merchantId, body);
  return res.status(201).json(successEnvelope("Platform webhook registration dry-run recorded safely.", data));
});

platformWebhookRegistrationRouter.get("/platform-webhook-registrations/:registrationId", async (req, res) => {
  const data = await getPlatformWebhookRegistration(req.auth!.merchantId, routeParam(req.params.registrationId));
  return res.json(successEnvelope("Platform webhook registration fetched safely.", data));
});

platformWebhookRegistrationRouter.post("/platform-webhook-registrations/:registrationId/disable", async (req, res) => {
  const body = disablePlatformWebhookRegistrationSchema.parse(req.body ?? {});
  const data = await disablePlatformWebhookRegistration(req.auth!.merchantId, routeParam(req.params.registrationId), body);
  return res.json(successEnvelope("Platform webhook registration disabled safely.", data));
});

platformWebhookRegistrationRouter.get("/platform-connections/:connectionId/webhooks/registration-readiness", async (req, res) => {
  const data = await getPlatformWebhookRegistrationReadiness(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Platform webhook registration readiness fetched safely.", data));
});

platformWebhookRegistrationRouter.post("/platform-connections/:connectionId/webhooks/register", async (req, res) => {
  const body = registerPlatformWebhooksSchema.parse(req.body ?? {});
  const data = await registerPlatformConnectionWebhooks(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.status(201).json(successEnvelope("Platform webhook registration evaluated safely.", data));
});
