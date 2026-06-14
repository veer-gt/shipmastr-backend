import type { CourierCertificationSnapshot } from "../certification/courier-certification.types.js";
import {
  getCourierCertificationDecision,
  type CourierCertificationDecisionCapability
} from "../certification/courier-certification-decision.service.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import type {
  CourierRoutingPolicyResult,
  CourierRoutingTierPublic,
  PublicCourierRoutingPolicyResult
} from "./courier-routing-policy.types.js";

type RoutingPolicyOptions = {
  requestedCapability: CourierCertificationDecisionCapability;
  liveRequested?: boolean;
  tier?: CourierRoutingTierPublic;
  certifications: CourierCertificationSnapshot[];
};

const providerPriority: CourierLiveProviderKey[] = ["SHIPROCKET", "BIGSHIP", "SHIPMOZO"];

function sortProviders(certifications: CourierCertificationSnapshot[]) {
  return [...certifications].sort((left, right) =>
    providerPriority.indexOf(left.provider_key) - providerPriority.indexOf(right.provider_key)
  );
}

function sellerMessage(input: {
  decision: CourierRoutingPolicyResult["decision"];
  fallbackUsed: boolean;
  liveRequested: boolean;
}) {
  if (input.decision === "ALLOW") {
    return input.fallbackUsed
      ? "Shipmastr selected another safe shipping path for this order."
      : "Shipmastr selected a safe shipping path for this order.";
  }
  if (input.decision === "DRY_RUN_ONLY") {
    return "This shipping path is available for safe dry-run checks only.";
  }
  if (!input.liveRequested) {
    return "Shipmastr can continue with safe dry-run routing while live certification is completed.";
  }
  return "No certified live shipping path is ready yet. Shipmastr will keep this order in review.";
}

function blockedEntry(snapshot: CourierCertificationSnapshot, decision: Awaited<ReturnType<typeof getCourierCertificationDecision>>) {
  return {
    provider_key: snapshot.provider_key,
    blockers: decision.blockers,
    next_actions: decision.admin_next_actions
  };
}

export async function evaluateCourierRoutingPolicy(input: RoutingPolicyOptions): Promise<CourierRoutingPolicyResult> {
  const tier = input.tier ?? "Shipmastr Smart";
  const liveRequested = input.liveRequested ?? true;
  const ordered = sortProviders(input.certifications);
  const blocked: CourierRoutingPolicyResult["blocked_providers_internal"] = [];
  let selected: CourierCertificationSnapshot | null = null;
  let selectedDecision: Awaited<ReturnType<typeof getCourierCertificationDecision>> | null = null;
  let dryRunFallback: Awaited<ReturnType<typeof getCourierCertificationDecision>> | null = null;
  let dryRunSnapshot: CourierCertificationSnapshot | null = null;

  for (const snapshot of ordered) {
    const decision = await getCourierCertificationDecision({
      merchantId: "routing_policy_snapshot",
      providerKey: snapshot.provider_key,
      requestedCapability: input.requestedCapability
    }, {
      certification: snapshot,
      oneShotPilotGatePassed: input.requestedCapability === "AWB" && snapshot.status === "READY_FOR_LIVE",
      existingAwb: false
    });

    if (decision.allowed) {
      selected = snapshot;
      selectedDecision = decision;
      break;
    }

    if (!liveRequested && decision.decision === "DRY_RUN_ONLY" && !dryRunFallback) {
      dryRunFallback = decision;
      dryRunSnapshot = snapshot;
    }

    blocked.push(blockedEntry(snapshot, decision));
  }

  if (!selected && dryRunFallback && dryRunSnapshot) {
    return {
      selected_provider_internal: dryRunSnapshot.provider_key,
      selected_tier_public: tier,
      requested_capability: input.requestedCapability,
      decision: "DRY_RUN_ONLY",
      fallback_used: ordered[0]?.provider_key !== dryRunSnapshot.provider_key,
      blocked_providers_internal: blocked,
      seller_safe_message: sellerMessage({ decision: "DRY_RUN_ONLY", fallbackUsed: true, liveRequested })
    };
  }

  if (selected && selectedDecision) {
    return {
      selected_provider_internal: selected.provider_key,
      selected_tier_public: tier,
      requested_capability: input.requestedCapability,
      decision: selectedDecision.decision,
      fallback_used: ordered[0]?.provider_key !== selected.provider_key,
      blocked_providers_internal: blocked,
      seller_safe_message: sellerMessage({
        decision: selectedDecision.decision,
        fallbackUsed: ordered[0]?.provider_key !== selected.provider_key,
        liveRequested
      })
    };
  }

  return {
    selected_provider_internal: null,
    selected_tier_public: tier,
    requested_capability: input.requestedCapability,
    decision: "BLOCK",
    fallback_used: false,
    blocked_providers_internal: blocked,
    seller_safe_message: sellerMessage({ decision: "BLOCK", fallbackUsed: false, liveRequested })
  };
}

export function publicCourierRoutingPolicyResult(result: CourierRoutingPolicyResult): PublicCourierRoutingPolicyResult {
  return {
    selected_tier_public: result.selected_tier_public,
    requested_capability: result.requested_capability,
    decision: result.decision,
    fallback_used: result.fallback_used,
    seller_safe_message: result.seller_safe_message
  };
}
