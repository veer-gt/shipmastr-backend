import type {
  PartnerLeadConsentStatus,
  PartnerLeadRoutingStatus
} from "@prisma/client";

export const partnerLeadConsentStatuses = [
  "DRAFT",
  "GRANTED",
  "REVOKED",
  "EXPIRED"
] as const satisfies readonly PartnerLeadConsentStatus[];

export const partnerLeadManageableConsentStatuses = [
  "GRANTED",
  "REVOKED",
  "EXPIRED"
] as const satisfies readonly PartnerLeadConsentStatus[];

export const partnerLeadRoutingStatuses = [
  "CREATED",
  "CONSENT_REQUIRED",
  "READY_SIMULATED",
  "ROUTED_SIMULATED",
  "BLOCKED",
  "CANCELLED",
  "ARCHIVED"
] as const satisfies readonly PartnerLeadRoutingStatus[];
