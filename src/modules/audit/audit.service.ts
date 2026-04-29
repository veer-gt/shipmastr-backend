import { prisma } from "../../lib/prisma.js";

export async function audit(input: {
  merchantId?: string;
  actorId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: unknown;
}) {
  const data: Record<string, unknown> = {
    action: input.action,
    entityType: input.entityType
  };

  if (input.merchantId) data.merchantId = input.merchantId;
  if (input.actorId) data.actorId = input.actorId;
  if (input.entityId) data.entityId = input.entityId;
  if (input.metadata !== undefined) data.metadata = input.metadata;

  return prisma.auditLog.create({
    data: data as any
  });
}
