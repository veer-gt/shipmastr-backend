import { Router } from "express";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  createMagentoConnectionFoundation,
  disableMagentoConnection,
  getMagentoConnectionFoundation,
  listMagentoConnections,
  updateMagentoConnectionMetadata
} from "./magento-connection.service.js";
import {
  importMagentoOrderWebhookFoundation,
  listMagentoOrderImports,
  previewMagentoOrderWebhook
} from "./magento-order-ingestion.service.js";
import {
  createMagentoShippingSyncFoundation,
  listMagentoShippingSyncs,
  simulateMagentoShippingSyncFailure,
  simulateMagentoShippingSyncSuccess
} from "./magento-shipping-sync.service.js";
import { validateMagentoWebhookFoundation } from "./magento-webhook-validation.js";
import {
  createMagentoConnectionSchema,
  listMagentoRecordsQuerySchema,
  updateMagentoConnectionSchema,
  magentoOrderWebhookSchema,
  magentoShippingSyncSchema,
  magentoWebhookValidationSchema
} from "./magento.validation.js";

export const magentoPlatformRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

magentoPlatformRouter.post("/platform-connections/magento", async (req, res) => {
  const body = createMagentoConnectionSchema.parse(req.body);
  const data = await createMagentoConnectionFoundation(req.auth!.merchantId, body);
  return res.status(201).json(successEnvelope("Magento connection foundation created successfully.", data));
});

magentoPlatformRouter.get("/platform-connections/magento", async (req, res) => {
  const query = listMagentoRecordsQuerySchema.parse(req.query);
  const data = await listMagentoConnections(req.auth!.merchantId, query);
  return res.json(successEnvelope("Magento connections fetched successfully.", data));
});

magentoPlatformRouter.get("/platform-connections/magento/:connectionId", async (req, res) => {
  const data = await getMagentoConnectionFoundation(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Magento connection fetched successfully.", data));
});

magentoPlatformRouter.put("/platform-connections/magento/:connectionId", async (req, res) => {
  const body = updateMagentoConnectionSchema.parse(req.body);
  const data = await updateMagentoConnectionMetadata(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.json(successEnvelope("Magento connection updated successfully.", data));
});

magentoPlatformRouter.delete("/platform-connections/magento/:connectionId", async (req, res) => {
  const data = await disableMagentoConnection(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Magento connection disabled successfully.", data));
});

magentoPlatformRouter.post("/platform-connections/magento/:connectionId/orders/webhook-preview", async (req, res) => {
  const body = magentoOrderWebhookSchema.parse(req.body);
  const data = await previewMagentoOrderWebhook(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.json(successEnvelope("Magento order webhook payload preview mapped successfully.", data));
});

magentoPlatformRouter.post("/platform-connections/magento/:connectionId/orders/webhook-import", async (req, res) => {
  const body = magentoOrderWebhookSchema.parse(req.body);
  const data = await importMagentoOrderWebhookFoundation(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.status(201).json(successEnvelope("Magento order webhook import foundation recorded successfully.", data));
});

magentoPlatformRouter.get("/platform-connections/magento/:connectionId/order-imports", async (req, res) => {
  const query = listMagentoRecordsQuerySchema.parse(req.query);
  const data = await listMagentoOrderImports(req.auth!.merchantId, routeParam(req.params.connectionId), query);
  return res.json(successEnvelope("Magento order imports fetched successfully.", data));
});

magentoPlatformRouter.post("/platform-connections/magento/:connectionId/shipping-syncs", async (req, res) => {
  const body = magentoShippingSyncSchema.parse(req.body);
  const data = await createMagentoShippingSyncFoundation(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.status(201).json(successEnvelope("Magento shipping sync foundation recorded successfully.", data));
});

magentoPlatformRouter.get("/platform-connections/magento/:connectionId/shipping-syncs", async (req, res) => {
  const query = listMagentoRecordsQuerySchema.parse(req.query);
  const data = await listMagentoShippingSyncs(req.auth!.merchantId, routeParam(req.params.connectionId), query);
  return res.json(successEnvelope("Magento shipping syncs fetched successfully.", data));
});

magentoPlatformRouter.post("/platform-connections/magento/shipping-syncs/:syncId/simulate-success", async (req, res) => {
  const data = await simulateMagentoShippingSyncSuccess(req.auth!.merchantId, routeParam(req.params.syncId));
  return res.json(successEnvelope("Magento shipping sync marked successful.", data));
});

magentoPlatformRouter.post("/platform-connections/magento/shipping-syncs/:syncId/simulate-failure", async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const data = await simulateMagentoShippingSyncFailure(req.auth!.merchantId, routeParam(req.params.syncId), reason);
  return res.json(successEnvelope("Magento shipping sync marked failed.", data));
});

magentoPlatformRouter.post("/platform-connections/magento/webhooks/validate-foundation", async (req, res) => {
  const body = magentoWebhookValidationSchema.parse(req.body);
  const data = validateMagentoWebhookFoundation(body);
  return res.json(successEnvelope("Magento webhook validation foundation checked successfully.", data));
});
