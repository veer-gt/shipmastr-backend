import { prisma } from "../../lib/prisma.js";
import { defaultWorkerConfig } from "../workers/worker-config.js";
import { runWorkerOnce, workerRunSummary, type WorkerDb } from "../workers/worker-health.service.js";
import type { ShipmastrWorkerConfig, WorkerRunOnceInput } from "../workers/worker.types.js";
import { CheckoutTelemetryService, type CheckoutTelemetryFailureStage } from "./checkout-telemetry.service.js";

export const CHECKOUT_TELEMETRY_ABANDONMENT_WORKER_NAME = "checkout-telemetry-abandonment" as const;
export const CHECKOUT_ABANDONED_EVENT_NAME = "checkout_abandoned" as const;
export const CHECKOUT_ABANDONED_FAILURE_CODE = "CHECKOUT_ABANDONED" as const;
export const CHECKOUT_PAYMENT_REFUND_DUE_FAILURE_CODE = "CHECKOUT_PAYMENT_REFUND_DUE" as const;
export const DEFAULT_ABANDONMENT_WINDOW_MINUTES = 60;

type CheckoutTelemetrySessionRow = {
  id: string;
  merchantId: string;
  sellerId?: string | null;
  checkoutOrderId?: string | null;
  sessionId: string;
  cartValueMinor?: bigint | number | string | null;
  currency?: string | null;
  status: string;
  startedAt: Date;
};

type RunInput = WorkerRunOnceInput & {
  dryRun?: boolean | undefined;
  maxBatch?: number | undefined;
  olderThanMinutes?: number | undefined;
  older_than_minutes?: number | undefined;
  now?: string | Date | undefined;
};

type AbandonmentScanInput = {
  dryRun: boolean;
  maxBatch: number;
  olderThanMinutes: number;
  now: Date;
};

type AbandonmentCandidate = {
  session: CheckoutTelemetrySessionRow;
  failureStage: CheckoutTelemetryFailureStage;
};

function normalizePositiveInt(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function normalizeNow(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function normalizeWorkerInput(input: RunInput): WorkerRunOnceInput {
  return {
    dry_run: input.dry_run ?? input.dryRun,
    max_batch: input.max_batch ?? input.maxBatch,
    older_than_minutes: input.older_than_minutes ?? input.olderThanMinutes,
    now: input.now
  };
}

function safeAmountMinor(value: unknown) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function safeCurrency(value: unknown) {
  const normalized = String(value || "INR").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : "INR";
}

function abandonmentIdempotencyKey(sessionId: string) {
  return `checkout_abandoned:${sessionId}`;
}

async function hasTelemetryEvent(client: WorkerDb, telemetrySessionId: string, eventName: string) {
  const event = await client.checkoutTelemetryEvent.findFirst({
    where: {
      telemetrySessionId,
      eventName
    },
    orderBy: { occurredAt: "asc" }
  });
  return Boolean(event);
}

async function hasTerminalMoneyMovedPayment(client: WorkerDb, checkoutOrderId?: string | null) {
  if (!checkoutOrderId) return false;
  const payment = await client.checkoutPayment.findFirst({
    where: {
      orderId: checkoutOrderId,
      state: { in: ["captured", "refund_due"] }
    },
    orderBy: { createdAt: "asc" }
  });
  return Boolean(payment);
}

async function deriveFailureStage(client: WorkerDb, session: CheckoutTelemetrySessionRow): Promise<CheckoutTelemetryFailureStage> {
  const [attempt, paymentFailure, payment] = await Promise.all([
    client.checkoutTelemetryPaymentAttempt.findFirst({
      where: { telemetrySessionId: session.id },
      orderBy: { createdAt: "asc" }
    }),
    client.checkoutTelemetryFailure.findFirst({
      where: {
        telemetrySessionId: session.id,
        failureStage: "PAYMENT"
      },
      orderBy: { createdAt: "asc" }
    }),
    session.checkoutOrderId
      ? client.checkoutPayment.findFirst({
          where: { orderId: session.checkoutOrderId },
          orderBy: { createdAt: "asc" }
        })
      : Promise.resolve(null)
  ]);

  return attempt || paymentFailure || payment ? "PAYMENT" : "UNKNOWN";
}

async function eligibleCandidate(client: WorkerDb, session: CheckoutTelemetrySessionRow): Promise<AbandonmentCandidate | null> {
  if (session.status !== "STARTED") return null;
  if (await hasTelemetryEvent(client, session.id, "payment_succeeded")) return null;
  if (await hasTelemetryEvent(client, session.id, CHECKOUT_ABANDONED_EVENT_NAME)) return null;
  if (await hasTerminalMoneyMovedPayment(client, session.checkoutOrderId)) return null;

  return {
    session,
    failureStage: await deriveFailureStage(client, session)
  };
}

async function writeAbandonment(client: WorkerDb, telemetry: CheckoutTelemetryService, candidate: AbandonmentCandidate, now: Date, olderThanMinutes: number) {
  const { session, failureStage } = candidate;
  const event = await telemetry.recordEvent({
    telemetrySessionId: session.id,
    merchantId: session.merchantId,
    sellerId: session.sellerId ?? null,
    checkoutOrderId: session.checkoutOrderId ?? null,
    eventName: CHECKOUT_ABANDONED_EVENT_NAME,
    idempotencyKey: abandonmentIdempotencyKey(session.id),
    source: "WORKER",
    occurredAt: now,
    payloadJson: {
      reason: "stale_unpaid_checkout_order_session",
      olderThanMinutes,
      startedAt: session.startedAt.toISOString(),
      previousStatus: session.status,
      checkoutOrderLinked: Boolean(session.checkoutOrderId)
    }
  }, { client });

  await telemetry.createFailureIfMissing({
    telemetrySessionId: session.id,
    merchantId: session.merchantId,
    sellerId: session.sellerId ?? null,
    checkoutOrderId: session.checkoutOrderId ?? null,
    failureStage,
    failureReason: CHECKOUT_ABANDONED_EVENT_NAME,
    failureCode: CHECKOUT_ABANDONED_FAILURE_CODE,
    amountAtRiskMinor: safeAmountMinor(session.cartValueMinor),
    currency: safeCurrency(session.currency),
    isRecoverable: true,
    source: "WORKER"
  }, { client });

  await client.checkoutTelemetrySession.update({
    where: { id: session.id },
    data: {
      status: "ABANDONED",
      abandonedAt: now
    }
  });

  return event;
}

export async function scanCheckoutTelemetryAbandonment(input: AbandonmentScanInput, client: WorkerDb) {
  const cutoff = new Date(input.now.getTime() - input.olderThanMinutes * 60_000);
  const sessions = await client.checkoutTelemetrySession.findMany({
    where: {
      status: "STARTED",
      startedAt: { lte: cutoff }
    },
    orderBy: { startedAt: "asc" },
    take: input.maxBatch
  }) as CheckoutTelemetrySessionRow[];

  const candidates: AbandonmentCandidate[] = [];
  for (const session of sessions) {
    const candidate = await eligibleCandidate(client, session);
    if (candidate) candidates.push(candidate);
  }

  if (input.dryRun) {
    return {
      processedCount: candidates.length,
      warnings: ["Dry-run only. No checkout telemetry events, failures, or session updates were written."],
      summary: workerRunSummary("Checkout telemetry abandonment dry-run completed.", {
        eligible_count: candidates.length,
        processed_ids: candidates.map((candidate) => candidate.session.id),
        dry_run: true
      })
    };
  }

  const telemetry = new CheckoutTelemetryService(client, () => input.now);
  const processedIds: string[] = [];
  for (const candidate of candidates) {
    const run = async (tx: WorkerDb) => {
      const txTelemetry = new CheckoutTelemetryService(tx, () => input.now);
      await writeAbandonment(tx, txTelemetry, candidate, input.now, input.olderThanMinutes);
    };
    if (typeof (client as { $transaction?: unknown }).$transaction === "function") {
      await (client as { $transaction: (cb: (tx: WorkerDb) => Promise<void>) => Promise<void> }).$transaction(run);
    } else {
      await writeAbandonment(client, telemetry, candidate, input.now, input.olderThanMinutes);
    }
    processedIds.push(candidate.session.id);
  }

  return {
    processedCount: processedIds.length,
    summary: workerRunSummary("Checkout telemetry abandonment worker completed.", {
      eligible_count: candidates.length,
      processed_ids: processedIds,
      dry_run: false
    })
  };
}

export async function runCheckoutTelemetryAbandonmentWorkerOnce(
  input: RunInput = {},
  client: WorkerDb = prisma,
  options: { config?: ShipmastrWorkerConfig } = {}
) {
  const config = options.config ?? defaultWorkerConfig();
  const normalizedInput = normalizeWorkerInput(input);
  return runWorkerOnce(
    null,
    CHECKOUT_TELEMETRY_ABANDONMENT_WORKER_NAME,
    normalizedInput,
    async ({ dryRun, maxBatch, input: workerInput }) => {
      const olderThanMinutes = normalizePositiveInt(workerInput.older_than_minutes, DEFAULT_ABANDONMENT_WINDOW_MINUTES);
      const now = normalizeNow(workerInput.now);
      return scanCheckoutTelemetryAbandonment({
        dryRun,
        maxBatch,
        olderThanMinutes,
        now
      }, client);
    },
    client,
    config
  );
}
