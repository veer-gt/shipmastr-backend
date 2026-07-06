import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PlatformImportItemStatus, PlatformImportJobStatus, StorePlatform } from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { runImportJobWorkerOnce } from "../import-job.worker.js";
import { runNotificationWorkerOnce } from "../notification.worker.js";
import { runRetryWorkerOnce } from "../retry.worker.js";
import { getWorkerHealth, listWorkerRuns, runWorkerOnce, workerRunSummary } from "../worker-health.service.js";
import type { ShipmastrWorkerConfig } from "../worker.types.js";
import { runWebhookStagingWorkerOnce } from "../webhook-staging.worker.js";

const now = new Date("2026-06-08T10:00:00.000Z");

const disabledConfig: ShipmastrWorkerConfig = {
  workersEnabled: false,
  importWorkerEnabled: false,
  webhookWorkerEnabled: false,
  notificationWorkerEnabled: false,
  retryWorkerEnabled: false,
  checkoutTelemetryAbandonmentWorkerEnabled: false,
  maxBatch: 25,
  lockSeconds: 300,
  dryRun: true
};

function enabledConfig(overrides: Partial<ShipmastrWorkerConfig> = {}): ShipmastrWorkerConfig {
  return {
    workersEnabled: true,
    importWorkerEnabled: true,
    webhookWorkerEnabled: true,
    notificationWorkerEnabled: true,
    retryWorkerEnabled: true,
    checkoutTelemetryAbandonmentWorkerEnabled: true,
    maxBatch: 2,
    lockSeconds: 300,
    dryRun: true,
    ...overrides
  };
}

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("gte" in expected) return row[key] instanceof Date && row[key] >= (expected as { gte: Date }).gte;
      if ("lte" in expected) return row[key] instanceof Date && row[key] <= (expected as { lte: Date }).lte;
      if ("not" in expected) {
        const notValue = (expected as { not: unknown }).not;
        return notValue === null ? row[key] != null : row[key] !== notValue;
      }
    }
    return row[key] === expected;
  });
}

function pageRows<T extends Record<string, any>>(rows: T[], args: any = {}) {
  const sorted = [...rows];
  if (args.orderBy?.startedAt === "desc") sorted.sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime());
  if (args.orderBy?.createdAt === "asc") sorted.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  if (args.orderBy?.receivedAt === "asc") sorted.sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime());
  if (args.orderBy?.nextAttemptAt === "asc") sorted.sort((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime());
  return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? sorted.length));
}

function makeClient() {
  const state = {
    runs: [] as any[],
    jobs: [] as any[],
    cursors: [] as any[],
    events: [] as any[],
    items: [] as any[],
    conversions: [] as any[],
    notifications: [] as any[]
  };

  const client = {
    shipmastrWorkerRun: {
      create: async ({ data }: any) => {
        const row = {
          id: `worker_run_${state.runs.length + 1}`,
          workerName: data.workerName,
          merchantId: data.merchantId ?? null,
          status: data.status,
          mode: data.mode,
          startedAt: data.startedAt ?? now,
          finishedAt: data.finishedAt ?? null,
          processedCount: data.processedCount ?? 0,
          failedCount: data.failedCount ?? 0,
          warnings: data.warnings ?? [],
          errors: data.errors ?? [],
          createdAt: now,
          updatedAt: now
        };
        state.runs.push(row);
        return row;
      },
      findFirst: async ({ where = {} }: any = {}) => state.runs.find((row) => matches(row, where)) ?? null,
      findMany: async (args: any = {}) => pageRows(state.runs.filter((row) => matches(row, args.where ?? {})), args),
      count: async ({ where = {} }: any = {}) => state.runs.filter((row) => matches(row, where)).length,
      update: async ({ where, data }: any) => {
        const row = state.runs.find((run) => run.id === where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    platformImportJob: {
      findMany: async (args: any = {}) => pageRows(state.jobs.filter((row) => matches(row, args.where ?? {})), args),
      count: async ({ where = {} }: any = {}) => state.jobs.filter((row) => matches(row, where)).length
    },
    platformImportCursor: {
      findMany: async (args: any = {}) => pageRows(state.cursors.filter((row) => matches(row, args.where ?? {})), args)
    },
    platformWebhookEvent: {
      findMany: async (args: any = {}) => pageRows(state.events.filter((row) => matches(row, args.where ?? {})), args)
    },
    platformImportItem: {
      findMany: async (args: any = {}) => pageRows(state.items.filter((row) => matches(row, args.where ?? {})), args),
      count: async ({ where = {} }: any = {}) => state.items.filter((row) => matches(row, where)).length
    },
    platformImportConversion: {
      count: async ({ where = {} }: any = {}) => state.conversions.filter((row) => matches(row, where)).length
    }
  };

  return { state, client: client as any };
}

function addJob(state: ReturnType<typeof makeClient>["state"], overrides: Record<string, unknown> = {}) {
  const row = {
    id: `job_${state.jobs.length + 1}`,
    merchantId: "merchant_1",
    connectionId: "connection_1",
    platform: StorePlatform.SHOPIFY,
    mode: "DRY_RUN",
    source: "MANUAL_PAYLOAD",
    status: PlatformImportJobStatus.QUEUED,
    createdAt: new Date(now.getTime() + state.jobs.length),
    updatedAt: now,
    ...overrides
  };
  state.jobs.push(row);
  return row;
}

function addEvent(state: ReturnType<typeof makeClient>["state"], overrides: Record<string, unknown> = {}) {
  const row = {
    id: `event_${state.events.length + 1}`,
    merchantId: "merchant_1",
    connectionId: "connection_1",
    platform: StorePlatform.SHOPIFY,
    topic: "SHOPIFY_ORDER_CREATED",
    status: "VERIFIED",
    importJobId: null,
    receivedAt: new Date(now.getTime() + state.events.length),
    ...overrides
  };
  state.events.push(row);
  return row;
}

function addItem(state: ReturnType<typeof makeClient>["state"], overrides: Record<string, unknown> = {}) {
  const row = {
    id: `item_${state.items.length + 1}`,
    merchantId: "merchant_1",
    jobId: "job_1",
    connectionId: "connection_1",
    platform: StorePlatform.SHOPIFY,
    status: PlatformImportItemStatus.FAILED,
    nextAttemptAt: new Date(now.getTime() - 60_000),
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
  state.items.push(row);
  return row;
}

describe("Phase 26 controlled worker foundation", () => {
  it("keeps workers disabled by default and records a safe skipped run", async () => {
    const { state, client } = makeClient();
    addJob(state);
    let called = false;

    const result = await runImportJobWorkerOnce("merchant_1", {}, client, {
      config: disabledConfig,
      runJob: async () => {
        called = true;
      }
    });

    assert.equal(result.run.status, "SKIPPED");
    assert.equal(result.run.mode, "DISABLED");
    assert.equal(called, false);
    assert.equal(state.runs.length, 1);
    assert.equal(JSON.stringify(result).includes("external_calls_made"), true);
  });

  it("defaults enabled workers to dry-run and caps the max batch", async () => {
    const { state, client } = makeClient();
    addJob(state);
    addJob(state);
    addJob(state);
    let called = 0;

    const result = await runImportJobWorkerOnce("merchant_1", { max_batch: 99 }, client, {
      config: enabledConfig({ dryRun: true, maxBatch: 2 }),
      runJob: async () => {
        called += 1;
      }
    });

    assert.equal(result.run.mode, "DRY_RUN");
    assert.equal(result.run.processed_count, 2);
    assert.equal(called, 0);
    assert.match(JSON.stringify(result.summary), /Dry-run|dry/i);
  });

  it("uses the import job worker only through the existing import foundation callback", async () => {
    const { state, client } = makeClient();
    addJob(state);
    addJob(state);
    const called: string[] = [];

    const result = await runImportJobWorkerOnce("merchant_1", { dry_run: false }, client, {
      config: enabledConfig({ dryRun: false, maxBatch: 2 }),
      runJob: async (_merchantId, jobId) => {
        called.push(jobId);
      }
    });

    assert.deepEqual(called, ["job_1", "job_2"]);
    assert.equal(result.run.status, "COMPLETED");
    assert.equal(result.run.processed_count, 2);
  });

  it("lets the import worker run bounded cursor next pages through the existing cursor callback", async () => {
    const { state, client } = makeClient();
    addJob(state);
    state.cursors.push({
      id: "cursor_1",
      merchantId: "merchant_1",
      connectionId: "connection_1",
      platform: StorePlatform.SHOPIFY,
      status: "HAS_MORE",
      hasMore: true,
      updatedAt: now,
      createdAt: now
    });
    const calls: string[] = [];

    const result = await runImportJobWorkerOnce("merchant_1", { dry_run: false }, client, {
      config: enabledConfig({ dryRun: false, maxBatch: 2 }),
      runJob: async (_merchantId, jobId) => {
        calls.push(`job:${jobId}`);
      },
      runCursorNextPage: async (_merchantId, cursorId) => {
        calls.push(`cursor:${cursorId}`);
      }
    });

    assert.deepEqual(calls, ["job:job_1", "cursor:cursor_1"]);
    assert.equal(result.run.processed_count, 2);
  });


  it("locks duplicate worker runs inside the configured lock window", async () => {
    const { state, client } = makeClient();
    state.runs.push({
      id: "running_1",
      workerName: "import-jobs",
      merchantId: "merchant_1",
      status: "RUNNING",
      mode: "ACTIVE",
      startedAt: new Date(),
      finishedAt: null,
      processedCount: 0,
      failedCount: 0,
      warnings: [],
      errors: [],
      createdAt: now,
      updatedAt: now
    });

    await assert.rejects(
      () => runImportJobWorkerOnce("merchant_1", {}, client, { config: enabledConfig() }),
      (error: unknown) => error instanceof HttpError && error.message === "SHIPMASTR_WORKER_LOCKED"
    );
  });

  it("allows cross-merchant worker runs with null merchantId and keeps locks global per worker", async () => {
    const { state, client } = makeClient();
    const result = await runWorkerOnce(
      null,
      "checkout-telemetry-abandonment",
      { dry_run: false },
      async () => ({
        processedCount: 0,
        summary: workerRunSummary("Cross-merchant worker completed.", {
          eligible_count: 0,
          dry_run: false
        })
      }),
      client,
      enabledConfig({ dryRun: false })
    );

    assert.equal(result.run.merchant_id, null);
    assert.equal(result.run.worker_name, "checkout-telemetry-abandonment");

    state.runs.push({
      id: "running_checkout_abandonment",
      workerName: "checkout-telemetry-abandonment",
      merchantId: "merchant_2",
      status: "RUNNING",
      mode: "ACTIVE",
      startedAt: new Date(),
      finishedAt: null,
      processedCount: 0,
      failedCount: 0,
      warnings: [],
      errors: [],
      createdAt: now,
      updatedAt: now
    });

    await assert.rejects(
      () => runWorkerOnce(
        null,
        "checkout-telemetry-abandonment",
        {},
        async () => ({
          processedCount: 0,
          summary: workerRunSummary("Should be locked.", { eligible_count: 0 })
        }),
        client,
        enabledConfig()
      ),
      (error: unknown) => error instanceof HttpError && error.message === "SHIPMASTR_WORKER_LOCKED"
    );
  });

  it("stages webhook events only through the existing staging callback", async () => {
    const { state, client } = makeClient();
    addEvent(state);
    addEvent(state, { status: "REJECTED" });
    const staged: string[] = [];

    const result = await runWebhookStagingWorkerOnce("merchant_1", { dry_run: false }, client, {
      config: enabledConfig({ dryRun: false }),
      stageEvent: async (_merchantId, eventId) => {
        staged.push(eventId);
      }
    });

    assert.deepEqual(staged, ["event_1"]);
    assert.equal(result.run.processed_count, 1);
    assert.doesNotMatch(JSON.stringify(result), /rawPayload|rawHeaders|secret|token|Bigship/i);
  });

  it("generates in-app notification digests only when enabled and not dry-run", async () => {
    const { state, client } = makeClient();
    addJob(state, { status: PlatformImportJobStatus.FAILED });
    let digests = 0;

    const dry = await runNotificationWorkerOnce("merchant_1", {}, client, {
      config: enabledConfig({ dryRun: true }),
      generateDigest: async () => {
        digests += 1;
      }
    });
    assert.equal(digests, 0);
    assert.equal(dry.run.mode, "DRY_RUN");

    const active = await runNotificationWorkerOnce("merchant_1", { dry_run: false }, client, {
      config: enabledConfig({ dryRun: false }),
      generateDigest: async () => {
        digests += 1;
      }
    });
    assert.equal(digests, 1);
    assert.equal(active.run.processed_count, 1);
  });

  it("surfaces retry-ready items without automatically rerunning imports", async () => {
    const { state, client } = makeClient();
    addItem(state);
    addItem(state, { id: "future_item", nextAttemptAt: new Date(Date.now() + 60_000) });
    const notified: string[] = [];

    const result = await runRetryWorkerOnce("merchant_1", { dry_run: false }, client, {
      config: enabledConfig({ dryRun: false }),
      notifyRetryReady: async (item) => {
        notified.push((item as { id: string }).id);
      }
    });

    assert.deepEqual(notified, ["item_1"]);
    assert.equal(result.run.processed_count, 1);
  });

  it("returns safe worker health and merchant-scoped run history", async () => {
    const { state, client } = makeClient();
    await runImportJobWorkerOnce("merchant_1", {}, client, { config: disabledConfig });
    await runImportJobWorkerOnce("merchant_2", {}, client, { config: disabledConfig });

    const health = await getWorkerHealth("merchant_1", disabledConfig, client);
    const runs = await listWorkerRuns("merchant_1", { page: 1, per_page: 20 }, client);

    assert.equal(health.enabled, false);
    assert.equal(health.scheduler_started, false);
    assert.ok(health.workers.some((worker) => worker.worker_name === "checkout-telemetry-abandonment"));
    assert.equal(health.workers.find((worker) => worker.worker_name === "checkout-telemetry-abandonment")?.enabled, false);
    assert.equal(health.latest_runs.length, 1);
    assert.equal(runs.runs.length, 1);
    assert.equal(state.runs.length, 2);
  });

  it("does not add schedulers, provider calls, rates, labels, platform writes, or email sends", () => {
    const files = [
      "src/modules/workers/import-job.worker.ts",
      "src/modules/workers/webhook-staging.worker.ts",
      "src/modules/workers/notification.worker.ts",
      "src/modules/workers/retry.worker.ts",
      "src/modules/workers/worker-health.service.ts",
      "src/modules/checkout/checkout-telemetry-abandonment.worker.ts"
    ].map((file) => readFileSync(file, "utf8")).join("\n");

    assert.doesNotMatch(files, /setInterval|cron|sendMail|nodemailer|smtp|createLabel|getLabel|manifestOrder|getRates|webhook registration/i);
  });
});
