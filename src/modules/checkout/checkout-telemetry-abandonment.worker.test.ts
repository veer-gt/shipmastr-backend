import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  CHECKOUT_ABANDONED_EVENT_NAME,
  CHECKOUT_ABANDONED_FAILURE_CODE,
  CHECKOUT_PAYMENT_REFUND_DUE_FAILURE_CODE,
  runCheckoutTelemetryAbandonmentWorkerOnce
} from "./checkout-telemetry-abandonment.worker.js";
import type { ShipmastrWorkerConfig } from "../workers/worker.types.js";

const now = new Date("2026-07-06T12:00:00.000Z");
const oldStartedAt = new Date("2026-07-06T10:30:00.000Z");

const enabledConfig: ShipmastrWorkerConfig = {
  workersEnabled: true,
  importWorkerEnabled: false,
  webhookWorkerEnabled: false,
  notificationWorkerEnabled: false,
  retryWorkerEnabled: false,
  checkoutTelemetryAbandonmentWorkerEnabled: true,
  maxBatch: 20,
  lockSeconds: 300,
  dryRun: true
};

function clone<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function uniqueConflict() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

function matches(row: Record<string, any>, where: Record<string, any> = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("lte" in expected) return row[key] instanceof Date && row[key] <= (expected as { lte: Date }).lte;
      if ("gte" in expected) return row[key] instanceof Date && row[key] >= (expected as { gte: Date }).gte;
      if ("in" in expected) return (expected as { in: unknown[] }).in.includes(row[key]);
    }
    return row[key] === expected;
  });
}

function pageRows<T extends Record<string, any>>(rows: T[], args: any = {}) {
  const sorted = [...rows];
  if (args.orderBy?.startedAt === "asc") sorted.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
  if (args.orderBy?.createdAt === "asc") sorted.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  if (args.orderBy?.occurredAt === "asc") sorted.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? sorted.length));
}

function makeClient() {
  const state = {
    runs: [] as any[],
    sessions: [] as any[],
    events: [] as any[],
    failures: [] as any[],
    attempts: [] as any[],
    payments: [] as any[]
  };

  const client: any = {
    $transaction: async (callback: (tx: any) => Promise<void>) => callback(client),
    shipmastrWorkerRun: {
      create: async ({ data }: any) => {
        const row = {
          id: `worker_run_${state.runs.length + 1}`,
          workerName: data.workerName,
          merchantId: data.merchantId ?? null,
          status: data.status,
          mode: data.mode,
          startedAt: now,
          finishedAt: data.finishedAt ?? null,
          processedCount: data.processedCount ?? 0,
          failedCount: data.failedCount ?? 0,
          warnings: data.warnings ?? [],
          errors: data.errors ?? [],
          createdAt: now,
          updatedAt: now
        };
        state.runs.push(row);
        return clone(row);
      },
      findFirst: async ({ where = {} }: any = {}) => clone(state.runs.find((row) => matches(row, where)) ?? null),
      update: async ({ where, data }: any) => {
        const row = state.runs.find((item) => item.id === where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return clone(row);
      }
    },
    checkoutTelemetrySession: {
      findMany: async (args: any = {}) => pageRows(state.sessions.filter((row) => matches(row, args.where ?? {})), args).map(clone),
      update: async ({ where, data }: any) => {
        const row = state.sessions.find((item) => item.id === where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return clone(row);
      }
    },
    checkoutTelemetryEvent: {
      create: async ({ data }: any) => {
        if (data.idempotencyKey) {
          const existing = state.events.find((row) =>
            row.telemetrySessionId === data.telemetrySessionId
            && row.eventName === data.eventName
            && row.idempotencyKey === data.idempotencyKey
          );
          if (existing) throw uniqueConflict();
        }
        const row = {
          id: `telemetry_event_${state.events.length + 1}`,
          occurredAt: data.occurredAt ?? now,
          createdAt: now,
          ...data
        };
        state.events.push(row);
        return clone(row);
      },
      findFirst: async ({ where = {}, orderBy }: any = {}) => clone(pageRows(state.events.filter((row) => matches(row, where)), { orderBy })[0] ?? null),
      findUnique: async ({ where }: any) => {
        const unique = where.telemetrySessionId_eventName_idempotencyKey;
        return clone(state.events.find((row) => matches(row, unique)) ?? null);
      }
    },
    checkoutTelemetryFailure: {
      create: async ({ data }: any) => {
        const row = {
          id: `telemetry_failure_${state.failures.length + 1}`,
          createdAt: now,
          ...data
        };
        state.failures.push(row);
        return clone(row);
      },
      findFirst: async ({ where = {}, orderBy }: any = {}) => clone(pageRows(state.failures.filter((row) => matches(row, where)), { orderBy })[0] ?? null)
    },
    checkoutTelemetryPaymentAttempt: {
      findFirst: async ({ where = {}, orderBy }: any = {}) => clone(pageRows(state.attempts.filter((row) => matches(row, where)), { orderBy })[0] ?? null)
    },
    checkoutPayment: {
      findFirst: async ({ where = {}, orderBy }: any = {}) => clone(pageRows(state.payments.filter((row) => matches(row, where)), { orderBy })[0] ?? null)
    }
  };

  return { state, client };
}

function addSession(state: ReturnType<typeof makeClient>["state"], overrides: Record<string, unknown> = {}) {
  const row = {
    id: `telemetry_session_${state.sessions.length + 1}`,
    merchantId: "merchant_c13",
    sellerId: null,
    checkoutOrderId: `checkout_order_${state.sessions.length + 1}`,
    sessionId: `checkout_order:${state.sessions.length + 1}`,
    cartValueMinor: 299900n,
    currency: "INR",
    cartSize: 2,
    status: "STARTED",
    startedAt: oldStartedAt,
    completedAt: null,
    abandonedAt: null,
    createdAt: oldStartedAt,
    updatedAt: oldStartedAt,
    ...overrides
  };
  state.sessions.push(row);
  return row;
}

function addEvent(state: ReturnType<typeof makeClient>["state"], overrides: Record<string, unknown> = {}) {
  const row = {
    id: `telemetry_event_${state.events.length + 1}`,
    telemetrySessionId: "telemetry_session_1",
    merchantId: "merchant_c13",
    eventName: "order_placed",
    checkoutOrderId: "checkout_order_1",
    checkoutPaymentId: null,
    idempotencyKey: null,
    source: "ORDER_SERVICE",
    occurredAt: oldStartedAt,
    payloadJson: {},
    createdAt: oldStartedAt,
    ...overrides
  };
  state.events.push(row);
  return row;
}

function addPayment(state: ReturnType<typeof makeClient>["state"], overrides: Record<string, unknown> = {}) {
  const row = {
    id: `checkout_payment_${state.payments.length + 1}`,
    merchantId: "merchant_c13",
    orderId: "checkout_order_1",
    amountMinor: 299900n,
    currency: "INR",
    purpose: "full",
    gateway: "mock",
    state: "created",
    createdAt: oldStartedAt,
    updatedAt: oldStartedAt,
    ...overrides
  };
  state.payments.push(row);
  return row;
}

async function runWorker(client: any, input: Record<string, unknown> = {}) {
  return runCheckoutTelemetryAbandonmentWorkerOnce({
    dry_run: false,
    max_batch: 20,
    older_than_minutes: 60,
    now,
    ...input
  }, client, { config: { ...enabledConfig, dryRun: false } });
}

describe("Checkout telemetry abandonment worker", () => {
  it("dry-runs stale unpaid sessions even when checkoutOrderId and order_placed exist", async () => {
    const { state, client } = makeClient();
    const session = addSession(state);
    addEvent(state, {
      telemetrySessionId: session.id,
      checkoutOrderId: session.checkoutOrderId
    });

    const result = await runCheckoutTelemetryAbandonmentWorkerOnce({
      dry_run: true,
      max_batch: 20,
      older_than_minutes: 60,
      now
    }, client, { config: enabledConfig });

    assert.equal(result.run.merchant_id, null);
    assert.equal(result.run.worker_name, "checkout-telemetry-abandonment");
    assert.equal(result.summary.dry_run, true);
    assert.equal(result.summary.eligible_count, 1);
    assert.deepEqual(result.summary.processed_ids, [session.id]);
    assert.equal(result.summary.external_calls_made, false);
    assert.equal(result.summary.platform_writes, false);
    assert.equal(result.summary.courier_calls, false);
    assert.equal(state.events.filter((event) => event.eventName === CHECKOUT_ABANDONED_EVENT_NAME).length, 0);
    assert.equal(state.failures.length, 0);
    assert.equal(state.sessions[0].status, "STARTED");
  });

  it("marks stale unpaid checkout/order sessions abandoned and records one idempotent failure", async () => {
    const { state, client } = makeClient();
    const session = addSession(state);
    addEvent(state, {
      telemetrySessionId: session.id,
      checkoutOrderId: session.checkoutOrderId
    });
    addPayment(state, {
      orderId: session.checkoutOrderId,
      state: "created"
    });

    const first = await runWorker(client);
    const second = await runWorker(client);

    const abandonedEvents = state.events.filter((event) => event.eventName === CHECKOUT_ABANDONED_EVENT_NAME);
    const abandonedFailures = state.failures.filter((failure) => failure.failureCode === CHECKOUT_ABANDONED_FAILURE_CODE);

    assert.equal(first.summary.eligible_count, 1);
    assert.equal(first.run.status, "COMPLETED");
    assert.equal(second.summary.eligible_count, 0);
    assert.equal(abandonedEvents.length, 1);
    assert.equal(abandonedEvents[0].idempotencyKey, `checkout_abandoned:${session.id}`);
    assert.equal(abandonedFailures.length, 1);
    assert.equal(abandonedFailures[0].failureStage, "PAYMENT");
    assert.equal(abandonedFailures[0].amountAtRiskMinor, 299900n);
    assert.equal(state.sessions[0].status, "ABANDONED");
    assert.equal(state.sessions[0].abandonedAt.toISOString(), now.toISOString());
  });

  it("does not abandon sessions with payment_succeeded telemetry", async () => {
    const { state, client } = makeClient();
    const session = addSession(state);
    addEvent(state, {
      telemetrySessionId: session.id,
      eventName: "payment_succeeded",
      checkoutOrderId: session.checkoutOrderId,
      checkoutPaymentId: "checkout_payment_1",
      idempotencyKey: "payment_succeeded_1",
      source: "PAYMENT_WEBHOOK"
    });

    const result = await runWorker(client);

    assert.equal(result.summary.eligible_count, 0);
    assert.equal(state.events.filter((event) => event.eventName === CHECKOUT_ABANDONED_EVENT_NAME).length, 0);
    assert.equal(state.sessions[0].status, "STARTED");
  });

  it("does not abandon sessions with captured authoritative payments", async () => {
    const { state, client } = makeClient();
    const session = addSession(state);
    addPayment(state, {
      orderId: session.checkoutOrderId,
      state: "captured"
    });

    const result = await runWorker(client);

    assert.equal(result.summary.eligible_count, 0);
    assert.equal(state.failures.filter((failure) => failure.failureCode === CHECKOUT_ABANDONED_FAILURE_CODE).length, 0);
    assert.equal(state.sessions[0].status, "STARTED");
  });

  it("does not abandon refund_due sessions already classified as refund-due payment leakage", async () => {
    const { state, client } = makeClient();
    const session = addSession(state);
    addPayment(state, {
      orderId: session.checkoutOrderId,
      state: "refund_due"
    });
    state.failures.push({
      id: "refund_due_failure_1",
      telemetrySessionId: session.id,
      merchantId: session.merchantId,
      checkoutOrderId: session.checkoutOrderId,
      failureStage: "PAYMENT",
      failureReason: "late_capture_refund_due",
      failureCode: CHECKOUT_PAYMENT_REFUND_DUE_FAILURE_CODE,
      amountAtRiskMinor: 299900n,
      currency: "INR",
      isRecoverable: true,
      source: "PAYMENT_WEBHOOK",
      createdAt: oldStartedAt
    });

    const result = await runWorker(client);

    assert.equal(result.summary.eligible_count, 0);
    assert.equal(state.events.filter((event) => event.eventName === CHECKOUT_ABANDONED_EVENT_NAME).length, 0);
    assert.equal(state.failures.filter((failure) => failure.failureCode === CHECKOUT_ABANDONED_FAILURE_CODE).length, 0);
    assert.equal(state.failures.filter((failure) => failure.failureCode === CHECKOUT_PAYMENT_REFUND_DUE_FAILURE_CODE).length, 1);
    assert.equal(state.sessions[0].status, "STARTED");
  });

  it("excludes completed and already abandoned sessions", async () => {
    const { state, client } = makeClient();
    addSession(state, { id: "completed_session", status: "COMPLETED" });
    addSession(state, { id: "abandoned_session", status: "ABANDONED", abandonedAt: oldStartedAt });

    const result = await runWorker(client);

    assert.equal(result.summary.eligible_count, 0);
    assert.equal(state.events.filter((event) => event.eventName === CHECKOUT_ABANDONED_EVENT_NAME).length, 0);
  });

  it("keeps the worker cross-merchant, MASTER_ADMIN-only, registry-visible, and scheduler-free", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const adminRoutes = readFileSync("src/modules/checkout/checkout-intelligence-admin.routes.ts", "utf8");
    const merchantWorkerRoutes = readFileSync("src/modules/workers/workers.routes.ts", "utf8");
    const registry = readFileSync("src/modules/workers/worker-registry.ts", "utf8");
    const config = readFileSync("src/modules/workers/worker-config.ts", "utf8");
    const worker = readFileSync("src/modules/checkout/checkout-telemetry-abandonment.worker.ts", "utf8");
    const schema = readFileSync("prisma/schema.prisma", "utf8");

    assert.match(registry, /checkout-telemetry-abandonment/);
    assert.match(config, /checkoutTelemetryAbandonmentWorkerEnabled/);
    assert.match(routes, /requireMasterAdminJwt, adminCheckoutIntelligenceRouter/);
    assert.match(routes, /apiRouter\.use\("\/admin\/checkout-intelligence"/);
    assert.match(adminRoutes, /abandonment-worker\/run-once/);
    assert.doesNotMatch(adminRoutes, /req\.auth!\.merchantId/);
    assert.doesNotMatch(merchantWorkerRoutes, /checkout-telemetry-abandonment|abandonment-worker/);
    assert.match(worker, /runWorkerOnce\(\s*null,\s*CHECKOUT_TELEMETRY_ABANDONMENT_WORKER_NAME/);
    assert.match(worker, /function hasTerminalMoneyMovedPayment/);
    assert.match(worker, /state: \{ in: \["captured", "refund_due"\] \}/);
    assert.doesNotMatch(worker, /setInterval|node-cron|BullMQ|Queue|Cloud Scheduler/i);
    assert.doesNotMatch(schema, /model CheckoutTelemetryAbandonment\b/);
  });
});
