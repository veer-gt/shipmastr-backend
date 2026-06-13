import type {
  GrowthPlacementSurface,
  PrepaidConversionIntentStatus,
  PrepaidIncentiveStatus,
  PrepaidIncentiveType
} from "@prisma/client";

export const prepaidIncentiveStatuses = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "ARCHIVED"
] as const satisfies readonly PrepaidIncentiveStatus[];

export const prepaidManageablePolicyStatuses = [
  "ACTIVE",
  "PAUSED",
  "ARCHIVED"
] as const satisfies readonly PrepaidIncentiveStatus[];

export const prepaidIncentiveTypes = [
  "FLAT_DISCOUNT",
  "PERCENT_DISCOUNT",
  "FREE_SHIPPING",
  "COD_FEE_WAIVER",
  "PRIORITY_DISPATCH"
] as const satisfies readonly PrepaidIncentiveType[];

export const prepaidConversionIntentStatuses = [
  "OFFERED",
  "CLICKED",
  "INTENT_CREATED",
  "PAYMENT_PENDING",
  "CONVERTED_SIMULATED",
  "EXPIRED",
  "CANCELLED"
] as const satisfies readonly PrepaidConversionIntentStatus[];

export type PrepaidOfferSurface = Extract<GrowthPlacementSurface, "TRACKING_PAGE" | "CHECKOUT">;

export const prepaidOfferSurfaces = [
  "TRACKING_PAGE",
  "CHECKOUT"
] as const satisfies readonly PrepaidOfferSurface[];

export type PublicPrepaidIncentiveOffer = {
  offerId: string | null;
  policyId: string;
  title: string;
  description: string | null;
  incentiveType: PrepaidIncentiveType;
  displayValue: string;
  ctaLabel: string;
  label: "COD Shield suggestion";
  expiresAt: Date | string | null;
  surface: PrepaidOfferSurface;
  isSponsored: false;
};

export type PublicPrepaidConversionIntent = {
  intentId: string;
  policyId: string | null;
  offerId: string | null;
  status: PrepaidConversionIntentStatus | string;
  targetPaymentMode: "PREPAID" | string;
  displayValue: string | null;
  expiresAt: Date | string | null;
  duplicate: boolean;
  paymentCollection: false;
  createdAt: Date | string | null;
};
