import type {
  PrepaidConversionIntentStatus,
  PrepaidIncentiveStatus,
  PrepaidIncentiveType
} from "@prisma/client";

import type {
  PublicPrepaidConversionIntent,
  PublicPrepaidIncentiveOffer,
  PrepaidOfferSurface
} from "./cod-prepaid-incentive.types.js";

type PrepaidPolicyRecord = {
  id: string;
  merchantId: string;
  title: string;
  description?: string | null;
  status: PrepaidIncentiveStatus | string;
  incentiveType: PrepaidIncentiveType;
  discountAmountPaise?: number | null;
  discountPercent?: unknown;
  maxDiscountAmountPaise?: number | null;
  minOrderAmountPaise?: number | null;
  maxOrderAmountPaise?: number | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type PrepaidIntentRecord = {
  id: string;
  policyId?: string | null;
  growthOfferId?: string | null;
  status: PrepaidConversionIntentStatus | string;
  targetPaymentMode: string;
  incentiveSnapshot?: unknown;
  expiresAt?: Date | string | null;
  createdAt?: Date | string | null;
};

const unsafePublicTextPattern = /\b(shiprocket|shipmozo|bigship|delhivery|bluedart|blue dart|xpressbees|shadowfax|ecom express|ekart)\b/gi;

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

function safeText(value: string | null | undefined) {
  if (!value) return null;
  return value.replace(unsafePublicTextPattern, "Shipmastr logistics network");
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

function moneyLabel(paise: number) {
  const rupees = paise / 100;
  return Number.isInteger(rupees) ? `Rs ${rupees}` : `Rs ${rupees.toFixed(2)}`;
}

export function prepaidIncentiveDisplayValue(policy: {
  incentiveType: PrepaidIncentiveType;
  discountAmountPaise?: number | null;
  discountPercent?: unknown;
  maxDiscountAmountPaise?: number | null;
}) {
  if (policy.incentiveType === "FLAT_DISCOUNT") {
    return `${moneyLabel(policy.discountAmountPaise ?? 0)} off`;
  }

  if (policy.incentiveType === "PERCENT_DISCOUNT") {
    const percent = numberValue(policy.discountPercent) ?? 0;
    const cap = policy.maxDiscountAmountPaise ? ` up to ${moneyLabel(policy.maxDiscountAmountPaise)}` : "";
    return `${percent}% off${cap}`;
  }

  if (policy.incentiveType === "FREE_SHIPPING") return "Free shipping";
  if (policy.incentiveType === "COD_FEE_WAIVER") return "COD fee waived";
  return "Priority dispatch";
}

export function serializePrepaidIncentivePolicy(record: PrepaidPolicyRecord) {
  return {
    policyId: record.id,
    merchantId: record.merchantId,
    title: safeText(record.title) ?? "",
    description: safeText(record.description),
    status: record.status,
    incentiveType: record.incentiveType,
    displayValue: prepaidIncentiveDisplayValue(record),
    discountAmountPaise: record.discountAmountPaise ?? null,
    discountPercent: numberValue(record.discountPercent),
    maxDiscountAmountPaise: record.maxDiscountAmountPaise ?? null,
    minOrderAmountPaise: record.minOrderAmountPaise ?? null,
    maxOrderAmountPaise: record.maxOrderAmountPaise ?? null,
    startsAt: timestamp(record.startsAt),
    endsAt: timestamp(record.endsAt),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializePublicPrepaidIncentiveOffer(input: {
  policy: PrepaidPolicyRecord;
  offerId?: string | null;
  surface: PrepaidOfferSurface;
  expiresAt?: Date | string | null;
}): PublicPrepaidIncentiveOffer {
  return {
    offerId: input.offerId ?? null,
    policyId: input.policy.id,
    title: safeText(input.policy.title) ?? "",
    description: safeText(input.policy.description),
    incentiveType: input.policy.incentiveType,
    displayValue: prepaidIncentiveDisplayValue(input.policy),
    ctaLabel: "Switch to prepaid",
    label: "COD Shield suggestion",
    expiresAt: timestamp(input.expiresAt ?? input.policy.endsAt),
    surface: input.surface,
    isSponsored: false
  };
}

function snapshotDisplayValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.displayValue === "string" ? snapshot.displayValue : null;
}

export function serializePublicPrepaidConversionIntent(
  record: PrepaidIntentRecord,
  duplicate = false
): PublicPrepaidConversionIntent {
  return {
    intentId: record.id,
    policyId: record.policyId ?? null,
    offerId: record.growthOfferId ?? null,
    status: record.status,
    targetPaymentMode: record.targetPaymentMode,
    displayValue: snapshotDisplayValue(record.incentiveSnapshot),
    expiresAt: timestamp(record.expiresAt),
    duplicate,
    paymentCollection: false,
    createdAt: timestamp(record.createdAt)
  };
}
