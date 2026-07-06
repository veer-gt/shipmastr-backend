import { env } from "../../config/env.js";
import type { ShipmastrWorkerConfig, ShipmastrWorkerName } from "./worker.types.js";

export function defaultWorkerConfig(): ShipmastrWorkerConfig {
  return {
    workersEnabled: env.SHIPMASTR_WORKERS_ENABLED,
    importWorkerEnabled: env.SHIPMASTR_IMPORT_WORKER_ENABLED,
    webhookWorkerEnabled: env.SHIPMASTR_WEBHOOK_WORKER_ENABLED,
    notificationWorkerEnabled: env.SHIPMASTR_NOTIFICATION_WORKER_ENABLED,
    retryWorkerEnabled: env.SHIPMASTR_RETRY_WORKER_ENABLED,
    checkoutTelemetryAbandonmentWorkerEnabled: env.SHIPMASTR_CHECKOUT_TELEMETRY_ABANDONMENT_WORKER_ENABLED,
    maxBatch: env.SHIPMASTR_WORKER_MAX_BATCH,
    lockSeconds: env.SHIPMASTR_WORKER_LOCK_SECONDS,
    dryRun: env.SHIPMASTR_WORKER_DRY_RUN
  };
}

export function workerSpecificEnabled(config: ShipmastrWorkerConfig, workerName: ShipmastrWorkerName) {
  if (workerName === "import-jobs") return config.importWorkerEnabled;
  if (workerName === "webhook-staging") return config.webhookWorkerEnabled;
  if (workerName === "notifications") return config.notificationWorkerEnabled;
  if (workerName === "checkout-telemetry-abandonment") return config.checkoutTelemetryAbandonmentWorkerEnabled;
  return config.retryWorkerEnabled;
}

export function workerEnabled(config: ShipmastrWorkerConfig, workerName: ShipmastrWorkerName) {
  return config.workersEnabled && workerSpecificEnabled(config, workerName);
}

export function effectiveMaxBatch(config: ShipmastrWorkerConfig, requested?: number) {
  const requestedBatch = Number.isFinite(requested) && requested ? Number(requested) : config.maxBatch;
  return Math.max(1, Math.min(config.maxBatch, requestedBatch));
}
