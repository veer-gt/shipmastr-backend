import type {
  GrowthOfferStatus,
  GrowthOfferType,
  GrowthPlacementSurface,
  RtoNdrRecoveryActionType,
  RtoNdrRecoveryIntentStatus,
  RtoNdrRecoveryPolicyStatus
} from "@prisma/client";
import { Prisma } from "@prisma/client";

import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  addGrowthOfferPlacement,
  createGrowthOffer,
  type GrowthNetworkDb
} from "./growth-network.service.js";
import {
  rtoNdrRecoveryDisplayValue,
  serializePublicRtoNdrRecoveryIntent,
  serializePublicRtoNdrRecoveryOffer,
  serializeRtoNdrRecoveryPolicy
} from "./rto-ndr-recovery.serializer.js";
import type { RtoNdrRecoverySurface } from "./rto-ndr-recovery.types.js";
import type {
  CreateRtoNdrRecoveryIntentInput,
  CreateRtoNdrRecoveryPolicyInput,
  ListRtoNdrRecoveryPoliciesQueryInput,
  ResolveRtoNdrRecoveryInput,
  UpdateRtoNdrRecoveryPolicyStatusInput
} from "./rto-ndr-recovery.validation.js";

type RtoNdrRecoveryPolicyRecord = {
  id: string;
  merchantId: string;
  title: string;
  description?: string | null;
  status: RtoNdrRecoveryPolicyStatus;
  actionType: RtoNdrRecoveryActionType;
  incentiveAmountPaise?: number | null;
  maxIncentiveAmountPaise?: number | null;
  minOrderAmountPaise?: number | null;
  maxOrderAmountPaise?: number | null;
  allowedFailureReasons?: unknown;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  metadata?: unknown;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
};

type RtoNdrRecoveryIntentRecord = {
  id: string;
  policyId?: string | null;
  merchantId?: string | null;
  sellerId?: string | null;
  orderId?: string | null;
  shipmentId?: string | null;
  growthOfferId?: string | null;
  status: RtoNdrRecoveryIntentStatus;
  actionType: RtoNdrRecoveryActionType;
  recoverySnapshot: unknown;
  idempotencyKey?: string | null;
  expiresAt?: Date | string | null;
  recoveredAt?: Date | string | null;
  metadata?: unknown;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
};

type GrowthOfferRecord = {
  id: string;
  merchantId?: string | null;
  type: GrowthOfferType;
  status: GrowthOfferStatus;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  isSponsored: boolean;
  sponsorName?: string | null;
  ctaLabel: string;
  ctaUrl?: string | null;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
  placements?: Array<{
    id: string;
    offerId: string;
    surface: GrowthPlacementSurface;
    priority: number;
    createdAt: Date | string;
  }>;
};

type OrderContextRecord = {
  id: string;
  merchantId: string;
  externalOrderId?: string | null;
  orderValue?: number | null;
  codAmount?: number | null;
  paymentMode?: string | null;
  status?: string | null;
  rtoRiskScore?: number | null;
  rtoRiskLevel?: string | null;
};

type ShipmentContextRecord = {
  id: string;
  sellerId?: string | null;
  orderId?: string | null;
  externalOrderId?: string | null;
  paymentMode?: string | null;
  codAmountPaise?: number | null;
  declaredValuePaise?: number | null;
  status?: string | null;
};

type NdrCaseContextRecord = {
  id: string;
  merchantId: string;
  shipmentId: string;
  orderId?: string | null;
  status?: string | null;
  reasonCode?: string | null;
  reasonLabel?: string | null;
  buyerIssueType?: string | null;
};

type RtoCaseContextRecord = {
  id: string;
  merchantId: string;
  shipmentId: string;
  orderId?: string | null;
  status?: string | null;
  rtoReasonCode?: string | null;
  rtoReasonLabel?: string | null;
  estimatedLossPaise?: number | null;
};

export type RtoNdrRecoveryDb = GrowthNetworkDb & {
  rtoNdrRecoveryPolicy: {
    create(input: { data: Record<string, unknown> }): Promise<RtoNdrRecoveryPolicyRecord>;
    findMany(input?: Record<string, unknown>): Promise<RtoNdrRecoveryPolicyRecord[]>;
    findUnique(input: { where: Record<string, unknown> }): Promise<RtoNdrRecoveryPolicyRecord | null>;
    update(input: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<RtoNdrRecoveryPolicyRecord>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
  rtoNdrRecoveryIntent: {
    create(input: { data: Record<string, unknown> }): Promise<RtoNdrRecoveryIntentRecord>;
    findUnique(input: { where: Record<string, unknown> }): Promise<RtoNdrRecoveryIntentRecord | null>;
    findFirst(input: Record<string, unknown>): Promise<RtoNdrRecoveryIntentRecord | null>;
  };
  order?: {
    findFirst(input: Record<string, unknown>): Promise<OrderContextRecord | null>;
  };
  shipment?: {
    findFirst(input: Record<string, unknown>): Promise<ShipmentContextRecord | null>;
  };
  ndrCase?: {
    findFirst(input: Record<string, unknown>): Promise<NdrCaseContextRecord | null>;
  };
  rtoCase?: {
    findFirst(input: Record<string, unknown>): Promise<RtoCaseContextRecord | null>;
  };
};

const defaultClient = prisma as unknown as RtoNdrRecoveryDb;
const unsafeMetadataKeyPattern = /buyer|email|phone|mobile|address|name|provider|courier|secret|token|authorization|cookie|card|upi|payment[_-]?(secret|token|credential|method|instrument)|whatsapp|sms/i;
const unsafeMetadataStringPattern = /@|\b\d{10,}\b|upi:|card_|tok_|secret|bearer\s+|shiprocket|shipmozo|bigship|delhivery|bluedart|blue dart|xpressbees|shadowfax|whatsapp|sms|email/i;
const terminalStatusSet = new Set([
  "DELIVERED",
  "CANCELLED",
  "CANCELED",
  "RTO_DELIVERED",
  "LOST",
  "DAMAGED",
  "delivered",
  "cancelled",
  "canceled",
  "rto_delivered",
  "lost",
  "damaged"
]);
const actionPriority = new Map<RtoNdrRecoveryActionType, number>([
  ["CONFIRM_ADDRESS", 1],
  ["SELECT_RETRY_WINDOW", 2],
  ["SWITCH_TO_PREPAID", 3],
  ["ACCEPT_DELIVERY_INCENTIVE", 4],
  ["UPDATE_ADDRESS", 5],
  ["CONTACT_SUPPORT", 6]
]);

function cleanString(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalized(value: string | null | undefined) {
  return (value ?? "").trim().toUpperCase();
}

function numberValue(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && value && "toNumber" in value && typeof value.toNumber === "function") {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeMetadata(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeMetadataKeyPattern.test(key)) continue;
      safe[key] = sanitizeMetadata(child);
    }
    return safe;
  }
  if (typeof value === "string" && unsafeMetadataStringPattern.test(value)) return "[redacted]";
  return value;
}

function toStoredJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return JSON.parse(JSON.stringify(sanitizeMetadata(value))) as Prisma.InputJsonValue;
}

function toRequiredJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "P2002"
  );
}

function assertPolicyConfig(input: {
  incentiveAmountPaise?: number | null | undefined;
  maxIncentiveAmountPaise?: number | null | undefined;
  minOrderAmountPaise?: number | null | undefined;
  maxOrderAmountPaise?: number | null | undefined;
  startsAt?: Date | string | null | undefined;
  endsAt?: Date | string | null | undefined;
}) {
  const amountFields = [
    input.incentiveAmountPaise,
    input.maxIncentiveAmountPaise,
    input.minOrderAmountPaise,
    input.maxOrderAmountPaise
  ];
  if (amountFields.some((value) => value != null && value < 0)) {
    throw new HttpError(400, "RTO_NDR_RECOVERY_NEGATIVE_AMOUNT");
  }

  if (input.maxIncentiveAmountPaise != null && input.incentiveAmountPaise != null && input.maxIncentiveAmountPaise < input.incentiveAmountPaise) {
    throw new HttpError(400, "RTO_NDR_RECOVERY_INVALID_INCENTIVE_RANGE");
  }

  if (input.minOrderAmountPaise != null && input.maxOrderAmountPaise != null && input.maxOrderAmountPaise < input.minOrderAmountPaise) {
    throw new HttpError(400, "RTO_NDR_RECOVERY_INVALID_ORDER_AMOUNT_RANGE");
  }

  if (input.startsAt && input.endsAt && new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()) {
    throw new HttpError(400, "RTO_NDR_RECOVERY_INVALID_DATE_RANGE");
  }
}

async function ensurePolicy(policyId: string, client: RtoNdrRecoveryDb) {
  const policy = await client.rtoNdrRecoveryPolicy.findUnique({ where: { id: policyId } });
  if (!policy) throw new HttpError(404, "RTO_NDR_RECOVERY_POLICY_NOT_FOUND");
  return policy;
}

function policyStatusForGrowthOffer(status: RtoNdrRecoveryPolicyStatus) {
  if (status === "ACTIVE") return "ACTIVE";
  if (status === "ARCHIVED") return "ARCHIVED";
  return "PAUSED";
}

function relatedGrowthOfferWhere(policy: { id: string; merchantId: string }) {
  return {
    merchantId: policy.merchantId,
    type: "RTO_NDR_RECOVERY",
    metadata: { path: ["rtoNdrRecoveryPolicyId"], equals: policy.id }
  };
}

async function relatedGrowthOffers(policy: { id: string; merchantId: string }, client: RtoNdrRecoveryDb) {
  return client.growthOffer.findMany({
    where: relatedGrowthOfferWhere(policy),
    include: {
      placements: {
        orderBy: [{ priority: "asc" }, { createdAt: "desc" }]
      }
    },
    take: 10
  }) as Promise<GrowthOfferRecord[]>;
}

async function syncRelatedGrowthOfferStatus(policy: RtoNdrRecoveryPolicyRecord, client: RtoNdrRecoveryDb) {
  const offers = await relatedGrowthOffers(policy, client);
  const status = policyStatusForGrowthOffer(policy.status);
  await Promise.all(
    offers
      .filter((offer) => offer.status !== status)
      .map((offer) => client.growthOffer.update({ where: { id: offer.id }, data: { status } }))
  );
}

function hasSurfacePlacement(offer: GrowthOfferRecord, surface: GrowthPlacementSurface) {
  return (offer.placements ?? []).some((placement) => placement.surface === surface);
}

async function ensureRecoveryGrowthOffer(
  policy: RtoNdrRecoveryPolicyRecord,
  surface: RtoNdrRecoverySurface,
  client: RtoNdrRecoveryDb
) {
  const [existing] = await relatedGrowthOffers(policy, client);
  const status = policyStatusForGrowthOffer(policy.status);

  if (existing) {
    const current = existing.status === status
      ? existing
      : await client.growthOffer.update({ where: { id: existing.id }, data: { status } }) as GrowthOfferRecord;
    if (!hasSurfacePlacement(existing, surface)) {
      await addGrowthOfferPlacement(existing.id, {
        surface,
        priority: 45,
        rulesJson: { rtoNdrRecoveryPolicyId: policy.id }
      }, client);
    }
    return current.id;
  }

  const offer = await createGrowthOffer({
    merchantId: policy.merchantId,
    title: policy.title,
    subtitle: "Delivery recovery offer",
    description: policy.description,
    type: "RTO_NDR_RECOVERY",
    status,
    isSponsored: false,
    sponsorName: null,
    ctaLabel: recoveryCtaLabel(policy.actionType),
    ctaUrl: null,
    metadata: {
      phase: "45C",
      rtoNdrRecoveryPolicyId: policy.id
    },
    startsAt: policy.startsAt ? new Date(policy.startsAt) : null,
    endsAt: policy.endsAt ? new Date(policy.endsAt) : null
  }, client);

  await addGrowthOfferPlacement(offer.offerId, {
    surface,
    priority: 45,
    rulesJson: { rtoNdrRecoveryPolicyId: policy.id }
  }, client);

  return offer.offerId;
}

function recoveryCtaLabel(actionType: RtoNdrRecoveryActionType) {
  if (actionType === "CONFIRM_ADDRESS") return "Confirm address";
  if (actionType === "UPDATE_ADDRESS") return "Update address";
  if (actionType === "SELECT_RETRY_WINDOW") return "Retry delivery";
  if (actionType === "SWITCH_TO_PREPAID") return "Switch to prepaid";
  if (actionType === "ACCEPT_DELIVERY_INCENTIVE") return "Accept offer";
  return "Contact support";
}

export async function createRtoNdrRecoveryPolicy(
  input: CreateRtoNdrRecoveryPolicyInput,
  client: RtoNdrRecoveryDb = defaultClient
) {
  assertPolicyConfig(input);

  const policy = await client.rtoNdrRecoveryPolicy.create({
    data: {
      merchantId: input.merchantId,
      title: input.title,
      description: cleanString(input.description),
      status: input.status,
      actionType: input.actionType,
      incentiveAmountPaise: input.incentiveAmountPaise ?? null,
      maxIncentiveAmountPaise: input.maxIncentiveAmountPaise ?? null,
      minOrderAmountPaise: input.minOrderAmountPaise ?? null,
      maxOrderAmountPaise: input.maxOrderAmountPaise ?? null,
      allowedFailureReasons: toStoredJson(input.allowedFailureReasons ?? null),
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      metadata: toStoredJson(input.metadata)
    }
  });

  return serializeRtoNdrRecoveryPolicy(policy);
}

export async function listRtoNdrRecoveryPolicies(
  query: ListRtoNdrRecoveryPoliciesQueryInput,
  client: RtoNdrRecoveryDb = defaultClient
) {
  const where = {
    ...(cleanString(query.merchantId) ? { merchantId: cleanString(query.merchantId) } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.actionType ? { actionType: query.actionType } : {})
  };

  const [policies, total] = await Promise.all([
    client.rtoNdrRecoveryPolicy.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage
    }),
    client.rtoNdrRecoveryPolicy.count({ where })
  ]);

  return {
    policies: policies.map(serializeRtoNdrRecoveryPolicy),
    pagination: {
      page: query.page,
      perPage: query.perPage,
      total,
      hasMore: query.page * query.perPage < total
    }
  };
}

export async function updateRtoNdrRecoveryPolicyStatus(
  policyId: string,
  input: UpdateRtoNdrRecoveryPolicyStatusInput,
  client: RtoNdrRecoveryDb = defaultClient
) {
  await ensurePolicy(policyId, client);
  const policy = await client.rtoNdrRecoveryPolicy.update({
    where: { id: policyId },
    data: { status: input.status }
  });
  await syncRelatedGrowthOfferStatus(policy, client);
  return serializeRtoNdrRecoveryPolicy(policy);
}

async function findOrderContext(input: ResolveRtoNdrRecoveryInput | CreateRtoNdrRecoveryIntentInput, client: RtoNdrRecoveryDb) {
  const orderId = cleanString(input.orderId);
  if (!orderId || !client.order) return null;

  return client.order.findFirst({
    where: {
      merchantId: input.merchantId,
      OR: [{ id: orderId }, { externalOrderId: orderId }]
    },
    select: {
      id: true,
      merchantId: true,
      externalOrderId: true,
      orderValue: true,
      codAmount: true,
      paymentMode: true,
      status: true,
      rtoRiskScore: true,
      rtoRiskLevel: true
    }
  });
}

async function findShipmentContext(input: ResolveRtoNdrRecoveryInput | CreateRtoNdrRecoveryIntentInput, client: RtoNdrRecoveryDb) {
  const shipmentId = cleanString(input.shipmentId);
  if (!shipmentId || !client.shipment) return null;

  return client.shipment.findFirst({
    where: {
      OR: [
        { id: shipmentId },
        { orderId: shipmentId },
        { externalOrderId: shipmentId }
      ]
    },
    select: {
      id: true,
      sellerId: true,
      orderId: true,
      externalOrderId: true,
      paymentMode: true,
      codAmountPaise: true,
      declaredValuePaise: true,
      status: true
    }
  });
}

async function findNdrCaseContext(input: ResolveRtoNdrRecoveryInput | CreateRtoNdrRecoveryIntentInput, shipmentId: string | null, client: RtoNdrRecoveryDb) {
  if (!client.ndrCase) return null;
  const directShipmentId = cleanString(input.shipmentId) ?? shipmentId;
  const orderId = cleanString(input.orderId);
  if (!directShipmentId && !orderId) return null;

  return client.ndrCase.findFirst({
    where: {
      merchantId: input.merchantId,
      ...(directShipmentId ? { shipmentId: directShipmentId } : {}),
      ...(orderId ? { orderId } : {}),
      status: { notIn: ["resolved", "cancelled"] }
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      merchantId: true,
      shipmentId: true,
      orderId: true,
      status: true,
      reasonCode: true,
      reasonLabel: true,
      buyerIssueType: true
    }
  });
}

async function findRtoCaseContext(input: ResolveRtoNdrRecoveryInput | CreateRtoNdrRecoveryIntentInput, shipmentId: string | null, client: RtoNdrRecoveryDb) {
  if (!client.rtoCase) return null;
  const directShipmentId = cleanString(input.shipmentId) ?? shipmentId;
  const orderId = cleanString(input.orderId);
  if (!directShipmentId && !orderId) return null;

  return client.rtoCase.findFirst({
    where: {
      merchantId: input.merchantId,
      ...(directShipmentId ? { shipmentId: directShipmentId } : {}),
      ...(orderId ? { orderId } : {}),
      status: { notIn: ["closed"] }
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      merchantId: true,
      shipmentId: true,
      orderId: true,
      status: true,
      rtoReasonCode: true,
      rtoReasonLabel: true,
      estimatedLossPaise: true
    }
  });
}

async function buildEligibilityContext(input: ResolveRtoNdrRecoveryInput, client: RtoNdrRecoveryDb) {
  const [order, shipment] = await Promise.all([
    findOrderContext(input, client),
    findShipmentContext(input, client)
  ]);
  const [ndrCase, rtoCase] = await Promise.all([
    findNdrCaseContext(input, shipment?.id ?? null, client),
    findRtoCaseContext(input, shipment?.id ?? null, client)
  ]);

  const orderAmountPaise = input.orderAmountPaise
    ?? shipment?.declaredValuePaise
    ?? shipment?.codAmountPaise
    ?? order?.orderValue
    ?? order?.codAmount
    ?? rtoCase?.estimatedLossPaise
    ?? null;
  const failureReason = cleanString(input.failureReason)
    ?? cleanString(ndrCase?.reasonCode)
    ?? cleanString(ndrCase?.reasonLabel)
    ?? cleanString(ndrCase?.buyerIssueType)
    ?? cleanString(rtoCase?.rtoReasonCode)
    ?? cleanString(rtoCase?.rtoReasonLabel);

  return {
    merchantId: input.merchantId,
    sellerId: cleanString(input.sellerId) ?? cleanString(shipment?.sellerId),
    orderId: cleanString(input.orderId) ?? order?.id ?? shipment?.orderId ?? ndrCase?.orderId ?? rtoCase?.orderId ?? null,
    shipmentId: cleanString(input.shipmentId) ?? shipment?.id ?? ndrCase?.shipmentId ?? rtoCase?.shipmentId ?? null,
    orderAmountPaise,
    orderStatus: cleanString(input.orderStatus) ?? cleanString(order?.status),
    shipmentStatus: cleanString(input.shipmentStatus) ?? cleanString(shipment?.status),
    ndrStatus: cleanString(input.ndrStatus) ?? cleanString(ndrCase?.status),
    rtoStatus: cleanString(input.rtoStatus) ?? cleanString(rtoCase?.status),
    failureReason,
    orderRtoRiskLevel: cleanString(order?.rtoRiskLevel),
    orderRtoRiskScore: order?.rtoRiskScore ?? null
  };
}

function hasTerminalStatus(context: Awaited<ReturnType<typeof buildEligibilityContext>>) {
  return terminalStatusSet.has(context.orderStatus ?? "")
    || terminalStatusSet.has(context.shipmentStatus ?? "")
    || terminalStatusSet.has(context.ndrStatus ?? "")
    || terminalStatusSet.has(context.rtoStatus ?? "");
}

function hasRecoverySignal(context: Awaited<ReturnType<typeof buildEligibilityContext>>) {
  const signals = [
    normalized(context.orderStatus),
    normalized(context.shipmentStatus),
    normalized(context.ndrStatus),
    normalized(context.rtoStatus),
    normalized(context.failureReason),
    normalized(context.orderRtoRiskLevel)
  ].filter(Boolean);
  if (signals.some((signal) => (
    signal.includes("NDR")
    || signal.includes("RTO")
    || signal.includes("FAILED")
    || signal.includes("UNDELIVERED")
    || signal.includes("EXCEPTION")
    || signal.includes("ATTEMPT")
    || signal.includes("NEEDS_ATTENTION")
    || signal.includes("ACTION_REQUIRED")
    || signal.includes("RISK")
  ))) return true;
  return (context.orderRtoRiskScore ?? 0) >= 70;
}

function policyIsActive(policy: RtoNdrRecoveryPolicyRecord, now: Date) {
  if (policy.status !== "ACTIVE") return false;
  if (policy.startsAt && new Date(policy.startsAt).getTime() > now.getTime()) return false;
  if (policy.endsAt && new Date(policy.endsAt).getTime() < now.getTime()) return false;
  return true;
}

function policyMatchesAmount(policy: RtoNdrRecoveryPolicyRecord, orderAmountPaise: number | null) {
  if (policy.minOrderAmountPaise != null && orderAmountPaise == null) return false;
  if (policy.maxOrderAmountPaise != null && orderAmountPaise == null) return false;
  if (policy.minOrderAmountPaise != null && (orderAmountPaise ?? 0) < policy.minOrderAmountPaise) return false;
  if (policy.maxOrderAmountPaise != null && (orderAmountPaise ?? 0) > policy.maxOrderAmountPaise) return false;
  return true;
}

function allowedFailureReasons(policy: RtoNdrRecoveryPolicyRecord) {
  if (!Array.isArray(policy.allowedFailureReasons)) return [];
  return policy.allowedFailureReasons
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalized(item))
    .filter(Boolean);
}

function policyMatchesFailureReason(policy: RtoNdrRecoveryPolicyRecord, failureReason: string | null) {
  const allowed = allowedFailureReasons(policy);
  if (allowed.length === 0) return true;
  const reason = normalized(failureReason);
  if (!reason) return false;
  return allowed.some((item) => item === reason || reason.includes(item) || item.includes(reason));
}

function incentiveValue(policy: RtoNdrRecoveryPolicyRecord) {
  return Math.max(
    policy.incentiveAmountPaise ?? 0,
    policy.maxIncentiveAmountPaise ?? 0
  );
}

function bestPolicy(policies: RtoNdrRecoveryPolicyRecord[]) {
  return [...policies].sort((left, right) => {
    const priorityDelta = (actionPriority.get(left.actionType) ?? 99) - (actionPriority.get(right.actionType) ?? 99);
    if (priorityDelta !== 0) return priorityDelta;
    const incentiveDelta = incentiveValue(right) - incentiveValue(left);
    if (incentiveDelta !== 0) return incentiveDelta;
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  })[0] ?? null;
}

async function hasSimulatedRecoveryIntent(context: Awaited<ReturnType<typeof buildEligibilityContext>>, client: RtoNdrRecoveryDb) {
  const orderId = cleanString(context.orderId);
  const shipmentId = cleanString(context.shipmentId);
  if (!orderId && !shipmentId) return false;

  const existing = await client.rtoNdrRecoveryIntent.findFirst({
    where: {
      merchantId: context.merchantId,
      status: "RECOVERY_SIMULATED",
      OR: [
        ...(orderId ? [{ orderId }] : []),
        ...(shipmentId ? [{ shipmentId }] : [])
      ]
    },
    orderBy: { createdAt: "desc" }
  });
  return Boolean(existing);
}

export async function resolveRtoNdrRecoveryOffer(
  input: ResolveRtoNdrRecoveryInput,
  client: RtoNdrRecoveryDb = defaultClient,
  now = new Date()
) {
  const context = await buildEligibilityContext(input, client);
  if (hasTerminalStatus(context)) return { eligible: false, reason: "ORDER_OR_SHIPMENT_TERMINAL", offer: null };
  if (!hasRecoverySignal(context)) return { eligible: false, reason: "RTO_NDR_RECOVERY_CONTEXT_REQUIRED", offer: null };
  if (await hasSimulatedRecoveryIntent(context, client)) return { eligible: false, reason: "RTO_NDR_ALREADY_RECOVERED_SIMULATED", offer: null };

  const policies = await client.rtoNdrRecoveryPolicy.findMany({
    where: {
      merchantId: input.merchantId,
      status: "ACTIVE",
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }
      ]
    },
    orderBy: { createdAt: "desc" }
  });

  const eligiblePolicies = policies
    .filter((policy) => policyIsActive(policy, now))
    .filter((policy) => policyMatchesAmount(policy, context.orderAmountPaise))
    .filter((policy) => policyMatchesFailureReason(policy, context.failureReason));
  const policy = bestPolicy(eligiblePolicies);
  if (!policy) return { eligible: false, reason: "NO_ELIGIBLE_RTO_NDR_RECOVERY_POLICY", offer: null };

  const offerId = await ensureRecoveryGrowthOffer(policy, input.surface, client);
  return {
    eligible: true,
    reason: null,
    offer: serializePublicRtoNdrRecoveryOffer({
      policy,
      offerId,
      surface: input.surface,
      expiresAt: policy.endsAt ?? null
    })
  };
}

function recoverySnapshot(policy: RtoNdrRecoveryPolicyRecord) {
  return {
    policyId: policy.id,
    title: policy.title,
    actionType: policy.actionType,
    displayValue: rtoNdrRecoveryDisplayValue(policy),
    incentiveAmountPaise: policy.incentiveAmountPaise ?? null,
    maxIncentiveAmountPaise: policy.maxIncentiveAmountPaise ?? null,
    communicationSent: false,
    courierMutation: false,
    paymentCollection: false
  };
}

export async function createRtoNdrRecoveryIntent(
  input: CreateRtoNdrRecoveryIntentInput,
  client: RtoNdrRecoveryDb = defaultClient
) {
  if (!cleanString(input.orderId) && !cleanString(input.shipmentId)) {
    throw new HttpError(400, "RTO_NDR_RECOVERY_INTENT_CONTEXT_REQUIRED");
  }

  const idempotencyKey = cleanString(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = await client.rtoNdrRecoveryIntent.findUnique({ where: { idempotencyKey } });
    if (existing) return serializePublicRtoNdrRecoveryIntent(existing, true);
  }

  const policy = await ensurePolicy(input.policyId, client);
  const order = await findOrderContext(input, client);
  const shipment = await findShipmentContext(input, client);
  const actionType = input.actionType ?? policy.actionType;

  try {
    const intent = await client.rtoNdrRecoveryIntent.create({
      data: {
        policyId: policy.id,
        merchantId: input.merchantId,
        sellerId: cleanString(input.sellerId) ?? cleanString(shipment?.sellerId),
        orderId: cleanString(input.orderId) ?? order?.id ?? shipment?.orderId ?? null,
        shipmentId: cleanString(input.shipmentId) ?? shipment?.id ?? null,
        growthOfferId: cleanString(input.growthOfferId),
        status: "INTENT_CREATED",
        actionType,
        recoverySnapshot: toRequiredJson(recoverySnapshot(policy)),
        idempotencyKey,
        expiresAt: input.expiresAt ?? policy.endsAt ?? null,
        recoveredAt: null,
        metadata: toStoredJson({
          ...(input.metadata ?? {}),
          failureReason: cleanString(input.failureReason)
        })
      }
    });

    return serializePublicRtoNdrRecoveryIntent(intent, false);
  } catch (error) {
    if (idempotencyKey && isDuplicateKeyError(error)) {
      const existing = await client.rtoNdrRecoveryIntent.findUnique({ where: { idempotencyKey } });
      if (existing) return serializePublicRtoNdrRecoveryIntent(existing, true);
    }
    throw error;
  }
}

export async function getRtoNdrRecoveryIntent(
  intentId: string,
  client: RtoNdrRecoveryDb = defaultClient
) {
  const intent = await client.rtoNdrRecoveryIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new HttpError(404, "RTO_NDR_RECOVERY_INTENT_NOT_FOUND");
  return serializePublicRtoNdrRecoveryIntent(intent, false);
}
