export type ShipmastrWorkerName =
  | "import-jobs"
  | "webhook-staging"
  | "notifications"
  | "retries"
  | "checkout-telemetry-abandonment";

export type ShipmastrWorkerStatus = "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";

export type ShipmastrWorkerMode = "DISABLED" | "DRY_RUN" | "ACTIVE";

export type ShipmastrWorkerConfig = {
  workersEnabled: boolean;
  importWorkerEnabled: boolean;
  webhookWorkerEnabled: boolean;
  notificationWorkerEnabled: boolean;
  retryWorkerEnabled: boolean;
  checkoutTelemetryAbandonmentWorkerEnabled: boolean;
  maxBatch: number;
  lockSeconds: number;
  dryRun: boolean;
};

export type WorkerRunOnceInput = {
  dry_run?: boolean | undefined;
  max_batch?: number | undefined;
  older_than_minutes?: number | undefined;
  now?: string | Date | undefined;
};

export type WorkerRunSummary = {
  message: string;
  eligible_count?: number;
  processed_ids?: string[];
  dry_run?: boolean;
  disabled?: boolean;
  external_calls_made: false;
  platform_writes: false;
  courier_calls: false;
  rates_fetched: false;
  awb_created: false;
  labels_created: false;
  email_sent: false;
  scheduler_started: false;
};

export type WorkerProcessorResult = {
  processedCount: number;
  failedCount?: number;
  warnings?: string[];
  errors?: string[];
  summary: WorkerRunSummary;
};
