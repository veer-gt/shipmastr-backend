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
import { platformWebhookIngestionRouter } from "./webhookIngestion/platform-webhook-ingestion.routes.js";
import {
  getLatestPlatformConnectionHealth,
  listPlatformConnectionHealthChecks,
  runAllPlatformConnectionHealthChecks,
  runPlatformConnectionHealthCheck
} from "./clients/platform-health-check.service.js";
import { platformHealthCheckQuerySchema } from "./clients/platform-health-check.validation.js";
import {
  cancelPlatformImportJob,
  continuePlatformImportJob,
  createPlatformImportJob,
  getPlatformImportCursor,
  getPlatformImportJob,
  getPlatformImportJobProgress,
  getPlatformImportJobSummary,
  listPlatformImportCursors,
  listPlatformImportJobs,
  retryPlatformImportItem,
  resetPlatformImportCursor,
  runNextPlatformImportCursorPage,
  runPlatformImportJobFoundation
} from "./importQueue/platform-import-queue.service.js";
import {
  continuePlatformImportJobSchema,
  createPlatformImportJobSchema,
  listPlatformImportCursorsQuerySchema,
  listPlatformImportJobsQuerySchema,
  resetPlatformImportCursorSchema,
  runPlatformImportCursorNextPageSchema,
  runPlatformImportJobSchema
} from "./importQueue/platform-import-queue.validation.js";
import {
  getPlatformImportReconciliationItem,
  getPlatformImportReconciliationSummary,
  listPlatformImportReconciliationItems
} from "./reconciliation/platform-import-reconciliation.service.js";
import {
  reconciliationItemsQuerySchema,
  reconciliationSummaryQuerySchema
} from "./reconciliation/platform-import-reconciliation.validation.js";
import {
  bulkConvertPlatformImportItems,
  convertPlatformImportItem,
  getPlatformImportItemConversionStatus
} from "./conversion/platform-import-conversion.service.js";
import {
  bulkConvertPlatformImportItemsSchema,
  convertPlatformImportItemSchema
} from "./conversion/platform-import-conversion.validation.js";

export const platformIntegrationsRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

platformIntegrationsRouter.use("/", shopifyPlatformRouter);
platformIntegrationsRouter.use("/", wooCommercePlatformRouter);
platformIntegrationsRouter.use("/", magentoPlatformRouter);
platformIntegrationsRouter.use("/", platformCredentialsRouter);
platformIntegrationsRouter.use("/", platformWebhookIngestionRouter);

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

platformIntegrationsRouter.post("/platform-import-jobs", async (req, res) => {
  const body = createPlatformImportJobSchema.parse(req.body);
  const data = await createPlatformImportJob(req.auth!.merchantId, body);
  return res.status(201).json(successEnvelope("Platform import job queued successfully.", data));
});

platformIntegrationsRouter.get("/platform-import-jobs", async (req, res) => {
  const query = listPlatformImportJobsQuerySchema.parse(req.query);
  const data = await listPlatformImportJobs(req.auth!.merchantId, query);
  return res.json(successEnvelope("Platform import jobs fetched successfully.", data));
});

platformIntegrationsRouter.get("/platform-import-jobs/:jobId", async (req, res) => {
  const data = await getPlatformImportJob(req.auth!.merchantId, routeParam(req.params.jobId));
  return res.json(successEnvelope("Platform import job fetched successfully.", data));
});

platformIntegrationsRouter.post("/platform-import-jobs/:jobId/run", async (req, res) => {
  runPlatformImportJobSchema.parse(req.body);
  const data = await runPlatformImportJobFoundation(req.auth!.merchantId, routeParam(req.params.jobId));
  return res.json(successEnvelope("Platform import job ran safely.", data));
});

platformIntegrationsRouter.post("/platform-import-jobs/:jobId/continue", async (req, res) => {
  const body = continuePlatformImportJobSchema.parse(req.body ?? {});
  const data = await continuePlatformImportJob(req.auth!.merchantId, routeParam(req.params.jobId), body);
  return res.json(successEnvelope("Platform import next page ran safely.", data));
});

platformIntegrationsRouter.post("/platform-import-jobs/:jobId/cancel", async (req, res) => {
  const data = await cancelPlatformImportJob(req.auth!.merchantId, routeParam(req.params.jobId));
  return res.json(successEnvelope("Platform import job cancelled successfully.", data));
});

platformIntegrationsRouter.get("/platform-import-jobs/:jobId/progress", async (req, res) => {
  const data = await getPlatformImportJobProgress(req.auth!.merchantId, routeParam(req.params.jobId));
  return res.json(successEnvelope("Platform import job progress fetched safely.", data));
});

platformIntegrationsRouter.get("/platform-import-jobs/:jobId/summary", async (req, res) => {
  const data = await getPlatformImportJobSummary(req.auth!.merchantId, routeParam(req.params.jobId));
  return res.json(successEnvelope("Platform import job summary fetched successfully.", data));
});

platformIntegrationsRouter.post("/platform-import-items/:itemId/retry", async (req, res) => {
  const data = await retryPlatformImportItem(req.auth!.merchantId, routeParam(req.params.itemId));
  return res.json(successEnvelope("Platform import item retry state recorded.", data));
});

platformIntegrationsRouter.get("/platform-import-cursors", async (req, res) => {
  const query = listPlatformImportCursorsQuerySchema.parse(req.query);
  const data = await listPlatformImportCursors(req.auth!.merchantId, query);
  return res.json(successEnvelope("Platform import cursors fetched safely.", data));
});

platformIntegrationsRouter.get("/platform-import-cursors/:cursorId", async (req, res) => {
  const data = await getPlatformImportCursor(req.auth!.merchantId, routeParam(req.params.cursorId));
  return res.json(successEnvelope("Platform import cursor fetched safely.", data));
});

platformIntegrationsRouter.post("/platform-import-cursors/:cursorId/run-next-page", async (req, res) => {
  const body = runPlatformImportCursorNextPageSchema.parse(req.body ?? {});
  const data = await runNextPlatformImportCursorPage(req.auth!.merchantId, routeParam(req.params.cursorId), body);
  return res.json(successEnvelope("Platform import cursor next page ran safely.", data));
});

platformIntegrationsRouter.post("/platform-import-cursors/:cursorId/reset", async (req, res) => {
  resetPlatformImportCursorSchema.parse(req.body ?? {});
  const data = await resetPlatformImportCursor(req.auth!.merchantId, routeParam(req.params.cursorId));
  return res.json(successEnvelope("Platform import cursor reset safely.", data));
});

platformIntegrationsRouter.get("/platform-import-reconciliation/summary", async (req, res) => {
  const query = reconciliationSummaryQuerySchema.parse(req.query);
  const data = await getPlatformImportReconciliationSummary(req.auth!.merchantId, query);
  return res.json(successEnvelope("Platform import reconciliation summary fetched successfully.", data));
});

platformIntegrationsRouter.get("/platform-import-reconciliation/items", async (req, res) => {
  const query = reconciliationItemsQuerySchema.parse(req.query);
  const data = await listPlatformImportReconciliationItems(req.auth!.merchantId, query);
  return res.json(successEnvelope("Platform import reconciliation items fetched successfully.", data));
});

platformIntegrationsRouter.post("/platform-import-reconciliation/items/bulk-convert", async (req, res) => {
  const body = bulkConvertPlatformImportItemsSchema.parse(req.body);
  const data = await bulkConvertPlatformImportItems(req.auth!.merchantId, body);
  return res.json(successEnvelope("Eligible platform import items converted safely.", data));
});

platformIntegrationsRouter.get("/platform-import-reconciliation/items/:itemId", async (req, res) => {
  const data = await getPlatformImportReconciliationItem(req.auth!.merchantId, routeParam(req.params.itemId));
  return res.json(successEnvelope("Platform import reconciliation item fetched successfully.", data));
});

platformIntegrationsRouter.post("/platform-import-reconciliation/items/:itemId/convert", async (req, res) => {
  const body = convertPlatformImportItemSchema.parse(req.body);
  const data = await convertPlatformImportItem(req.auth!.merchantId, routeParam(req.params.itemId), body);
  return res.status(201).json(successEnvelope("Platform import item conversion evaluated safely.", data));
});

platformIntegrationsRouter.get("/platform-import-reconciliation/items/:itemId/conversion-status", async (req, res) => {
  const data = await getPlatformImportItemConversionStatus(req.auth!.merchantId, routeParam(req.params.itemId));
  return res.json(successEnvelope("Platform import item conversion status fetched successfully.", data));
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
