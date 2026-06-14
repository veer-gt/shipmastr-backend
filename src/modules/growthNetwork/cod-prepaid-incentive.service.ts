import type {
  GrowthOfferStatus,
  GrowthOfferType,
  GrowthPlacementSurface,
  PrepaidConversionIntentStatus,
  PrepaidIncentiveStatus,
  PrepaidIncentiveType
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
  prepaidIncentiveDisplayValue,
  serializePrepaidIncentivePolicy,
  serializePublicPrepaidConversionIntent,
  serializePublicPrepaidIncentiveOffer
} from "./cod-prepaid-incentive.serializer.js";
import type { PrepaidOfferSurface } from "./cod-prepaid-incentive.types.js";
import type {
  CreatePrepaidConversionIntentInput,
  CreatePrepaidIncentivePolicyInput,
  ListPrepaidIncentivePoliciesQueryInput,
  ResolvePrepaidIncentiveInput,
  UpdatePrepaidIncentivePolicyStatusInput
} from "./cod-prepaid-incentive.validation.js";

type PrepaidPolicyRecord = {
  id: string;
  merchantId: string;
  title: string;
  description?: string | null;
  status: PrepaidIncentiveStatus;
  incentiveType: PrepaidIncentiveType;
  discountAmountPaise?: number | null;
  discountPercent?: unknown;
  maxDiscountAmountPaise?: number | null;
  minOrderAmountPaise?: number | null;
  maxOrderAmountPaise?: number | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  metadata?: unknown;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
};

type PrepaidIntentRecord = {
  id: string;
  policyId?: string | null;
  merchantId?: string | null;
  sellerId?: string | null;
  orderId?: string | null;
  shipmentId?: string | null;
  growthOfferId?: string | null;
  status: PrepaidConversionIntentStatus;
  originalPaymentMode?: string | null;
  targetPaymentMode: string;
  incentiveSnapshot: unknown;
  idempotencyKey?: string | null;
  expiresAt?: Date | string | null;
  convertedAt?: Date | string | null;
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

export type CodPrepaidIncentiveDb = GrowthNetworkDb & {
  prepaidIncentivePolicy: {
    create(input: { data: Record<string, unknown> }): Promise<PrepaidPolicyRecord>;
    findMany(input?: Record<string, unknown>): Promise<PrepaidPolicyRecord[]>;
    findUnique(input: { where: Record<string, unknown> }): Promise<PrepaidPolicyRecord | null>;
    update(input: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<PrepaidPolicyRecord>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
  prepaidConversionIntent: {
    create(input: { data: Record<string, unknown> }): Promise<PrepaidIntentRecord>;
    findUnique(input: { where: Record<string, unknown> }): Promise<PrepaidIntentRecord | null>;
  };
  order?: {
    findFirst(input: Record<string, unknown>): Promise<OrderContextRecord | null>;
  };
  shipment?: {
    findFirst(input: Record<string, unknown>): Promise<ShipmentContextRecord | null>;
  };
};

const defaultClient = prisma as unknown as CodPrepaidIncentiveDb;
const unsafeMetadataKeyPattern = /buyer|email|phone|mobile|address|name|provider|courier|secret|token|authorization|cookie|card|upi|payment[_-]?(secret|token|credential|method|instrument)/i;
const unsafeMetadataStringPattern = /@|\b\d{10,}\b|upi:|card_|tok_|secret|bearer\s+|shiprocket|shipmozo|bigship|delhivery|bluedart|blue dart|xpressbees|shadowfax/i;
const terminalStatusSet = new Set([
  "DELIVERED",
  "RTO",
  "RTO_DELIVERED",
  "CANCELLED",
  "CANCELED",
  "LOST",
  "DAMAGED",
  "delivered",
  "rto",
  "rto_delivered",
  "cancelled",
  "canceled",
  "lost",
  "damaged"
]);

function cleanString(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
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
  incentiveType: PrepaidIncentiveType;
  discountAmountPaise?: number | null | undefined;
  discountPercent?: unknown;
  maxDiscountAmountPaise?: number | null | undefined;
  minOrderAmountPaise?: number | null | undefined;
  maxOrderAmountPaise?: number | null | undefined;
  startsAt?: Date | string | null | undefined;
  endsAt?: Date | string | null | undefined;
}) {
  const amountFields = [
    input.discountAmountPaise,
    input.maxDiscountAmountPaise,
    input.minOrderAmountPaise,
    input.maxOrderAmountPaise
  ];
  if (amountFields.some((value) => value != null && value < 0)) {
    throw new HttpError(400, "PREPAID_INCENTIVE_NEGATIVE_AMOUNT");
  }

  const discountPercent = numberValue(input.discountPercent);
  if (discountPercent != null && (discountPercent < 0 || discountPercent > 100)) {
    throw new HttpError(400, "PREPAID_INCENTIVE_PERCENT_OUT_OF_RANGE");
  }

  if (input.incentiveType === "FLAT_DISCOUNT" && !input.discountAmountPaise) {
    throw new HttpError(400, "PREPAID_INCENTIVE_FLAT_AMOUNT_REQUIRED");
  }

  if (input.incentiveType === "PERCENT_DISCOUNT" && !discountPercent) {
    throw new HttpError(400, "PREPAID_INCENTIVE_PERCENT_REQUIRED");
  }

  if (input.minOrderAmountPaise != null && input.maxOrderAmountPaise != null && input.maxOrderAmountPaise < input.minOrderAmountPaise) {
    throw new HttpError(400, "PREPAID_INCENTIVE_INVALID_ORDER_AMOUNT_RANGE");
  }

  if (input.startsAt && input.endsAt && new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()) {
    throw new HttpError(400, "PREPAID_INCENTIVE_INVALID_DATE_RANGE");
  }
}

async function ensurePolicy(policyId: string, client: CodPrepaidIncentiveDb) {
  const policy = await client.prepaidIncentivePolicy.findUnique({ where: { id: policyId } });
  if (!policy) throw new HttpError(404, "PREPAID_INCENTIVE_POLICY_NOT_FOUND");
  return policy;
}

function policyStatusForGrowthOffer(status: PrepaidIncentiveStatus) {
  if (status === "ACTIVE") return "ACTIVE";
  if (status === "ARCHIVED") return "ARCHIVED";
  return "PAUSED";
}

function relatedGrowthOfferWhere(policy: { id: string; merchantId: string }) {
  return {
    merchantId: policy.merchantId,
    type: "PREPAID_INCENTIVE",
    metadata: { path: ["prepaidIncentivePolicyId"], equals: policy.id }
  };
}

async function relatedGrowthOffers(policy: { id: string; merchantId: string }, client: CodPrepaidIncentiveDb) {
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

async function syncRelatedGrowthOfferStatus(policy: PrepaidPolicyRecord, client: CodPrepaidIncentiveDb) {
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

async function ensurePrepaidGrowthOffer(
  policy: PrepaidPolicyRecord,
  surface: PrepaidOfferSurface,
  client: CodPrepaidIncentiveDb
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
        priority: 50,
        rulesJson: { prepaidIncentivePolicyId: policy.id }
      }, client);
    }
    return current.id;
  }

  const offer = await createGrowthOffer({
    merchantId: policy.merchantId,
    title: policy.title,
    subtitle: "Prepaid offer",
    description: policy.description,
    type: "PREPAID_INCENTIVE",
    status,
    isSponsored: false,
    sponsorName: null,
    ctaLabel: "Switch to prepaid",
    ctaUrl: null,
    metadata: {
      phase: "45B",
      prepaidIncentivePolicyId: policy.id
    },
    startsAt: policy.startsAt ? new Date(policy.startsAt) : null,
    endsAt: policy.endsAt ? new Date(policy.endsAt) : null
  }, client);

  await addGrowthOfferPlacement(offer.offerId, {
    surface,
    priority: 50,
    rulesJson: { prepaidIncentivePolicyId: policy.id }
  }, client);

  return offer.offerId;
}

export async function createPrepaidIncentivePolicy(
  input: CreatePrepaidIncentivePolicyInput,
  client: CodPrepaidIncentiveDb = defaultClient
) {
  assertPolicyConfig(input);

  const policy = await client.prepaidIncentivePolicy.create({
    data: {
      merchantId: input.merchantId,
      title: input.title,
      description: cleanString(input.description),
      status: input.status,
      incentiveType: input.incentiveType,
      discountAmountPaise: input.discountAmountPaise ?? null,
      discountPercent: input.discountPercent ?? null,
      maxDiscountAmountPaise: input.maxDiscountAmountPaise ?? null,
      minOrderAmountPaise: input.minOrderAmountPaise ?? null,
      maxOrderAmountPaise: input.maxOrderAmountPaise ?? null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      metadata: toStoredJson(input.metadata)
    }
  });

  return serializePrepaidIncentivePolicy(policy);
}

export async function listPrepaidIncentivePolicies(
  query: ListPrepaidIncentivePoliciesQueryInput,
  client: CodPrepaidIncentiveDb = defaultClient
) {
  const where = {
    ...(cleanString(query.merchantId) ? { merchantId: cleanString(query.merchantId) } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.incentiveType ? { incentiveType: query.incentiveType } : {})
  };

  const [policies, total] = await Promise.all([
    client.prepaidIncentivePolicy.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage
    }),
    client.prepaidIncentivePolicy.count({ where })
  ]);

  return {
    policies: policies.map(serializePrepaidIncentivePolicy),
    pagination: {
      page: query.page,
      perPage: query.perPage,
      total,
      hasMore: query.page * query.perPage < total
    }
  };
}

export async function updatePrepaidIncentivePolicyStatus(
  policyId: string,
  input: UpdatePrepaidIncentivePolicyStatusInput,
  client: CodPrepaidIncentiveDb = defaultClient
) {
  await ensurePolicy(policyId, client);
  const policy = await client.prepaidIncentivePolicy.update({
    where: { id: policyId },
    data: { status: input.status }
  });
  await syncRelatedGrowthOfferStatus(policy, client);
  return serializePrepaidIncentivePolicy(policy);
}

async function findOrderContext(input: ResolvePrepaidIncentiveInput | CreatePrepaidConversionIntentInput, client: CodPrepaidIncentiveDb) {
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
      status: true
    }
  });
}

async function findShipmentContext(input: ResolvePrepaidIncentiveInput | CreatePrepaidConversionIntentInput, client: CodPrepaidIncentiveDb) {
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

async function buildEligibilityContext(input: ResolvePrepaidIncentiveInput, client: CodPrepaidIncentiveDb) {
  const [order, shipment] = await Promise.all([
    findOrderContext(input, client),
    findShipmentContext(input, client)
  ]);

  const paymentMode = cleanString(input.paymentMode)
    ?? cleanString(shipment?.paymentMode)
    ?? cleanString(order?.paymentMode);
  const codAmountPaise = input.codAmountPaise
    ?? shipment?.codAmountPaise
    ?? order?.codAmount
    ?? null;
  const orderAmountPaise = input.orderAmountPaise
    ?? shipment?.declaredValuePaise
    ?? shipment?.codAmountPaise
    ?? order?.orderValue
    ?? order?.codAmount
    ?? null;

  return {
    merchantId: input.merchantId,
    sellerId: cleanString(input.sellerId) ?? cleanString(shipment?.sellerId),
    orderId: cleanString(input.orderId) ?? order?.id ?? shipment?.orderId ?? null,
    shipmentId: cleanString(input.shipmentId) ?? shipment?.id ?? null,
    paymentMode,
    paymentStatus: cleanString(input.paymentStatus),
    isPaid: input.isPaid === true,
    codAmountPaise,
    orderAmountPaise,
    orderStatus: cleanString(input.orderStatus) ?? cleanString(order?.status),
    shipmentStatus: cleanString(input.shipmentStatus) ?? cleanString(shipment?.status)
  };
}

function normalized(value: string | null | undefined) {
  return (value ?? "").trim().toUpperCase();
}

function isPrepaidOrPaid(context: Awaited<ReturnType<typeof buildEligibilityContext>>) {
  const paymentMode = normalized(context.paymentMode);
  const paymentStatus = normalized(context.paymentStatus);
  return context.isPaid
    || paymentMode === "PREPAID"
    || paymentMode === "PAID_ONLINE"
    || paymentStatus === "PAID"
    || paymentStatus === "CAPTURED"
    || paymentStatus === "SUCCESS";
}

function isCodContext(context: Awaited<ReturnType<typeof buildEligibilityContext>>) {
  const paymentMode = normalized(context.paymentMode);
  if (paymentMode === "COD" || paymentMode === "CASH_ON_DELIVERY") return true;
  if (paymentMode === "PREPAID") return false;
  return (context.codAmountPaise ?? 0) > 0;
}

function hasTerminalStatus(context: Awaited<ReturnType<typeof buildEligibilityContext>>) {
  return terminalStatusSet.has(context.orderStatus ?? "") || terminalStatusSet.has(context.shipmentStatus ?? "");
}

function policyIsActive(policy: PrepaidPolicyRecord, now: Date) {
  if (policy.status !== "ACTIVE") return false;
  if (policy.startsAt && new Date(policy.startsAt).getTime() > now.getTime()) return false;
  if (policy.endsAt && new Date(policy.endsAt).getTime() < now.getTime()) return false;
  return true;
}

function policyMatchesAmount(policy: PrepaidPolicyRecord, orderAmountPaise: number | null) {
  if (policy.minOrderAmountPaise != null && orderAmountPaise == null) return false;
  if (policy.maxOrderAmountPaise != null && orderAmountPaise == null) return false;
  if (policy.minOrderAmountPaise != null && (orderAmountPaise ?? 0) < policy.minOrderAmountPaise) return false;
  if (policy.maxOrderAmountPaise != null && (orderAmountPaise ?? 0) > policy.maxOrderAmountPaise) return false;
  return true;
}

function estimatedDiscountValue(policy: PrepaidPolicyRecord, orderAmountPaise: number | null) {
  if (policy.incentiveType === "FLAT_DISCOUNT") return policy.discountAmountPaise ?? 0;
  if (policy.incentiveType === "PERCENT_DISCOUNT" && orderAmountPaise != null) {
    const percent = numberValue(policy.discountPercent) ?? 0;
    const raw = Math.round(orderAmountPaise * (percent / 100));
    return policy.maxDiscountAmountPaise != null ? Math.min(raw, policy.maxDiscountAmountPaise) : raw;
  }
  if (policy.incentiveType === "FREE_SHIPPING" || policy.incentiveType === "COD_FEE_WAIVER") {
    return policy.discountAmountPaise ?? 0;
  }
  return 0;
}

function bestPolicy(policies: PrepaidPolicyRecord[], orderAmountPaise: number | null) {
  return [...policies].sort((left, right) => {
    const discountDelta = estimatedDiscountValue(right, orderAmountPaise) - estimatedDiscountValue(left, orderAmountPaise);
    if (discountDelta !== 0) return discountDelta;
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  })[0] ?? null;
}

export async function resolvePrepaidIncentiveOffer(
  input: ResolvePrepaidIncentiveInput,
  client: CodPrepaidIncentiveDb = defaultClient,
  now = new Date()
) {
  const context = await buildEligibilityContext(input, client);
  if (isPrepaidOrPaid(context)) return { eligible: false, reason: "ORDER_ALREADY_PREPAID_OR_PAID", offer: null };
  if (!isCodContext(context)) return { eligible: false, reason: "COD_CONTEXT_REQUIRED", offer: null };
  if (hasTerminalStatus(context)) return { eligible: false, reason: "ORDER_OR_SHIPMENT_TERMINAL", offer: null };

  const policies = await client.prepaidIncentivePolicy.findMany({
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
    .filter((policy) => policyMatchesAmount(policy, context.orderAmountPaise));
  const policy = bestPolicy(eligiblePolicies, context.orderAmountPaise);
  if (!policy) return { eligible: false, reason: "NO_ELIGIBLE_PREPAID_INCENTIVE_POLICY", offer: null };

  const offerId = await ensurePrepaidGrowthOffer(policy, input.surface, client);
  return {
    eligible: true,
    reason: null,
    offer: serializePublicPrepaidIncentiveOffer({
      policy,
      offerId,
      surface: input.surface,
      expiresAt: policy.endsAt ?? null
    })
  };
}

function intentSnapshot(policy: PrepaidPolicyRecord) {
  return {
    policyId: policy.id,
    title: policy.title,
    incentiveType: policy.incentiveType,
    displayValue: prepaidIncentiveDisplayValue(policy),
    discountAmountPaise: policy.discountAmountPaise ?? null,
    discountPercent: numberValue(policy.discountPercent),
    maxDiscountAmountPaise: policy.maxDiscountAmountPaise ?? null,
    paymentCollection: false
  };
}

export async function createPrepaidConversionIntent(
  input: CreatePrepaidConversionIntentInput,
  client: CodPrepaidIncentiveDb = defaultClient
) {
  if (!cleanString(input.orderId) && !cleanString(input.shipmentId)) {
    throw new HttpError(400, "PREPAID_CONVERSION_INTENT_CONTEXT_REQUIRED");
  }

  const idempotencyKey = cleanString(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = await client.prepaidConversionIntent.findUnique({ where: { idempotencyKey } });
    if (existing) return serializePublicPrepaidConversionIntent(existing, true);
  }

  const policy = await ensurePolicy(input.policyId, client);
  const order = await findOrderContext(input, client);
  const shipment = await findShipmentContext(input, client);
  const originalPaymentMode = cleanString(input.originalPaymentMode)
    ?? cleanString(shipment?.paymentMode)
    ?? cleanString(order?.paymentMode)
    ?? null;
  if (normalized(originalPaymentMode) === "PREPAID") {
    throw new HttpError(400, "PREPAID_CONVERSION_INTENT_REQUIRES_COD_CONTEXT");
  }

  try {
    const intent = await client.prepaidConversionIntent.create({
      data: {
        policyId: policy.id,
        merchantId: input.merchantId,
        sellerId: cleanString(input.sellerId) ?? cleanString(shipment?.sellerId),
        orderId: cleanString(input.orderId) ?? order?.id ?? shipment?.orderId ?? null,
        shipmentId: cleanString(input.shipmentId) ?? shipment?.id ?? null,
        growthOfferId: cleanString(input.growthOfferId),
        status: "INTENT_CREATED",
        originalPaymentMode,
        targetPaymentMode: "PREPAID",
        incentiveSnapshot: toRequiredJson(intentSnapshot(policy)),
        idempotencyKey,
        expiresAt: input.expiresAt ?? policy.endsAt ?? null,
        convertedAt: null,
        metadata: toStoredJson(input.metadata)
      }
    });

    return serializePublicPrepaidConversionIntent(intent, false);
  } catch (error) {
    if (idempotencyKey && isDuplicateKeyError(error)) {
      const existing = await client.prepaidConversionIntent.findUnique({ where: { idempotencyKey } });
      if (existing) return serializePublicPrepaidConversionIntent(existing, true);
    }
    throw error;
  }
}

export async function getPrepaidConversionIntent(
  intentId: string,
  client: CodPrepaidIncentiveDb = defaultClient
) {
  const intent = await client.prepaidConversionIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new HttpError(404, "PREPAID_CONVERSION_INTENT_NOT_FOUND");
  return serializePublicPrepaidConversionIntent(intent, false);
}
