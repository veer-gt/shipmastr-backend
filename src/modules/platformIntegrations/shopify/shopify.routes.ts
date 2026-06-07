import { Router } from "express";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  createShopifyConnectionFoundation,
  disableShopifyConnection,
  getShopifyConnectionFoundation,
  listShopifyConnections,
  updateShopifyConnectionMetadata
} from "./shopify-connection.service.js";
import {
  createShopifyFulfillmentSyncFoundation,
  listShopifyFulfillmentSyncs,
  simulateShopifyFulfillmentSyncFailure,
  simulateShopifyFulfillmentSyncSuccess
} from "./shopify-fulfillment-sync.service.js";
import {
  importShopifyOrderWebhookFoundation,
  listShopifyOrderImports,
  previewShopifyOrderWebhook
} from "./shopify-order-ingestion.service.js";
import { validateShopifyWebhookFoundation } from "./shopify-webhook-validation.js";
import {
  createShopifyConnectionSchema,
  listShopifyRecordsQuerySchema,
  shopifyFulfillmentSyncSchema,
  shopifyOrderWebhookSchema,
  shopifyWebhookValidationSchema,
  updateShopifyConnectionSchema
} from "./shopify.validation.js";

export const shopifyPlatformRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

shopifyPlatformRouter.post("/platform-connections/shopify", async (req, res) => {
  const body = createShopifyConnectionSchema.parse(req.body);
  const data = await createShopifyConnectionFoundation(req.auth!.merchantId, body);
  return res.status(201).json(successEnvelope("Shopify connection foundation created successfully.", data));
});

shopifyPlatformRouter.get("/platform-connections/shopify", async (req, res) => {
  const query = listShopifyRecordsQuerySchema.parse(req.query);
  const data = await listShopifyConnections(req.auth!.merchantId, query);
  return res.json(successEnvelope("Shopify connections fetched successfully.", data));
});

shopifyPlatformRouter.get("/platform-connections/shopify/:connectionId", async (req, res) => {
  const data = await getShopifyConnectionFoundation(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Shopify connection fetched successfully.", data));
});

shopifyPlatformRouter.put("/platform-connections/shopify/:connectionId", async (req, res) => {
  const body = updateShopifyConnectionSchema.parse(req.body);
  const data = await updateShopifyConnectionMetadata(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.json(successEnvelope("Shopify connection updated successfully.", data));
});

shopifyPlatformRouter.delete("/platform-connections/shopify/:connectionId", async (req, res) => {
  const data = await disableShopifyConnection(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Shopify connection disabled successfully.", data));
});

shopifyPlatformRouter.post("/platform-connections/shopify/:connectionId/orders/webhook-preview", async (req, res) => {
  const body = shopifyOrderWebhookSchema.parse(req.body);
  const data = await previewShopifyOrderWebhook(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.json(successEnvelope("Shopify order webhook payload preview mapped successfully.", data));
});

shopifyPlatformRouter.post("/platform-connections/shopify/:connectionId/orders/webhook-import", async (req, res) => {
  const body = shopifyOrderWebhookSchema.parse(req.body);
  const data = await importShopifyOrderWebhookFoundation(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.status(201).json(successEnvelope("Shopify order webhook import foundation recorded successfully.", data));
});

shopifyPlatformRouter.get("/platform-connections/shopify/:connectionId/order-imports", async (req, res) => {
  const query = listShopifyRecordsQuerySchema.parse(req.query);
  const data = await listShopifyOrderImports(req.auth!.merchantId, routeParam(req.params.connectionId), query);
  return res.json(successEnvelope("Shopify order imports fetched successfully.", data));
});

shopifyPlatformRouter.post("/platform-connections/shopify/:connectionId/fulfillment-syncs", async (req, res) => {
  const body = shopifyFulfillmentSyncSchema.parse(req.body);
  const data = await createShopifyFulfillmentSyncFoundation(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.status(201).json(successEnvelope("Shopify fulfillment sync foundation recorded successfully.", data));
});

shopifyPlatformRouter.get("/platform-connections/shopify/:connectionId/fulfillment-syncs", async (req, res) => {
  const query = listShopifyRecordsQuerySchema.parse(req.query);
  const data = await listShopifyFulfillmentSyncs(req.auth!.merchantId, routeParam(req.params.connectionId), query);
  return res.json(successEnvelope("Shopify fulfillment syncs fetched successfully.", data));
});

shopifyPlatformRouter.post("/platform-connections/shopify/fulfillment-syncs/:syncId/simulate-success", async (req, res) => {
  const data = await simulateShopifyFulfillmentSyncSuccess(req.auth!.merchantId, routeParam(req.params.syncId));
  return res.json(successEnvelope("Shopify fulfillment sync marked successful.", data));
});

shopifyPlatformRouter.post("/platform-connections/shopify/fulfillment-syncs/:syncId/simulate-failure", async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const data = await simulateShopifyFulfillmentSyncFailure(req.auth!.merchantId, routeParam(req.params.syncId), reason);
  return res.json(successEnvelope("Shopify fulfillment sync marked failed.", data));
});

shopifyPlatformRouter.post("/platform-connections/shopify/webhooks/validate-foundation", async (req, res) => {
  const body = shopifyWebhookValidationSchema.parse(req.body);
  const data = validateShopifyWebhookFoundation(body);
  return res.json(successEnvelope("Shopify webhook validation foundation checked successfully.", data));
});
