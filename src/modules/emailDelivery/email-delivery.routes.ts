import { Router } from "express";
import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  getEmailDeliveryReadiness,
  listEmailDeliveryAttempts,
  sendMerchantNotificationEmailSandbox,
  testSandboxEmailDelivery
} from "./email-delivery.service.js";
import {
  listEmailDeliveryAttemptsQuerySchema,
  sandboxEmailRequestSchema
} from "./email-delivery.validation.js";

export const emailDeliveryRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

emailDeliveryRouter.get("/email-delivery/readiness", async (req, res) => {
  const data = await getEmailDeliveryReadiness(req.auth!.merchantId);
  return res.json(successEnvelope("Email sandbox readiness fetched safely.", data));
});

emailDeliveryRouter.post("/email-delivery/test-sandbox", async (req, res) => {
  const body = sandboxEmailRequestSchema.parse(req.body);
  const data = await testSandboxEmailDelivery(req.auth!.merchantId, {
    ...body,
    actorEmail: req.auth?.email ?? null
  });
  return res.status(201).json(successEnvelope("Sandbox email test recorded safely.", data));
});

emailDeliveryRouter.get("/email-delivery/attempts", async (req, res) => {
  const query = listEmailDeliveryAttemptsQuerySchema.parse(req.query);
  const data = await listEmailDeliveryAttempts(req.auth!.merchantId, query);
  return res.json(successEnvelope("Email delivery attempts fetched safely.", data));
});

emailDeliveryRouter.post("/merchant-notifications/:notificationId/send-email-sandbox", async (req, res) => {
  const body = sandboxEmailRequestSchema.parse(req.body);
  const data = await sendMerchantNotificationEmailSandbox(
    req.auth!.merchantId,
    routeParam(req.params.notificationId),
    {
      ...body,
      actorEmail: req.auth?.email ?? null
    }
  );
  return res.status(201).json(successEnvelope("Notification sandbox email recorded safely.", data));
});
