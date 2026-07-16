import { H2BAdmissionStatus, H2BOutboxStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

async function withTransaction<T>(client: Db, callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction(callback, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
  }
  return callback(client as Prisma.TransactionClient);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function claimOne(client: Db, now: Date, leaseUntil: Date) {
  return withTransaction(client, async (tx) => {
    const candidate = await tx.h2BWebhookOutbox.findFirst({
      where: {
        OR: [
          { status: H2BOutboxStatus.PENDING, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { status: H2BOutboxStatus.FAILED, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { status: H2BOutboxStatus.CLAIMED, leaseUntil: { lt: now } }
        ]
      },
      orderBy: { createdAt: "asc" }
    });
    if (!candidate) return null;
    const updated = await tx.h2BWebhookOutbox.updateMany({
      where: { id: candidate.id, status: candidate.status, ...(candidate.status === H2BOutboxStatus.CLAIMED ? { leaseUntil: { lt: now } } : {}) },
      data: { status: H2BOutboxStatus.CLAIMED, claimedAt: now, leaseUntil, attemptCount: { increment: 1 } }
    });
    return updated.count === 1 ? tx.h2BWebhookOutbox.findUnique({ where: { id: candidate.id } }) : null;
  });
}

async function markFailure(id: string, attemptCount: number, failureClass: string, client: Db) {
  const terminal = attemptCount >= 5;
  const outbox = await client.h2BWebhookOutbox.findUnique({ where: { id }, select: { admissionId: true } });
  await client.h2BWebhookOutbox.update({
    where: { id },
    data: {
      status: terminal ? H2BOutboxStatus.DEAD_LETTER : H2BOutboxStatus.FAILED,
      failedAt: new Date(),
      failureClass,
      nextAttemptAt: terminal ? null : new Date(Date.now() + Math.min(60 * 60_000, 2 ** Math.max(0, attemptCount - 1) * 1_000)),
      leaseUntil: null
    }
  });
  if (outbox) {
    await client.h2BWebhookAdmission.update({
      where: { id: outbox.admissionId },
      data: { status: H2BAdmissionStatus.FAILED, failureClass }
    });
  }
}

async function processOne(id: string, client: Db) {
  const outbox = await client.h2BWebhookOutbox.findUnique({ where: { id }, include: { admission: true } });
  if (!outbox) return "MISSING" as const;
  const envelope = asRecord(outbox.envelope);
  const externalOrderId = typeof envelope.externalOrderId === "string" ? envelope.externalOrderId : "";
  if (!externalOrderId) {
    await markFailure(id, outbox.attemptCount, "H2B_EXTERNAL_ORDER_ID_REQUIRED", client);
    return "FAILED" as const;
  }
  await withTransaction(client, async (tx) => {
    const current = await tx.h2BExternalOrderAggregate.findUnique({
      where: {
        merchantId_connectionId_externalOrderId: {
          merchantId: outbox.merchantId,
          connectionId: outbox.connectionId,
          externalOrderId
        }
      }
    });
    const sequence = BigInt(outbox.admission.receivedAt.getTime());
    const references = current && Array.isArray(asRecord(current.safeState).admissionIds)
      ? asRecord(current.safeState).admissionIds as unknown[]
      : [];
    const nextReferences = [...new Set([...references.filter((value): value is string => typeof value === "string"), outbox.admissionId])];
    const nextState = { ...envelope, admissionIds: nextReferences } as Prisma.InputJsonValue;
    if (!current) {
      await tx.h2BExternalOrderAggregate.create({
        data: {
          merchantId: outbox.merchantId,
          connectionId: outbox.connectionId,
          platform: outbox.platform,
          externalOrderId,
          externalOrderName: typeof envelope.externalOrderName === "string" ? envelope.externalOrderName : null,
          safeState: nextState,
          latestSequence: sequence,
          latestEventAt: outbox.admission.receivedAt
        }
      });
    } else if (sequence >= current.latestSequence) {
      await tx.h2BExternalOrderAggregate.update({
        where: { id: current.id },
        data: { safeState: nextState, latestSequence: sequence, latestEventAt: outbox.admission.receivedAt }
      });
    } else {
      await tx.h2BExternalOrderAggregate.update({
        where: { id: current.id },
        data: { safeState: { ...asRecord(current.safeState), admissionIds: nextReferences } as Prisma.InputJsonValue }
      });
    }
    await tx.h2BWebhookOutbox.update({ where: { id }, data: { status: H2BOutboxStatus.PROCESSED, processedAt: new Date(), leaseUntil: null } });
    await tx.h2BWebhookAdmission.update({ where: { id: outbox.admissionId }, data: { status: H2BAdmissionStatus.PROCESSED, processedAt: new Date() } });
  });
  return "PROCESSED" as const;
}

export async function runH2BOutboxOnce(input: { maxBatch?: number; now?: Date } = {}, client: Db = prisma) {
  const maxBatch = Math.max(1, Math.min(input.maxBatch ?? 25, 100));
  const now = input.now ?? new Date();
  let processed = 0;
  let failed = 0;
  for (let index = 0; index < maxBatch; index += 1) {
    const claimed = await claimOne(client, now, new Date(now.getTime() + 5 * 60_000));
    if (!claimed) break;
    try {
      const result = await processOne(claimed.id, client);
      if (result === "PROCESSED") processed += 1;
      if (result === "FAILED") failed += 1;
    } catch {
      failed += 1;
      await markFailure(claimed.id, claimed.attemptCount, "H2B_WORKER_PROCESSING_FAILED", client);
    }
  }
  return {
    processedCount: processed,
    failedCount: failed,
    externalCallsMade: false,
    providerWrites: false,
    inventoryMutations: false,
    canonicalOrderMutations: false
  };
}
