import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;
type AuditLogRecord = Awaited<ReturnType<typeof audit>>;

const sensitiveKeyPattern = /(api[_-]?key|authorization|bearer|credential|password|passwd|pwd|rawbody|rawpayload|secret|smtp|token|webhook)/i;
const sensitiveTextPatterns = [
  /\b(api[_\s-]?key|authorization|bearer|credential|password|passwd|pwd|secret|smtp[_\s-]?pass|token|webhook[_\s-]?secret)\b\s*[:=]\s*[^\s,;}]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
];

function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactAuditValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[redacted]" : redactAuditValue(entry)
      ])
    );
  }

  if (typeof value === "string") {
    const redacted = sensitiveTextPatterns.reduce((next, pattern) => next.replace(pattern, "[redacted]"), value);
    return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
  }

  return value;
}

function metadataObject(metadata: Prisma.JsonValue | null | undefined) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata as Record<string, unknown>;
}

function inferAuditStatus(action: string, metadata: Prisma.JsonValue | null | undefined) {
  const meta = metadataObject(metadata);
  const explicitStatus = typeof meta.status === "string" ? meta.status.toLowerCase() : "";
  if (["failure", "failed", "error", "rejected", "blocked"].includes(explicitStatus)) return "failure";
  if (["queued", "pending", "scheduled"].includes(explicitStatus)) return "queued";
  if (["success", "sent", "processed", "completed"].includes(explicitStatus)) return "success";

  const normalizedAction = action.toLowerCase();
  if (/(fail|error|reject|block|invalid|denied)/.test(normalizedAction)) return "failure";
  if (/(queue|queued|pending|scheduled)/.test(normalizedAction)) return "queued";
  return "success";
}

function toSellerAuditLog(log: AuditLogRecord) {
  return {
    _id: log.id,
    id: log.id,
    createdAt: log.createdAt,
    action: log.action,
    resourceType: log.entityType,
    resourceId: log.entityId,
    status: inferAuditStatus(log.action, log.metadata),
    metadata: redactAuditValue(log.metadata || {})
  };
}

export async function audit(input: {
  merchantId?: string;
  actorId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: unknown;
}, client: Db = prisma) {
  const data: Prisma.AuditLogUncheckedCreateInput = {
    action: input.action,
    entityType: input.entityType
  };

  if (input.merchantId) data.merchantId = input.merchantId;
  if (input.actorId) data.actorId = input.actorId;
  if (input.entityId) data.entityId = input.entityId;
  if (input.metadata !== undefined) {
    data.metadata = input.metadata as Prisma.InputJsonValue;
  }

  return client.auditLog.create({
    data
  });
}

export async function listSellerAuditLogs(
  merchantId: string,
  input: { limit?: number | undefined } = {},
  client: Db = prisma
) {
  const take = Math.min(Math.max(Math.trunc(input.limit || 50), 1), 100);
  const logs = await client.auditLog.findMany({
    where: { merchantId },
    orderBy: { createdAt: "desc" },
    take
  });

  const scopedLogs = logs.filter((log) => log.merchantId === merchantId);
  const events = scopedLogs.map(toSellerAuditLog);
  return {
    events,
    data: events,
    count: events.length
  };
}

export async function getSellerAuditSummary(merchantId: string, client: Db = prisma) {
  const [total, logs] = await Promise.all([
    client.auditLog.count({ where: { merchantId } }),
    client.auditLog.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 250
    })
  ]);

  const scopedLogs = logs.filter((log) => log.merchantId === merchantId);
  const statuses = scopedLogs.map((log) => inferAuditStatus(log.action, log.metadata));
  const actions = [...new Set(scopedLogs.map((log) => log.action))].slice(0, 25);
  const failed = statuses.filter((status) => status === "failure").length;
  const queued = statuses.filter((status) => status === "queued").length;

  return {
    total,
    critical: failed,
    warning: queued,
    info: Math.max(total - failed - queued, 0),
    failed,
    queued,
    actions
  };
}
