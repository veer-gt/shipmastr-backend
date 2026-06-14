import type {
  RtoNdrRecoveryActionType,
  RtoNdrRecoveryIntentStatus,
  RtoNdrRecoveryPolicyStatus
} from "@prisma/client";

import type {
  PublicRtoNdrRecoveryIntent,
  PublicRtoNdrRecoveryOffer,
  RtoNdrRecoverySurface
} from "./rto-ndr-recovery.types.js";

type RtoNdrRecoveryPolicyRecord = {
  id: string;
  merchantId: string;
  title: string;
  description?: string | null;
  status: RtoNdrRecoveryPolicyStatus | string;
  actionType: RtoNdrRecoveryActionType;
  incentiveAmountPaise?: number | null;
  maxIncentiveAmountPaise?: number | null;
  minOrderAmountPaise?: number | null;
  maxOrderAmountPaise?: number | null;
  allowedFailureReasons?: unknown;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type RtoNdrRecoveryIntentRecord = {
  id: string;
  policyId?: string | null;
  growthOfferId?: string | null;
  status: RtoNdrRecoveryIntentStatus | string;
  actionType: RtoNdrRecoveryActionType | string;
  recoverySnapshot?: unknown;
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

function moneyLabel(paise: number) {
  const rupees = paise / 100;
  return Number.isInteger(rupees) ? `Rs ${rupees}` : `Rs ${rupees.toFixed(2)}`;
}

function safeFailureReasons(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => safeText(item) ?? "")
    .filter(Boolean);
}

export function rtoNdrRecoveryDisplayValue(policy: {
  actionType: RtoNdrRecoveryActionType;
  incentiveAmountPaise?: number | null;
  maxIncentiveAmountPaise?: number | null;
}) {
  if (policy.incentiveAmountPaise) {
    const cap = policy.maxIncentiveAmountPaise && policy.maxIncentiveAmountPaise > policy.incentiveAmountPaise
      ? ` up to ${moneyLabel(policy.maxIncentiveAmountPaise)}`
      : "";
    return `${moneyLabel(policy.incentiveAmountPaise)} recovery benefit${cap}`;
  }

  if (policy.actionType === "CONFIRM_ADDRESS") return "Confirm delivery address";
  if (policy.actionType === "UPDATE_ADDRESS") return "Update delivery address";
  if (policy.actionType === "SELECT_RETRY_WINDOW") return "Choose retry window";
  if (policy.actionType === "SWITCH_TO_PREPAID") return "Switch to prepaid";
  if (policy.actionType === "ACCEPT_DELIVERY_INCENTIVE") return "Delivery recovery benefit";
  return "Contact support";
}

export function rtoNdrRecoveryCtaLabel(actionType: RtoNdrRecoveryActionType | string) {
  if (actionType === "CONFIRM_ADDRESS") return "Confirm address";
  if (actionType === "UPDATE_ADDRESS") return "Update address";
  if (actionType === "SELECT_RETRY_WINDOW") return "Retry delivery";
  if (actionType === "SWITCH_TO_PREPAID") return "Switch to prepaid";
  if (actionType === "ACCEPT_DELIVERY_INCENTIVE") return "Accept offer";
  return "Contact support";
}

export function rtoNdrRecoveryPublicLabel(actionType: RtoNdrRecoveryActionType | string): PublicRtoNdrRecoveryOffer["label"] {
  if (actionType === "CONFIRM_ADDRESS" || actionType === "UPDATE_ADDRESS") return "Address confirmation";
  if (actionType === "SELECT_RETRY_WINDOW") return "Retry delivery";
  if (actionType === "SWITCH_TO_PREPAID") return "COD Shield suggestion";
  if (actionType === "ACCEPT_DELIVERY_INCENTIVE") return "Merchant Offer";
  return "Recommended";
}

export function serializeRtoNdrRecoveryPolicy(record: RtoNdrRecoveryPolicyRecord) {
  return {
    policyId: record.id,
    merchantId: record.merchantId,
    title: safeText(record.title) ?? "",
    description: safeText(record.description),
    status: record.status,
    actionType: record.actionType,
    displayValue: rtoNdrRecoveryDisplayValue(record),
    incentiveAmountPaise: record.incentiveAmountPaise ?? null,
    maxIncentiveAmountPaise: record.maxIncentiveAmountPaise ?? null,
    minOrderAmountPaise: record.minOrderAmountPaise ?? null,
    maxOrderAmountPaise: record.maxOrderAmountPaise ?? null,
    allowedFailureReasons: safeFailureReasons(record.allowedFailureReasons),
    startsAt: timestamp(record.startsAt),
    endsAt: timestamp(record.endsAt),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializePublicRtoNdrRecoveryOffer(input: {
  policy: RtoNdrRecoveryPolicyRecord;
  offerId?: string | null;
  surface: RtoNdrRecoverySurface;
  expiresAt?: Date | string | null;
}): PublicRtoNdrRecoveryOffer {
  return {
    offerId: input.offerId ?? null,
    policyId: input.policy.id,
    title: safeText(input.policy.title) ?? "",
    description: safeText(input.policy.description),
    actionType: input.policy.actionType,
    displayValue: rtoNdrRecoveryDisplayValue(input.policy),
    ctaLabel: rtoNdrRecoveryCtaLabel(input.policy.actionType),
    label: rtoNdrRecoveryPublicLabel(input.policy.actionType),
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

export function serializePublicRtoNdrRecoveryIntent(
  record: RtoNdrRecoveryIntentRecord,
  duplicate = false
): PublicRtoNdrRecoveryIntent {
  return {
    intentId: record.id,
    policyId: record.policyId ?? null,
    offerId: record.growthOfferId ?? null,
    status: record.status,
    actionType: record.actionType,
    displayValue: snapshotDisplayValue(record.recoverySnapshot),
    expiresAt: timestamp(record.expiresAt),
    duplicate,
    communicationSent: false,
    courierMutation: false,
    paymentCollection: false,
    createdAt: timestamp(record.createdAt)
  };
}
