import { H2BAdmissionStatus, H2BOutboxStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;
type Claimed = { id: string; admissionId: string; merchantId: string; connectionId: string; platform: any; topic: string; envelope: Prisma.JsonValue; attemptCount: number; claimVersion: bigint; admission: { ingestionSequence: bigint; receivedAt: Date } };

async function withTransaction<T>(client: Db, callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction(callback, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  return callback(client as Prisma.TransactionClient);
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

async function claimOne(client: Db, now: Date, leaseUntil: Date): Promise<Claimed | null> {
  return withTransaction(client, async (tx) => {
    const candidate = await tx.h2BWebhookOutbox.findFirst({ where: { OR: [
      { status: H2BOutboxStatus.PENDING, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      { status: H2BOutboxStatus.FAILED, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      { status: H2BOutboxStatus.CLAIMED, leaseUntil: { lt: now } },
      { status: H2BOutboxStatus.PROCESSING, leaseUntil: { lt: now } }
    ] }, orderBy: { createdAt: "asc" }, include: { admission: true } });
    if (!candidate) return null;
    const updated = await tx.h2BWebhookOutbox.updateMany({ where: { id: candidate.id, status: candidate.status, ...(candidate.status === H2BOutboxStatus.CLAIMED || candidate.status === H2BOutboxStatus.PROCESSING ? { leaseUntil: { lt: now } } : {}) }, data: { status: H2BOutboxStatus.CLAIMED, claimedAt: now, leaseUntil, attemptCount: { increment: 1 }, claimVersion: { increment: 1 } } });
    if (updated.count !== 1) return null;
    return tx.h2BWebhookOutbox.findUnique({ where: { id: candidate.id }, include: { admission: true } }) as Promise<Claimed>;
  });
}

async function markFailure(claimed: Claimed, failureClass: string, client: Db) {
  const terminal = claimed.attemptCount >= 5;
  await withTransaction(client, async (tx) => {
    const updated = await tx.h2BWebhookOutbox.updateMany({ where: { id: claimed.id, status: { in: [H2BOutboxStatus.CLAIMED, H2BOutboxStatus.PROCESSING] }, claimVersion: claimed.claimVersion }, data: { status: terminal ? H2BOutboxStatus.DEAD_LETTER : H2BOutboxStatus.FAILED, failedAt: new Date(), failureClass, nextAttemptAt: terminal ? null : new Date(Date.now() + Math.min(60 * 60_000, 2 ** Math.max(0, claimed.attemptCount - 1) * 1_000)), leaseUntil: null } });
    if (updated.count === 1) await tx.h2BWebhookAdmission.updateMany({ where: { id: claimed.admissionId, status: { in: [H2BAdmissionStatus.ACCEPTED, H2BAdmissionStatus.PENDING] } }, data: { status: H2BAdmissionStatus.FAILED, failureClass } });
  });
}

async function processOne(claimed: Claimed, client: Db) {
  const envelope = asRecord(claimed.envelope);
  const externalOrderId = typeof envelope.externalOrderId === "string" ? envelope.externalOrderId : "";
  if (!externalOrderId) { await markFailure(claimed, "H2B_EXTERNAL_ORDER_ID_REQUIRED", client); return "FAILED" as const; }
  const result = await withTransaction(client, async (tx) => {
    const fenced = await tx.h2BWebhookOutbox.updateMany({ where: { id: claimed.id, status: H2BOutboxStatus.CLAIMED, claimVersion: claimed.claimVersion }, data: { status: H2BOutboxStatus.PROCESSING } });
    if (fenced.count !== 1) return "FENCED" as const;
    const current = await tx.h2BExternalOrderAggregate.findUnique({ where: { merchantId_connectionId_externalOrderId: { merchantId: claimed.merchantId, connectionId: claimed.connectionId, externalOrderId } } });
    const sequence = claimed.admission.ingestionSequence;
    const currentState = asRecord(current?.safeState);
    const refs = Array.isArray(currentState.admissionIds) ? currentState.admissionIds.filter((v): v is string => typeof v === "string") : [];
    const nextRefs = [...new Set([...refs, claimed.admissionId])];
    const isUpdate = claimed.topic.endsWith("updated");
    const priorWasUpdate = current?.latestTopic?.endsWith("updated") ?? false;
    const replace = !current || (isUpdate && sequence >= (current.latestSequence ?? 0n)) || (!priorWasUpdate && sequence >= (current.latestSequence ?? 0n));
    const merged = replace ? { ...currentState, ...envelope, admissionIds: nextRefs } : { ...currentState, admissionIds: nextRefs };
    const state = merged as Prisma.InputJsonValue;
    if (!current) await tx.h2BExternalOrderAggregate.create({ data: { merchantId: claimed.merchantId, connectionId: claimed.connectionId, platform: claimed.platform, externalOrderId, externalOrderName: typeof envelope.externalOrderName === "string" ? envelope.externalOrderName : null, safeState: state, latestSequence: sequence, latestEventAt: claimed.admission.receivedAt, latestTopic: claimed.topic } });
    else await tx.h2BExternalOrderAggregate.update({ where: { id: current.id }, data: { safeState: state, latestSequence: replace && sequence > current.latestSequence ? sequence : current.latestSequence, latestEventAt: replace ? claimed.admission.receivedAt : current.latestEventAt, latestTopic: replace ? claimed.topic : current.latestTopic } });
    await tx.h2BWebhookOutbox.updateMany({ where: { id: claimed.id, status: H2BOutboxStatus.PROCESSING, claimVersion: claimed.claimVersion }, data: { status: H2BOutboxStatus.PROCESSED, processedAt: new Date(), leaseUntil: null } });
    await tx.h2BWebhookAdmission.updateMany({ where: { id: claimed.admissionId, status: { in: [H2BAdmissionStatus.ACCEPTED, H2BAdmissionStatus.PENDING] } }, data: { status: H2BAdmissionStatus.PROCESSED, processedAt: new Date() } });
    return "PROCESSED" as const;
  });
  return result;
}

export async function runH2BOutboxOnce(input: { maxBatch?: number; now?: Date } = {}, client: Db = prisma) {
  const maxBatch = Math.max(1, Math.min(input.maxBatch ?? 25, 100));
  const now = input.now ?? new Date(); let processed = 0; let failed = 0;
  for (let index = 0; index < maxBatch; index += 1) {
    const claimed = await claimOne(client, now, new Date(now.getTime() + 5 * 60_000));
    if (!claimed) break;
    try { const result = await processOne(claimed, client); if (result === "PROCESSED") processed += 1; if (result === "FAILED") failed += 1; }
    catch { failed += 1; await markFailure(claimed, "H2B_WORKER_PROCESSING_FAILED", client); }
  }
  return { processedCount: processed, failedCount: failed, externalCallsMade: false, providerWrites: false, inventoryMutations: false, canonicalOrderMutations: false };
}
