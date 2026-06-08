import { Router } from "express";
import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  createConnection,
  createTrackingSyncFoundation,
  disableConnection,
  getConnection,
  getPlatformOrderImport,
  importPlatformOrderFoundation,
  listConnections,
  listPlatformOrderImports,
  listTrackingSyncs,
  previewPlatformOrderImport,
  simulateTrackingSyncFailure,
  simulateTrackingSyncSuccess
} from "./platform-integrations.service.js";
import {
  createPlatformConnectionSchema,
  createPlatformTrackingSyncSchema,
  listPlatformConnectionsQuerySchema,
  listPlatformOrderImportsQuerySchema,
  listPlatformTrackingSyncsQuerySchema,
  platformOrderPayloadSchema
} from "./platform-integrations.validation.js";
import { shopifyPlatformRouter } from "./shopify/shopify.routes.js";
import { wooCommercePlatformRouter } from "./woocommerce/woocommerce.routes.js";
import { magentoPlatformRouter } from "./magento/magento.routes.js";
import { platformCredentialsRouter } from "./credentials/platform-credentials.routes.js";
import {
  getLatestPlatformConnectionHealth,
  listPlatformConnectionHealthChecks,
  runAllPlatformConnectionHealthChecks,
  runPlatformConnectionHealthCheck
} from "./clients/platform-health-check.service.js";
import { platformHealthCheckQuerySchema } from "./clients/platform-health-check.validation.js";

export const platformIntegrationsRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

platformIntegrationsRouter.use("/", shopifyPlatformRouter);
platformIntegrationsRouter.use("/", wooCommercePlatformRouter);
platformIntegrationsRouter.use("/", magentoPlatformRouter);
platformIntegrationsRouter.use("/", platformCredentialsRouter);

platformIntegrationsRouter.post("/platform-connections", async (req, res) => {
  const body = createPlatformConnectionSchema.parse(req.body);
  const data = await createConnection(req.auth!.merchantId, body);
  return res.status(201).json(successEnvelope("Platform connection foundation created successfully.", data));
});

platformIntegrationsRouter.get("/platform-connections", async (req, res) => {
  const query = listPlatformConnectionsQuerySchema.parse(req.query);
  const data = await listConnections(req.auth!.merchantId, query);
  return res.json(successEnvelope("Platform connections fetched successfully.", data));
});

platformIntegrationsRouter.post("/platform-connections/health-check-all", async (req, res) => {
  const data = await runAllPlatformConnectionHealthChecks(req.auth!.merchantId);
  return res.json(successEnvelope("Platform connection health checks completed safely.", data));
});

platformIntegrationsRouter.get("/platform-connections/:connectionId", async (req, res) => {
  const data = await getConnection(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Platform connection fetched successfully.", data));
});

platformIntegrationsRouter.delete("/platform-connections/:connectionId", async (req, res) => {
  const data = await disableConnection(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Platform connection disabled successfully.", data));
});

platformIntegrationsRouter.post("/platform-connections/:connectionId/health-check", async (req, res) => {
  const data = await runPlatformConnectionHealthCheck(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.status(201).json(successEnvelope("Platform connection health check completed safely.", data));
});

platformIntegrationsRouter.get("/platform-connections/:connectionId/health-checks", async (req, res) => {
  const query = platformHealthCheckQuerySchema.parse(req.query);
  const data = await listPlatformConnectionHealthChecks(req.auth!.merchantId, routeParam(req.params.connectionId), query);
  return res.json(successEnvelope("Platform connection health checks fetched successfully.", data));
});

platformIntegrationsRouter.get("/platform-connections/:connectionId/health", async (req, res) => {
  const data = await getLatestPlatformConnectionHealth(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("Platform connection health fetched successfully.", data));
});

platformIntegrationsRouter.post("/platform-connections/:connectionId/orders/preview", async (req, res) => {
  const body = platformOrderPayloadSchema.parse(req.body);
  const data = await previewPlatformOrderImport(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.json(successEnvelope("Platform order preview mapped successfully.", data));
});

platformIntegrationsRouter.post("/platform-connections/:connectionId/orders/import", async (req, res) => {
  const body = platformOrderPayloadSchema.parse(req.body);
  const data = await importPlatformOrderFoundation(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.status(201).json(successEnvelope("Platform order import foundation recorded successfully.", data));
});

platformIntegrationsRouter.get("/platform-order-imports", async (req, res) => {
  const query = listPlatformOrderImportsQuerySchema.parse(req.query);
  const data = await listPlatformOrderImports(req.auth!.merchantId, query);
  return res.json(successEnvelope("Platform order imports fetched successfully.", data));
});

platformIntegrationsRouter.get("/platform-order-imports/:importId", async (req, res) => {
  const data = await getPlatformOrderImport(req.auth!.merchantId, routeParam(req.params.importId));
  return res.json(successEnvelope("Platform order import fetched successfully.", data));
});

platformIntegrationsRouter.post("/platform-connections/:connectionId/tracking-syncs", async (req, res) => {
  const body = createPlatformTrackingSyncSchema.parse(req.body);
  const data = await createTrackingSyncFoundation(req.auth!.merchantId, routeParam(req.params.connectionId), body);
  return res.status(201).json(successEnvelope("Platform tracking sync foundation recorded successfully.", data));
});

platformIntegrationsRouter.get("/platform-tracking-syncs", async (req, res) => {
  const query = listPlatformTrackingSyncsQuerySchema.parse(req.query);
  const data = await listTrackingSyncs(req.auth!.merchantId, query);
  return res.json(successEnvelope("Platform tracking syncs fetched successfully.", data));
});

platformIntegrationsRouter.post("/platform-tracking-syncs/:syncId/simulate-success", async (req, res) => {
  const data = await simulateTrackingSyncSuccess(req.auth!.merchantId, routeParam(req.params.syncId));
  return res.json(successEnvelope("Platform tracking sync marked successful.", data));
});

platformIntegrationsRouter.post("/platform-tracking-syncs/:syncId/simulate-failure", async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
  const data = await simulateTrackingSyncFailure(req.auth!.merchantId, routeParam(req.params.syncId), reason);
  return res.json(successEnvelope("Platform tracking sync marked failed.", data));
});
