import { Prisma, type LivePilotCapability as LivePilotCapabilityRecord } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { assertLivePilotCapability, assertPilotMerchantCanEnableCapability, livePilotBlockers } from "./live-pilot.rules.js";
import {
  defaultCapabilityRows,
  sanitizeLivePilotMeta,
  serializeLivePilotApproval,
  serializeLivePilotAuditLog,
  serializeLivePilotCapability,
  serializeLivePilotMerchant,
  serializeLivePilotReadiness
} from "./live-pilot.serializer.js";
import type {
  LivePilotCapability,
  LivePilotReadinessSnapshot,
  LivePilotStatus
} from "./live-pilot.types.js";
import type {
  LivePilotAuditLogQueryInput,
  LivePilotCapabilityActionInput,
  LivePilotMerchantActionInput
} from "./live-pilot.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(sanitizeLivePilotMeta(value ?? {}))) as Prisma.InputJsonValue;
}

function actor(input?: { actorId?: string | null | undefined }, fallback?: string) {
  return input?.actorId || fallback || "shipmastr_internal";
}

async function audit(
  merchantId: string | null,
  action: string,
  input: {
    actorId?: string | null | undefined;
    targetType?: string | null;
    targetId?: string | null;
    safeMeta?: unknown;
  },
  client: Db
) {
  return client.livePilotAuditLog.create({
    data: {
      merchantId,
      action,
      actorId: input.actorId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      safeMeta: toJson(input.safeMeta ?? {})
    }
  });
}

async function findMerchant(merchantId: string, client: Db) {
  return client.livePilotMerchant.findUnique({ where: { merchantId } });
}

async function requireMerchant(merchantId: string, client: Db) {
  const merchant = await findMerchant(merchantId, client);
  if (!merchant) throw new HttpError(404, "LIVE_PILOT_MERCHANT_NOT_FOUND");
  return merchant;
}

async function findCapability(merchantId: string, capability: LivePilotCapability, client: Db) {
  return client.livePilotCapability.findUnique({
    where: { merchantId_capability: { merchantId, capability } }
  });
}

function serializeCapabilities(records: LivePilotCapabilityRecord[]) {
  return defaultCapabilityRows(records.map(serializeLivePilotCapability));
}

export async function listLivePilotMerchants(merchantId: string, client: Db = prisma) {
  const merchant = await findMerchant(merchantId, client);
  return {
    merchants: merchant ? [serializeLivePilotMerchant(merchant)] : []
  };
}

export async function getLivePilotMerchant(merchantId: string, client: Db = prisma) {
  const merchant = await findMerchant(merchantId, client);
  const capabilities = await client.livePilotCapability.findMany({
    where: { merchantId },
    orderBy: { capability: "asc" }
  });
  const approvals = await client.livePilotApproval.findMany({
    where: { merchantId },
    orderBy: { createdAt: "desc" },
    take: 25
  });
  const readiness = await getLivePilotReadinessSnapshot(merchantId, client);
  return {
    merchant: merchant ? serializeLivePilotMerchant(merchant) : {
      merchant_id: merchantId,
      status: "DISABLED" as LivePilotStatus,
      notes: null,
      enabled_at: null,
      disabled_at: null,
      created_at: null,
      updated_at: null
    },
    capabilities: serializeCapabilities(capabilities),
    approvals: approvals.map(serializeLivePilotApproval),
    readiness: serializeLivePilotReadiness(readiness)
  };
}

export async function enableLivePilotMerchant(
  merchantId: string,
  input: LivePilotMerchantActionInput,
  client: Db = prisma
) {
  const now = new Date();
  const record = await client.livePilotMerchant.upsert({
    where: { merchantId },
    create: {
      merchantId,
      status: "ENABLED",
      notes: input.notes ?? null,
      enabledBy: actor(input, merchantId),
      enabledAt: now,
      disabledBy: null,
      disabledAt: null
    },
    update: {
      status: "ENABLED",
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      enabledBy: actor(input, merchantId),
      enabledAt: now,
      disabledBy: null,
      disabledAt: null
    }
  });
  await audit(merchantId, "LIVE_PILOT_MERCHANT_ENABLED", {
    actorId: actor(input, merchantId),
    targetType: "LivePilotMerchant",
    targetId: record.id,
    safeMeta: { status: record.status, notes: input.notes ?? null }
  }, client);
  return getLivePilotMerchant(merchantId, client);
}

export async function disableLivePilotMerchant(
  merchantId: string,
  input: LivePilotMerchantActionInput,
  client: Db = prisma
) {
  const now = new Date();
  const existing = await findMerchant(merchantId, client);
  const record = await client.livePilotMerchant.upsert({
    where: { merchantId },
    create: {
      merchantId,
      status: "DISABLED",
      notes: input.notes ?? null,
      disabledBy: actor(input, merchantId),
      disabledAt: now
    },
    update: {
      status: "DISABLED",
      ...(input.notes !== undefined ? { notes: input.notes } : existing?.notes ? { notes: existing.notes } : {}),
      disabledBy: actor(input, merchantId),
      disabledAt: now
    }
  });
  await client.livePilotCapability.updateMany({
    where: { merchantId, status: "ENABLED" },
    data: { status: "DISABLED", disabledAt: now }
  });
  await audit(merchantId, "LIVE_PILOT_MERCHANT_DISABLED", {
    actorId: actor(input, merchantId),
    targetType: "LivePilotMerchant",
    targetId: record.id,
    safeMeta: { status: record.status, rollback: true }
  }, client);
  return getLivePilotMerchant(merchantId, client);
}

export async function listLivePilotCapabilities(merchantId: string, client: Db = prisma) {
  const capabilities = await client.livePilotCapability.findMany({
    where: { merchantId },
    orderBy: { capability: "asc" }
  });
  return {
    merchant_id: merchantId,
    capabilities: serializeCapabilities(capabilities)
  };
}

export async function approveLivePilotCapability(
  merchantId: string,
  capabilityInput: string,
  input: LivePilotCapabilityActionInput,
  client: Db = prisma
) {
  const capability = assertLivePilotCapability(capabilityInput);
  const merchant = await requireMerchant(merchantId, client);
  if (merchant.status !== "ENABLED") throw new HttpError(409, "LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
  const now = new Date();
  const approval = await client.livePilotApproval.create({
    data: {
      merchantId,
      approvalType: capability,
      status: "APPROVED",
      approvedBy: actor(input, merchantId),
      approvedAt: now,
      reason: input.reason ?? input.notes ?? null
    }
  });
  const record = await client.livePilotCapability.upsert({
    where: { merchantId_capability: { merchantId, capability } },
    create: {
      merchantId,
      capability,
      status: "APPROVED",
      approvalId: approval.id,
      notes: input.notes ?? null
    },
    update: {
      status: "APPROVED",
      approvalId: approval.id,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      disabledAt: null
    }
  });
  await audit(merchantId, "LIVE_PILOT_CAPABILITY_APPROVED", {
    actorId: actor(input, merchantId),
    targetType: "LivePilotCapability",
    targetId: record.id,
    safeMeta: { capability, approval_id: approval.id }
  }, client);
  return {
    capability: serializeLivePilotCapability(record),
    approval: serializeLivePilotApproval(approval)
  };
}

export async function enableLivePilotCapability(
  merchantId: string,
  capabilityInput: string,
  input: LivePilotCapabilityActionInput,
  client: Db = prisma
) {
  const capability = assertLivePilotCapability(capabilityInput);
  const merchant = await requireMerchant(merchantId, client);
  const existing = await findCapability(merchantId, capability, client);
  assertPilotMerchantCanEnableCapability({
    merchantStatus: merchant.status,
    capabilityStatus: existing?.status ?? null,
    approvalId: existing?.approvalId ?? null
  });
  const record = await client.livePilotCapability.update({
    where: { merchantId_capability: { merchantId, capability } },
    data: {
      status: "ENABLED",
      ...(input.notes !== undefined ? { notes: input.notes } : existing?.notes ? { notes: existing.notes } : {}),
      enabledAt: new Date(),
      disabledAt: null
    }
  });
  await audit(merchantId, "LIVE_PILOT_CAPABILITY_ENABLED", {
    actorId: actor(input, merchantId),
    targetType: "LivePilotCapability",
    targetId: record.id,
    safeMeta: { capability, status: record.status }
  }, client);
  return { capability: serializeLivePilotCapability(record) };
}

export async function disableLivePilotCapability(
  merchantId: string,
  capabilityInput: string,
  input: LivePilotCapabilityActionInput,
  client: Db = prisma
) {
  const capability = assertLivePilotCapability(capabilityInput);
  const now = new Date();
  const record = await client.livePilotCapability.upsert({
    where: { merchantId_capability: { merchantId, capability } },
    create: {
      merchantId,
      capability,
      status: "DISABLED",
      notes: input.notes ?? null,
      disabledAt: now
    },
    update: {
      status: "DISABLED",
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      disabledAt: now
    }
  });
  await audit(merchantId, "LIVE_PILOT_CAPABILITY_DISABLED", {
    actorId: actor(input, merchantId),
    targetType: "LivePilotCapability",
    targetId: record.id,
    safeMeta: { capability, rollback: true }
  }, client);
  return { capability: serializeLivePilotCapability(record) };
}

export async function listLivePilotAuditLogs(
  merchantId: string,
  query: LivePilotAuditLogQueryInput,
  client: Db = prisma
) {
  const scopedMerchantId = query.merchantId && query.merchantId === merchantId ? query.merchantId : merchantId;
  const where: Prisma.LivePilotAuditLogWhereInput = {
    merchantId: scopedMerchantId,
    ...(query.action ? { action: query.action } : {})
  };
  const [logs, total] = await Promise.all([
    client.livePilotAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.livePilotAuditLog.count({ where })
  ]);
  return {
    audit_logs: logs.map(serializeLivePilotAuditLog),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getLivePilotReadinessSnapshot(
  merchantId: string,
  client: Db = prisma
): Promise<LivePilotReadinessSnapshot> {
  const [merchant, capabilities] = await Promise.all([
    findMerchant(merchantId, client),
    client.livePilotCapability.findMany({ where: { merchantId } })
  ]);
  const allowlisted = merchant?.status === "ENABLED";
  const enabledCapabilities = capabilities
    .filter((capability) => capability.status === "ENABLED")
    .map((capability) => capability.capability as LivePilotCapability);
  const approvedCapabilities = capabilities
    .filter((capability) => ["APPROVED", "ENABLED"].includes(capability.status))
    .map((capability) => capability.capability as LivePilotCapability);
  const pendingCapabilities = capabilities
    .filter((capability) => capability.status === "PENDING_APPROVAL")
    .map((capability) => capability.capability as LivePilotCapability);
  const disabledCapabilities = capabilities
    .filter((capability) => capability.status === "DISABLED")
    .map((capability) => capability.capability as LivePilotCapability);
  return {
    merchantId,
    allowlisted,
    merchantStatus: (merchant?.status ?? "DISABLED") as LivePilotStatus,
    enabledCapabilities,
    approvedCapabilities,
    pendingCapabilities,
    disabledCapabilities,
    rollbackReady: true,
    blockers: livePilotBlockers({ allowlisted, enabledCapabilities, approvedCapabilities })
  };
}
