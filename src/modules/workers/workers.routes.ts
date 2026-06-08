import { Router } from "express";
import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import { runImportJobWorkerOnce } from "./import-job.worker.js";
import { runNotificationWorkerOnce } from "./notification.worker.js";
import { runRetryWorkerOnce } from "./retry.worker.js";
import { getWorkerHealth, getWorkerRun, listWorkerRuns } from "./worker-health.service.js";
import { listWorkerRunsQuerySchema, workerRunOnceSchema } from "./worker.validation.js";
import { runWebhookStagingWorkerOnce } from "./webhook-staging.worker.js";

export const workersRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

workersRouter.post("/workers/import-jobs/run-once", async (req, res) => {
  const body = workerRunOnceSchema.parse(req.body ?? {});
  const data = await runImportJobWorkerOnce(req.auth!.merchantId, body);
  return res.json(successEnvelope("Import worker run-once evaluated safely.", data));
});

workersRouter.post("/workers/webhook-staging/run-once", async (req, res) => {
  const body = workerRunOnceSchema.parse(req.body ?? {});
  const data = await runWebhookStagingWorkerOnce(req.auth!.merchantId, body);
  return res.json(successEnvelope("Webhook staging worker run-once evaluated safely.", data));
});

workersRouter.post("/workers/notifications/run-once", async (req, res) => {
  const body = workerRunOnceSchema.parse(req.body ?? {});
  const data = await runNotificationWorkerOnce(req.auth!.merchantId, body);
  return res.json(successEnvelope("Notification worker run-once evaluated safely.", data));
});

workersRouter.post("/workers/retries/run-once", async (req, res) => {
  const body = workerRunOnceSchema.parse(req.body ?? {});
  const data = await runRetryWorkerOnce(req.auth!.merchantId, body);
  return res.json(successEnvelope("Retry worker run-once evaluated safely.", data));
});

workersRouter.get("/workers/health", async (req, res) => {
  const data = await getWorkerHealth(req.auth!.merchantId);
  return res.json(successEnvelope("Worker health fetched safely.", data));
});

workersRouter.get("/workers/runs", async (req, res) => {
  const query = listWorkerRunsQuerySchema.parse(req.query);
  const data = await listWorkerRuns(req.auth!.merchantId, query);
  return res.json(successEnvelope("Worker runs fetched safely.", data));
});

workersRouter.get("/workers/runs/:runId", async (req, res) => {
  const data = await getWorkerRun(req.auth!.merchantId, routeParam(req.params.runId));
  return res.json(successEnvelope("Worker run fetched safely.", data));
});
