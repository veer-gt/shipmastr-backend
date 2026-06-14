import type {
  GrowthPlacementSurface,
  RtoNdrRecoveryActionType,
  RtoNdrRecoveryIntentStatus,
  RtoNdrRecoveryPolicyStatus
} from "@prisma/client";

export const rtoNdrRecoveryPolicyStatuses = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "ARCHIVED"
] as const satisfies readonly RtoNdrRecoveryPolicyStatus[];

export const rtoNdrManageablePolicyStatuses = [
  "ACTIVE",
  "PAUSED",
  "ARCHIVED"
] as const satisfies readonly RtoNdrRecoveryPolicyStatus[];

export const rtoNdrRecoveryActionTypes = [
  "CONFIRM_ADDRESS",
  "UPDATE_ADDRESS",
  "SELECT_RETRY_WINDOW",
  "SWITCH_TO_PREPAID",
  "ACCEPT_DELIVERY_INCENTIVE",
  "CONTACT_SUPPORT"
] as const satisfies readonly RtoNdrRecoveryActionType[];

export const rtoNdrRecoveryIntentStatuses = [
  "OFFERED",
  "CLICKED",
  "INTENT_CREATED",
  "ACTION_PENDING",
  "RECOVERY_SIMULATED",
  "EXPIRED",
  "CANCELLED"
] as const satisfies readonly RtoNdrRecoveryIntentStatus[];

export type RtoNdrRecoverySurface = Extract<GrowthPlacementSurface, "NDR_ACTION" | "TRACKING_PAGE">;

export const rtoNdrRecoverySurfaces = [
  "NDR_ACTION",
  "TRACKING_PAGE"
] as const satisfies readonly RtoNdrRecoverySurface[];

export type PublicRtoNdrRecoveryOffer = {
  offerId: string | null;
  policyId: string;
  title: string;
  description: string | null;
  actionType: RtoNdrRecoveryActionType;
  displayValue: string;
  ctaLabel: string;
  label: "Delivery recovery offer" | "Address confirmation" | "Retry delivery" | "Merchant Offer" | "Recommended" | "COD Shield suggestion";
  expiresAt: Date | string | null;
  surface: RtoNdrRecoverySurface;
  isSponsored: false;
};

export type PublicRtoNdrRecoveryIntent = {
  intentId: string;
  policyId: string | null;
  offerId: string | null;
  status: RtoNdrRecoveryIntentStatus | string;
  actionType: RtoNdrRecoveryActionType | string;
  displayValue: string | null;
  expiresAt: Date | string | null;
  duplicate: boolean;
  communicationSent: false;
  courierMutation: false;
  paymentCollection: false;
  createdAt: Date | string | null;
};
