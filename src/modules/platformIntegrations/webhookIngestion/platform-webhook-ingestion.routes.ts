import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { StorePlatform } from "@prisma/client";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getPlatformWebhookEvent,
  ingestPlatformWebhookEvent,
  listPlatformWebhookEvents,
  stagePlatformWebhookEventImport
} from "./platform-webhook.service.js";
import {
  assertSupportedPlatformWebhookHeaders,
  platformWebhookEventListQuerySchema,
  parsePlatformWebhookPayload,
  stagePlatformWebhookEventImportSchema
} from "./platform-webhook.validation.js";

export const platformWebhookIngestionRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function headersRecord(headers: Record<string, unknown>) {
  return { ...headers };
}

platformWebhookIngestionRouter.post("/platform-webhooks/shopify/:connectionId", async (req, res) => {
  if (!req.rawBody) throw new HttpError(400, "RAW_BODY_REQUIRED");
  assertSupportedPlatformWebhookHeaders("SHOPIFY", req.headers);
  const data = await ingestPlatformWebhookEvent(req.auth!.merchantId, {
    platform: StorePlatform.SHOPIFY,
    connectionId: routeParam(req.params.connectionId),
    headers: headersRecord(req.headers),
    payload: parsePlatformWebhookPayload("SHOPIFY", req.body),
    rawBody: req.rawBody
  });
  return res.status(data.event.status === "REJECTED" ? 202 : 201).json(successEnvelope("Shopify webhook event received safely.", data));
});

platformWebhookIngestionRouter.post("/platform-webhooks/woocommerce/:connectionId", async (req, res) => {
  if (!req.rawBody) throw new HttpError(400, "RAW_BODY_REQUIRED");
  assertSupportedPlatformWebhookHeaders("WOOCOMMERCE", req.headers);
  const data = await ingestPlatformWebhookEvent(req.auth!.merchantId, {
    platform: StorePlatform.WOOCOMMERCE,
    connectionId: routeParam(req.params.connectionId),
    headers: headersRecord(req.headers),
    payload: parsePlatformWebhookPayload("WOOCOMMERCE", req.body),
    rawBody: req.rawBody
  });
  return res.status(data.event.status === "REJECTED" ? 202 : 201).json(successEnvelope("WooCommerce webhook event received safely.", data));
});

platformWebhookIngestionRouter.post("/platform-webhooks/magento/:connectionId", async (req, res) => {
  if (!req.rawBody) throw new HttpError(400, "RAW_BODY_REQUIRED");
  assertSupportedPlatformWebhookHeaders("MAGENTO", req.headers);
  const data = await ingestPlatformWebhookEvent(req.auth!.merchantId, {
    platform: StorePlatform.MAGENTO,
    connectionId: routeParam(req.params.connectionId),
    headers: headersRecord(req.headers),
    payload: parsePlatformWebhookPayload("MAGENTO", req.body),
    rawBody: req.rawBody
  });
  return res.status(data.event.status === "REJECTED" ? 202 : 201).json(successEnvelope("Magento webhook event received safely.", data));
});

platformWebhookIngestionRouter.get("/platform-webhook-events", async (req, res) => {
  const query = platformWebhookEventListQuerySchema.parse(req.query);
  const data = await listPlatformWebhookEvents(req.auth!.merchantId, query);
  return res.json(successEnvelope("Platform webhook events fetched safely.", data));
});

platformWebhookIngestionRouter.get("/platform-webhook-events/:eventId", async (req, res) => {
  const data = await getPlatformWebhookEvent(req.auth!.merchantId, routeParam(req.params.eventId));
  return res.json(successEnvelope("Platform webhook event fetched safely.", data));
});

platformWebhookIngestionRouter.post("/platform-webhook-events/:eventId/stage-import", async (req, res) => {
  stagePlatformWebhookEventImportSchema.parse(req.body);
  const data = await stagePlatformWebhookEventImport(req.auth!.merchantId, routeParam(req.params.eventId));
  return res.status(201).json(successEnvelope("Platform webhook event staged for import safely.", data));
});
