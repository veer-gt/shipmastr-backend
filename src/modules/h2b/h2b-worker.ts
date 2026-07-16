import { H2BAdmissionStatus, H2BOutboxStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;
export type ClaimedH2BOutbox = Prisma.H2BWebhookOutboxGetPayload<{ include: { admission: true } }>;

async function withTransaction<T>(client: Db, callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await (client as typeof prisma).$transaction(callback, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
      catch (error) {
        if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"))) continue;
        throw error;
      }
    }
  }
  return callback(client as Prisma.TransactionClient);
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function mergeNonNull(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = mergeNonNull(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isCreateTopic(topic: string) { return topic === "orders/create" || topic === "order.created" || topic === "shipmastr.order.committed.v1"; }
function isUpdateTopic(topic: string) { return topic === "orders/updated" || topic === "order.updated"; }

export async function claimOneH2BOutbox(client: Db = prisma, now = new Date(), leaseUntil = new Date(now.getTime() + 5 * 60_000)): Promise<ClaimedH2BOutbox | null> {
  return withTransaction(client, async (tx) => {
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "h2b_webhook_outbox"
      WHERE (
        (status = ${H2BOutboxStatus.PENDING}::"H2BOutboxStatus" AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})) OR
        (status = ${H2BOutboxStatus.FAILED}::"H2BOutboxStatus" AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})) OR
        (status IN (${H2BOutboxStatus.CLAIMED}::"H2BOutboxStatus", ${H2BOutboxStatus.PROCESSING}::"H2BOutboxStatus") AND lease_until < ${now})
      )
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (!candidates[0]) return null;
    const candidate = await tx.h2BWebhookOutbox.findUnique({ where: { id: candidates[0].id }, include: { admission: true } });
    if (!candidate) return null;
    const updated = await tx.h2BWebhookOutbox.updateMany({
      where: { id: candidate.id, status: candidate.status, ...(candidate.status === H2BOutboxStatus.CLAIMED || candidate.status === H2BOutboxStatus.PROCESSING ? { leaseUntil: { lt: now } } : {}) },
      data: { status: H2BOutboxStatus.CLAIMED, claimedAt: now, leaseUntil: leaseUntil, attemptCount: { increment: 1 }, claimVersion: { increment: 1 } }
    });
    if (updated.count !== 1) return null;
    return tx.h2BWebhookOutbox.findUnique({ where: { id: candidate.id }, include: { admission: true } });
  });
}

export async function failClaimedH2BOutbox(claimed: ClaimedH2BOutbox, failureClass: string, client: Db = prisma) {
  const terminal = claimed.attemptCount >= 5;
  return withTransaction(client, async (tx) => {
    const updated = await tx.h2BWebhookOutbox.updateMany({
      where: { id: claimed.id, status: { in: [H2BOutboxStatus.CLAIMED, H2BOutboxStatus.PROCESSING] }, claimVersion: claimed.claimVersion },
      data: { status: terminal ? H2BOutboxStatus.DEAD_LETTER : H2BOutboxStatus.FAILED, failedAt: new Date(), failureClass, nextAttemptAt: terminal ? null : new Date(Date.now() + Math.min(60 * 60_000, 2 ** Math.max(0, claimed.attemptCount - 1) * 1_000)), leaseUntil: null }
    });
    if (updated.count !== 1) return "FENCED" as const;
    if (terminal) {
      const admission = await tx.h2BWebhookAdmission.updateMany({ where: { id: claimed.admissionId, status: H2BAdmissionStatus.ACCEPTED }, data: { status: H2BAdmissionStatus.FAILED, failureClass } });
      if (admission.count !== 1) throw new Error("H2B_ADMISSION_FENCED");
    }
    return terminal ? "DEAD_LETTER" as const : "FAILED" as const;
  });
}

async function lockAggregate(tx: Prisma.TransactionClient, claimed: ClaimedH2BOutbox, externalOrderId: string) {
  await tx.$executeRaw`
    INSERT INTO "h2b_external_order_aggregates" (id, merchant_id, connection_id, platform, external_order_id, safe_state, latest_create_sequence, latest_update_sequence, latest_seen_sequence, created_at, updated_at)
    VALUES (${`h2b_${claimed.merchantId}_${claimed.connectionId}_${externalOrderId}`}, ${claimed.merchantId}, ${claimed.connectionId}, ${claimed.platform}::"StorePlatform", ${externalOrderId}, '{}'::jsonb, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (merchant_id, connection_id, external_order_id) DO NOTHING
  `;
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "h2b_external_order_aggregates"
    WHERE merchant_id = ${claimed.merchantId} AND connection_id = ${claimed.connectionId} AND external_order_id = ${externalOrderId}
    FOR UPDATE
  `;
  if (!locked[0]) throw new Error("H2B_AGGREGATE_LOCK_FAILED");
  return tx.h2BExternalOrderAggregate.findUnique({ where: { id: locked[0].id } });
}

export async function processClaimedH2BOutbox(claimed: ClaimedH2BOutbox, client: Db = prisma) {
  const envelope = asRecord(claimed.envelope);
  const externalOrderId = typeof envelope.externalOrderId === "string" ? envelope.externalOrderId : "";
  if (!externalOrderId) return failClaimedH2BOutbox(claimed, "H2B_EXTERNAL_ORDER_ID_REQUIRED", client);
  return withTransaction(client, async (tx) => {
    const fenced = await tx.h2BWebhookOutbox.updateMany({ where: { id: claimed.id, status: H2BOutboxStatus.CLAIMED, claimVersion: claimed.claimVersion }, data: { status: H2BOutboxStatus.PROCESSING } });
    if (fenced.count !== 1) return "FENCED" as const;
    const current = await lockAggregate(tx, claimed, externalOrderId);
    if (!current) throw new Error("H2B_AGGREGATE_NOT_FOUND");
    const sequence = claimed.admission.ingestionSequence;
    const createState = asRecord(current.createState);
    const updateState = asRecord(current.updateState);
    let nextCreate = createState;
    let nextUpdate = updateState;
    if (isCreateTopic(claimed.topic) && sequence > current.latestCreateSequence) nextCreate = mergeNonNull(createState, envelope);
    if (isUpdateTopic(claimed.topic) && sequence > current.latestUpdateSequence) nextUpdate = mergeNonNull(updateState, envelope);
    const latestSeen = sequence > current.latestSeenSequence ? sequence : current.latestSeenSequence;
    const safeState = mergeNonNull(nextCreate, nextUpdate);
    await tx.h2BExternalOrderAdmissionReference.createMany({
      data: [{ aggregateId: current.id, admissionId: claimed.admissionId, ingestionSequence: sequence, topic: claimed.topic }],
      skipDuplicates: true
    });
    const updateData: Prisma.H2BExternalOrderAggregateUpdateInput = {
      createState: nextCreate as Prisma.InputJsonValue,
      updateState: nextUpdate as Prisma.InputJsonValue,
      safeState: safeState as Prisma.InputJsonValue,
      latestCreateSequence: isCreateTopic(claimed.topic) && sequence > current.latestCreateSequence ? sequence : current.latestCreateSequence,
      latestUpdateSequence: isUpdateTopic(claimed.topic) && sequence > current.latestUpdateSequence ? sequence : current.latestUpdateSequence,
      latestSeenSequence: latestSeen,
      latestEventAt: sequence === latestSeen ? claimed.admission.receivedAt : current.latestEventAt,
      latestTopic: sequence === latestSeen ? claimed.topic : current.latestTopic,
      externalOrderName: typeof safeState.externalOrderName === "string" ? safeState.externalOrderName : null
    };
    await tx.h2BExternalOrderAggregate.update({ where: { id: current.id }, data: updateData });
    const outbox = await tx.h2BWebhookOutbox.updateMany({ where: { id: claimed.id, status: H2BOutboxStatus.PROCESSING, claimVersion: claimed.claimVersion }, data: { status: H2BOutboxStatus.PROCESSED, processedAt: new Date(), leaseUntil: null } });
    if (outbox.count !== 1) throw new Error("H2B_OUTBOX_FENCED");
    const admission = await tx.h2BWebhookAdmission.updateMany({ where: { id: claimed.admissionId, status: H2BAdmissionStatus.ACCEPTED }, data: { status: H2BAdmissionStatus.PROCESSED, processedAt: new Date() } });
    if (admission.count !== 1) throw new Error("H2B_ADMISSION_FENCED");
    return "PROCESSED" as const;
  });
}

export async function runH2BOutboxOnce(input: { maxBatch?: number; now?: Date } = {}, client: Db = prisma) {
  const maxBatch = Math.max(1, Math.min(input.maxBatch ?? 25, 100));
  const now = input.now ?? new Date(); let processed = 0; let failed = 0;
  for (let index = 0; index < maxBatch; index += 1) {
    const claimed = await claimOneH2BOutbox(client, now, new Date(now.getTime() + 5 * 60_000));
    if (!claimed) break;
    try {
      const result = await processClaimedH2BOutbox(claimed, client);
      if (result === "PROCESSED") processed += 1;
      if (result === "FAILED" || result === "DEAD_LETTER") failed += 1;
    } catch {
      failed += 1;
      await failClaimedH2BOutbox(claimed, "H2B_WORKER_PROCESSING_FAILED", client);
    }
  }
  return { processedCount: processed, failedCount: failed, externalCallsMade: false, providerWrites: false, inventoryMutations: false, canonicalOrderMutations: false };
}
