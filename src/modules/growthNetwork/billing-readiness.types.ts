import type {
  GrowthBillingEventType,
  GrowthBillingReadinessStatus
} from "@prisma/client";

export const growthBillingReadinessStatuses = [
  "NOT_READY",
  "LEGAL_REVIEW_REQUIRED",
  "FINANCE_REVIEW_REQUIRED",
  "READY_SIMULATED",
  "DISABLED"
] as const satisfies readonly GrowthBillingReadinessStatus[];

export const growthBillingEventTypes = [
  "READINESS_CHECK",
  "SIMULATED_CHARGE_CREATED",
  "SIMULATED_INVOICE_DRAFTED",
  "SIMULATED_INVOICE_VOIDED"
] as const satisfies readonly GrowthBillingEventType[];
