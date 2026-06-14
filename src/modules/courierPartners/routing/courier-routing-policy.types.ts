import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import type { CourierCertificationDecisionCapability } from "../certification/courier-certification-decision.service.js";

export type CourierRoutingTierPublic = "Shipmastr Smart" | "Shipmastr Economy" | "Shipmastr Express";

export type CourierRoutingDecision = "ALLOW" | "BLOCK" | "FALLBACK" | "DRY_RUN_ONLY";

export type CourierRoutingPolicyResult = {
  selected_provider_internal: CourierLiveProviderKey | null;
  selected_tier_public: CourierRoutingTierPublic;
  requested_capability: CourierCertificationDecisionCapability;
  decision: CourierRoutingDecision;
  fallback_used: boolean;
  blocked_providers_internal: Array<{
    provider_key: CourierLiveProviderKey;
    blockers: string[];
    next_actions: string[];
  }>;
  seller_safe_message: string;
};

export type PublicCourierRoutingPolicyResult = {
  selected_tier_public: CourierRoutingTierPublic;
  requested_capability: CourierCertificationDecisionCapability;
  decision: CourierRoutingDecision;
  fallback_used: boolean;
  seller_safe_message: string;
};
