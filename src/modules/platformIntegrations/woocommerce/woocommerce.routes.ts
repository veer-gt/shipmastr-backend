import { Router } from "express";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  createWooCommerceConnectionFoundation,
  disableWooCommerceConnection,
  getWooCommerceConnectionFoundation,
  listWooCommerceConnections,
  updateWooCommerceConnectionMetadata
} from "./woocommerce-connection.service.js";
import {
  importWooCommerceOrderWebhookFoundation,
  listWooCommerceOrderImports,
  previewWooCommerceOrderWebhook
} from "./woocommerce-order-ingestion.service.js";
import {
  createWooCommerceTrackingSyncFoundation,
  listWooCommerceTrackingSyncs,
  simulateWooCommerceTrackingSyncFailure,
  simulateWooCommerceTrackingSyncSuccess
} from "./woocommerce-tracking-sync.service.js";
import { validateWooCommerceWebhookFoundation } from "./woocommerce-webhook-validation.js";
import {
  createWooCommerceConnectionSchema,
  listWooCommerceRecordsQuerySchema,
  updateWooCommerceConnectionSchema,
  wooCommerceOrderWebhookSchema,
  wooCommerceTrackingSyncSchema,
  wooCommerceWebhookValidationSchema
} from "./woocommerce.validation.js";

export const wooCommercePlatformRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

wooCommercePlatformRouter.post("/platform-connections/woocommerce", async (req, res) => {
  const body = createWooCommerceConnectionSchema.parse(req.body);
  const data = await createWooCommerceConnectionFoundation(req.auth!.merchantId, body);
  return res.status(201).json(successEnvelope("WooCommerce connection foundation created successfully.", data));
});

wooCommercePlatformRouter.get("/platform-connections/woocommerce", async (req, res) => {
  const query = listWooCommerceRecordsQuerySchema.parse(req.query);
  const data = await listWooCommerceConnections(req.auth!.merchantId, query);
  return res.json(successEnvelope("WooCommerce connections fetched successfully.", data));
});

wooCommercePlatformRouter.get("/platform-connections/woocommerce/:connectionId", async (req, res) => {
  const data = await getWooCommerceConnectionFoundation(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("WooCommerce connection fetched successfully.", data));
});

wooCommercePlatformRouter.put("/platform-connections/woocommerce/:connectionId", async (req, res) => {
  const body = updateWooCommerceConnectionSchema.parse(req.body);
  const data = await updateWooCommerceConnectionMetadata(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.json(successEnvelope("WooCommerce connection updated successfully.", data));
});

wooCommercePlatformRouter.delete("/platform-connections/woocommerce/:connectionId", async (req, res) => {
  const data = await disableWooCommerceConnection(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("WooCommerce connection disabled successfully.", data));
});

wooCommercePlatformRouter.post("/platform-connections/woocommerce/:connectionId/orders/webhook-preview", async (req, res) => {
  const body = wooCommerceOrderWebhookSchema.parse(req.body);
  const data = await previewWooCommerceOrderWebhook(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.json(successEnvelope("WooCommerce order webhook payload preview mapped successfully.", data));
});

wooCommercePlatformRouter.post("/platform-connections/woocommerce/:connectionId/orders/webhook-import", async (req, res) => {
  const body = wooCommerceOrderWebhookSchema.parse(req.body);
  const data = await importWooCommerceOrderWebhookFoundation(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.status(201).json(successEnvelope("WooCommerce order webhook import foundation recorded successfully.", data));
});

wooCommercePlatformRouter.get("/platform-connections/woocommerce/:connectionId/order-imports", async (req, res) => {
  const query = listWooCommerceRecordsQuerySchema.parse(req.query);
  const data = await listWooCommerceOrderImports(req.auth!.merchantId, routeParam(req.params.connectionId), query);
  return res.json(successEnvelope("WooCommerce order imports fetched successfully.", data));
});

wooCommercePlatformRouter.post("/platform-connections/woocommerce/:connectionId/tracking-syncs", async (req, res) => {
  const body = wooCommerceTrackingSyncSchema.parse(req.body);
  const data = await createWooCommerceTrackingSyncFoundation(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.status(201).json(successEnvelope("WooCommerce tracking sync foundation recorded successfully.", data));
});

wooCommercePlatformRouter.get("/platform-connections/woocommerce/:connectionId/tracking-syncs", async (req, res) => {
  const query = listWooCommerceRecordsQuerySchema.parse(req.query);
  const data = await listWooCommerceTrackingSyncs(req.auth!.merchantId, routeParam(req.params.connectionId), query);
  return res.json(successEnvelope("WooCommerce tracking syncs fetched successfully.", data));
});

wooCommercePlatformRouter.post("/platform-connections/woocommerce/tracking-syncs/:syncId/simulate-success", async (req, res) => {
  const data = await simulateWooCommerceTrackingSyncSuccess(req.auth!.merchantId, routeParam(req.params.syncId));
  return res.json(successEnvelope("WooCommerce tracking sync marked successful.", data));
});

wooCommercePlatformRouter.post("/platform-connections/woocommerce/tracking-syncs/:syncId/simulate-failure", async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const data = await simulateWooCommerceTrackingSyncFailure(req.auth!.merchantId, routeParam(req.params.syncId), reason);
  return res.json(successEnvelope("WooCommerce tracking sync marked failed.", data));
});

wooCommercePlatformRouter.post("/platform-connections/woocommerce/webhooks/validate-foundation", async (req, res) => {
  const body = wooCommerceWebhookValidationSchema.parse(req.body);
  const data = validateWooCommerceWebhookFoundation(body);
  return res.json(successEnvelope("WooCommerce webhook validation foundation checked successfully.", data));
});
