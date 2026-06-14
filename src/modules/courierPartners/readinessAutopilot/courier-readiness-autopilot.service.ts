import {
  getCourierCertificationProvider,
  listCourierCertificationProviders
} from "../certification/courier-certification.service.js";
import type {
  CourierCertificationDimension,
  CourierCertificationSnapshot
} from "../certification/courier-certification.types.js";
import { arbitrateCourierPickup } from "../arbitration/courier-arbitration.service.js";
import type { CourierArbitrationCapability } from "../arbitration/courier-arbitration.types.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import type {
  CourierReadinessAutopilotCapabilities,
  CourierReadinessAutopilotDependencies,
  CourierReadinessAutopilotInput,
  CourierReadinessAutopilotLifecycleState,
  CourierReadinessAutopilotNextAction,
  CourierReadinessAutopilotProviderList,
  CourierReadinessAutopilotProviderResult
} from "./courier-readiness-autopilot.types.js";

const PUBLIC_NETWORK_NAME = "Shipmastr Courier Network" as const;
const DEFAULT_CAPABILITY: CourierArbitrationCapability = "AWB";
const PROVIDER_KEYS: CourierLiveProviderKey[] = ["SHIPROCKET", "BIGSHIP", "SHIPMOZO"];

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function dimension(snapshot: CourierCertificationSnapshot, key: CourierCertificationDimension["key"]) {
  return snapshot.dimensions.find((item) => item.key === key) ?? null;
}

function dimensionPass(snapshot: CourierCertificationSnapshot, key: CourierCertificationDimension["key"]) {
  return dimension(snapshot, key)?.status === "PASS";
}

function safeSummaryBool(snapshot: CourierCertificationSnapshot, key: CourierCertificationDimension["key"], field: string) {
  const value = dimension(snapshot, key)?.safe_summary?.[field];
  return typeof value === "boolean" ? value : false;
}

function sandboxAvailable(snapshot: CourierCertificationSnapshot, key: "AWB" | "LABEL" | "TRACKING") {
  return dimension(snapshot, key)?.safe_summary?.sandbox_status === "AVAILABLE";
}

function hasAnyBlocker(snapshot: CourierCertificationSnapshot, blockers: string[]) {
  return blockers.some((blocker) => snapshot.blockers.includes(blocker));
}

function isPickupBlocked(snapshot: CourierCertificationSnapshot) {
  return hasAnyBlocker(snapshot, [
    "PROVIDER_PICKUP_UNAVAILABLE",
    "PROVIDER_PICKUP_NOT_FOUND",
    "PROVIDER_PICKUP_PINCODE_MISMATCH",
    "PROVIDER_LATEST_RATE_REFRESH_NO_ELIGIBLE_RATES",
    "PROVIDER_SERVICEABILITY_NO_CANDIDATES"
  ]);
}

function isCredentialConfigured(snapshot: CourierCertificationSnapshot) {
  return dimension(snapshot, "CREDENTIALS")?.status === "PASS"
    || !snapshot.blockers.includes("PROVIDER_CREDENTIALS_MISSING");
}

function ratesCapability(snapshot: CourierCertificationSnapshot): CourierReadinessAutopilotCapabilities["rates"] {
  if (snapshot.status === "READY_FOR_DRY_RUN") return "DRY_RUN_ONLY";
  if (snapshot.status === "NOT_CONFIGURED" || !isCredentialConfigured(snapshot)) return "NOT_CONFIGURED";
  return snapshot.can_use_for_rates ? "READY" : "BLOCKED";
}

function awbCapability(snapshot: CourierCertificationSnapshot): CourierReadinessAutopilotCapabilities["awb"] {
  if (snapshot.can_use_for_awb) return "READY";
  if (snapshot.status === "NOT_CONFIGURED" || snapshot.status === "READY_FOR_DRY_RUN") return "NOT_CERTIFIED";
  if (isPickupBlocked(snapshot)) return "BLOCKED";
  if (ratesCapability(snapshot) === "READY" && snapshot.blockers.includes("PROVIDER_AWB_NOT_CERTIFIED")) return "ONE_SHOT_READY";
  return snapshot.blockers.includes("PROVIDER_AWB_NOT_CERTIFIED") ? "NOT_CERTIFIED" : "BLOCKED";
}

function labelCapability(snapshot: CourierCertificationSnapshot): CourierReadinessAutopilotCapabilities["label"] {
  if (snapshot.can_use_for_label) return "READY";
  if (snapshot.status === "NOT_CONFIGURED" || snapshot.status === "READY_FOR_DRY_RUN") return "NOT_CERTIFIED";
  if (isPickupBlocked(snapshot) || !snapshot.can_use_for_awb) {
    return snapshot.blockers.includes("PROVIDER_LABEL_NOT_CERTIFIED") ? "NOT_CERTIFIED" : "BLOCKED";
  }
  if (snapshot.blockers.includes("PROVIDER_LABEL_NOT_CERTIFIED")) return "ONE_SHOT_READY";
  return "BLOCKED";
}

function trackingCapability(snapshot: CourierCertificationSnapshot): CourierReadinessAutopilotCapabilities["tracking"] {
  if (snapshot.can_use_for_tracking) return "READY";
  if (snapshot.status === "NOT_CONFIGURED" || snapshot.status === "READY_FOR_DRY_RUN") return "NOT_CERTIFIED";
  if (isPickupBlocked(snapshot) || !snapshot.can_use_for_label) {
    return snapshot.blockers.includes("PROVIDER_TRACKING_NOT_CERTIFIED") ? "NOT_CERTIFIED" : "BLOCKED";
  }
  if (snapshot.blockers.includes("PROVIDER_TRACKING_NOT_CERTIFIED")) return "LIVE_READ_READY";
  return "BLOCKED";
}

function capabilities(snapshot: CourierCertificationSnapshot): CourierReadinessAutopilotCapabilities {
  return {
    rates: ratesCapability(snapshot),
    awb: awbCapability(snapshot),
    label: labelCapability(snapshot),
    tracking: trackingCapability(snapshot)
  };
}

function lifecycleState(snapshot: CourierCertificationSnapshot): CourierReadinessAutopilotLifecycleState {
  if (snapshot.status === "REVOKED") return "REVOKED";
  if (snapshot.status === "READY_FOR_DRY_RUN") return "DRY_RUN_ONLY";
  if (snapshot.status === "NOT_CONFIGURED" || !isCredentialConfigured(snapshot)) return "NOT_CONFIGURED";
  if (isPickupBlocked(snapshot) || snapshot.status === "BLOCKED") return "BLOCKED";
  if (snapshot.status === "READY_FOR_LIVE"
    && dimensionPass(snapshot, "AWB")
    && dimensionPass(snapshot, "LABEL")
    && dimensionPass(snapshot, "TRACKING")) {
    return "LIVE_READY";
  }
  if (dimensionPass(snapshot, "TRACKING")) return "TRACKING_CERTIFIED";
  if (dimensionPass(snapshot, "LABEL")) {
    return sandboxAvailable(snapshot, "TRACKING") ? "TRACKING_SANDBOX_READY" : "LABEL_CERTIFIED";
  }
  if (dimensionPass(snapshot, "AWB")) {
    return sandboxAvailable(snapshot, "LABEL") ? "LABEL_SANDBOX_READY" : "AWB_CERTIFIED";
  }
  if (ratesCapability(snapshot) === "READY") {
    return sandboxAvailable(snapshot, "AWB") ? "AWB_SANDBOX_READY" : "RATES_READY";
  }
  if (dimensionPass(snapshot, "PICKUPS") || dimensionPass(snapshot, "SERVICEABILITY")) return "PICKUP_READY";
  return "CREDENTIALS_READY";
}

function sellerSafeMessage(state: CourierReadinessAutopilotLifecycleState, nextAction: CourierReadinessAutopilotNextAction) {
  if (state === "LIVE_READY") return "Shipmastr Courier Network is ready for controlled shipping.";
  if (state === "DRY_RUN_ONLY") return "This shipping path is available for safe review only.";
  if (nextAction === "RUN_PICKUP_TRIAL" || nextAction === "VERIFY_PICKUP") {
    return "Shipping is in safe review. Try another pickup location.";
  }
  if (state === "NOT_CONFIGURED") return "Shipping setup is not complete yet.";
  if (state === "BLOCKED") return "Shipping is temporarily unavailable. Shipmastr will keep this order in safe review.";
  return "Shipmastr is reviewing this shipping path before live shipping.";
}

function actionFromArbitration(decision?: string): CourierReadinessAutopilotNextAction | null {
  if (decision === "RUN_PICKUP_TRIAL" || decision === "TRY_ALTERNATE_PICKUP") return "RUN_PICKUP_TRIAL";
  if (decision === "SAFE_REVIEW") return "KEEP_IN_REVIEW";
  return null;
}

function nextSafeAction(input: {
  snapshot: CourierCertificationSnapshot;
  state: CourierReadinessAutopilotLifecycleState;
  capabilities: CourierReadinessAutopilotCapabilities;
  arbitrationDecision?: string;
}): CourierReadinessAutopilotNextAction {
  const arbitrationAction = actionFromArbitration(input.arbitrationDecision);
  if (input.state === "LIVE_READY") return "READY_FOR_LIVE";
  if (input.state === "TRACKING_CERTIFIED" || input.state === "PILOT_READY") return "READY_FOR_PILOT";
  if (input.state === "REVOKED" || input.state === "DRY_RUN_ONLY") return "KEEP_IN_REVIEW";
  if (input.state === "NOT_CONFIGURED") return "CONNECT_CREDENTIALS";
  if (arbitrationAction) return arbitrationAction;
  if (isPickupBlocked(input.snapshot)) return "RUN_PICKUP_TRIAL";
  if (hasAnyBlocker(input.snapshot, [
    "PROVIDER_RATES_NOT_LIVE",
    "PROVIDER_SERVICEABILITY_NOT_RUN",
    "PROVIDER_COURIER_ID_MISSING"
  ])) return "REFRESH_RATES";
  if (input.capabilities.awb === "ONE_SHOT_READY") return "RUN_AWB_ONE_SHOT";
  if (input.snapshot.blockers.includes("PROVIDER_AWB_NOT_CERTIFIED") && sandboxAvailable(input.snapshot, "AWB")) return "RUN_AWB_DRY_RUN";
  if (input.capabilities.label === "ONE_SHOT_READY") return "RUN_LABEL_ONE_SHOT";
  if (input.snapshot.blockers.includes("PROVIDER_LABEL_NOT_CERTIFIED") && snapshotReadyForLabelDryRun(input.snapshot)) return "RUN_LABEL_DRY_RUN";
  if (input.capabilities.tracking === "LIVE_READ_READY") return "RUN_TRACKING_ONE_SHOT";
  if (input.snapshot.blockers.includes("PROVIDER_TRACKING_NOT_CERTIFIED") && snapshotReadyForTrackingDryRun(input.snapshot)) return "RUN_TRACKING_DRY_RUN";
  return "KEEP_IN_REVIEW";
}

function snapshotReadyForLabelDryRun(snapshot: CourierCertificationSnapshot) {
  return snapshot.can_use_for_awb && sandboxAvailable(snapshot, "LABEL");
}

function snapshotReadyForTrackingDryRun(snapshot: CourierCertificationSnapshot) {
  return snapshot.can_use_for_label && sandboxAvailable(snapshot, "TRACKING");
}

function adminActionFor(action: CourierReadinessAutopilotNextAction) {
  if (action === "CONNECT_CREDENTIALS") return "Connect and test live credentials before any live routing.";
  if (action === "VERIFY_PICKUP") return "Verify pickup alignment before refreshing rates.";
  if (action === "REFRESH_RATES") return "Refresh controlled pilot rates after pickup alignment.";
  if (action === "RUN_PICKUP_TRIAL") return "Run a controlled alternate pickup trial. Do not Ship Now.";
  if (action === "RUN_AWB_DRY_RUN") return "Run AWB certification dry-run before any explicit one-shot attempt.";
  if (action === "RUN_AWB_ONE_SHOT") return "Run explicit AWB one-shot certification only after approval gates pass.";
  if (action === "RUN_LABEL_DRY_RUN") return "Run label certification dry-run after AWB certification.";
  if (action === "RUN_LABEL_ONE_SHOT") return "Run explicit label one-shot certification only after approval gates pass.";
  if (action === "RUN_TRACKING_DRY_RUN") return "Run tracking certification dry-run after label certification.";
  if (action === "RUN_TRACKING_ONE_SHOT") return "Run explicit tracking live-read one-shot only after approval gates pass.";
  if (action === "READY_FOR_LIVE") return "Provider is certified for controlled live routing.";
  if (action === "READY_FOR_PILOT") return "Provider is certified for pilot review; keep live shipping gated.";
  return "Keep this provider in safe review.";
}

async function maybeArbitrate(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  input: CourierReadinessAutopilotInput,
  dependencies: CourierReadinessAutopilotDependencies
) {
  if (!input.includeArbitration || !input.shipmentId) return null;
  const request = {
    shipmentId: input.shipmentId,
    requestedCapability: input.requestedCapability ?? DEFAULT_CAPABILITY,
    preferredProviderKey: providerKey,
    ...(input.pickupLocationId ? { pickupLocationId: input.pickupLocationId } : {})
  };
  return dependencies.arbitrationProvider
    ? dependencies.arbitrationProvider(merchantId, request)
    : arbitrateCourierPickup(merchantId, request);
}

async function defaultCertificationProvider(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  input: CourierReadinessAutopilotInput
) {
  const { provider } = await getCourierCertificationProvider(merchantId, providerKey, {
    includePickupProbe: false,
    ...(input.shipmentId ? { shipmentId: input.shipmentId } : {}),
    ...(input.pickupLocationId ? { pickupLocationId: input.pickupLocationId } : {})
  });
  return provider;
}

async function defaultCertificationListProvider(
  merchantId: string,
  input: CourierReadinessAutopilotInput
) {
  const { providers } = await listCourierCertificationProviders(merchantId, {
    includePickupProbe: false,
    ...(input.shipmentId ? { shipmentId: input.shipmentId } : {}),
    ...(input.pickupLocationId ? { pickupLocationId: input.pickupLocationId } : {})
  });
  return providers;
}

export async function evaluateCourierReadinessAutopilotProvider(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  input: CourierReadinessAutopilotInput = {},
  dependencies: CourierReadinessAutopilotDependencies = {}
): Promise<CourierReadinessAutopilotProviderResult> {
  const requestedCapability = input.requestedCapability ?? DEFAULT_CAPABILITY;
  const checkedAt = dependencies.checkedAt ?? new Date().toISOString();
  const snapshot = dependencies.certificationProvider
    ? await dependencies.certificationProvider(merchantId, providerKey, input)
    : await defaultCertificationProvider(merchantId, providerKey, input);
  const arbitration = await maybeArbitrate(merchantId, providerKey, { ...input, requestedCapability }, dependencies);
  const providerCapabilities = capabilities(snapshot);
  const state = lifecycleState(snapshot);
  const nextAction = nextSafeAction({
    snapshot,
    state,
    capabilities: providerCapabilities,
    ...(arbitration?.decision ? { arbitrationDecision: arbitration.decision } : {})
  });
  const blockers = unique([
    ...snapshot.blockers,
    ...(arbitration?.blockers ?? [])
  ]);
  const warnings = unique([
    ...snapshot.warnings,
    ...(arbitration?.warnings ?? [])
  ]);
  return {
    provider_key_internal: providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    lifecycle_state: state,
    capabilities: providerCapabilities,
    blockers,
    warnings,
    next_safe_action: nextAction,
    admin_next_actions: unique([
      ...snapshot.next_actions,
      ...(arbitration?.admin_next_actions ?? []),
      adminActionFor(nextAction)
    ]),
    seller_safe_message: sellerSafeMessage(state, nextAction),
    requested_capability: requestedCapability,
    shipment_id: input.shipmentId ?? null,
    checked_at: checkedAt
  };
}

export async function listCourierReadinessAutopilotProviders(
  merchantId: string,
  input: CourierReadinessAutopilotInput = {},
  dependencies: CourierReadinessAutopilotDependencies = {}
): Promise<CourierReadinessAutopilotProviderList> {
  const requestedCapability = input.requestedCapability ?? DEFAULT_CAPABILITY;
  const checkedAt = dependencies.checkedAt ?? new Date().toISOString();
  const snapshots = dependencies.certificationListProvider
    ? await dependencies.certificationListProvider(merchantId, input)
    : await defaultCertificationListProvider(merchantId, input);
  const snapshotsByProvider = new Map(snapshots.map((snapshot) => [snapshot.provider_key, snapshot]));
  const providers = await Promise.all(
    PROVIDER_KEYS
      .filter((providerKey) => snapshotsByProvider.has(providerKey))
      .map((providerKey) => evaluateCourierReadinessAutopilotProvider(
        merchantId,
        providerKey,
        { ...input, requestedCapability },
        {
          ...dependencies,
          checkedAt,
          certificationProvider: async () => snapshotsByProvider.get(providerKey)!
        }
      ))
  );
  return {
    public_network_name: PUBLIC_NETWORK_NAME,
    shipment_id: input.shipmentId ?? null,
    requested_capability: requestedCapability,
    checked_at: checkedAt,
    providers,
    counts: {
      total: providers.length,
      live_ready: providers.filter((provider) => provider.lifecycle_state === "LIVE_READY").length,
      pilot_ready: providers.filter((provider) => provider.lifecycle_state === "PILOT_READY" || provider.lifecycle_state === "TRACKING_CERTIFIED").length,
      dry_run_only: providers.filter((provider) => provider.lifecycle_state === "DRY_RUN_ONLY").length,
      blocked: providers.filter((provider) => provider.lifecycle_state === "BLOCKED").length,
      not_configured: providers.filter((provider) => provider.lifecycle_state === "NOT_CONFIGURED").length
    },
    blockers: unique(providers.flatMap((provider) => provider.blockers)),
    warnings: unique(providers.flatMap((provider) => provider.warnings)),
    next_safe_actions: [...new Set(providers.map((provider) => provider.next_safe_action))]
  };
}

export async function evaluateCourierShipmentReadinessAutopilot(
  merchantId: string,
  shipmentId: string,
  input: Omit<CourierReadinessAutopilotInput, "shipmentId"> = {},
  dependencies: CourierReadinessAutopilotDependencies = {}
) {
  return listCourierReadinessAutopilotProviders(merchantId, {
    ...input,
    shipmentId,
    includeArbitration: input.includeArbitration ?? true
  }, dependencies);
}

export async function evaluateCourierShipmentProviderReadinessAutopilot(
  merchantId: string,
  shipmentId: string,
  providerKey: CourierLiveProviderKey,
  input: Omit<CourierReadinessAutopilotInput, "shipmentId"> = {},
  dependencies: CourierReadinessAutopilotDependencies = {}
) {
  return evaluateCourierReadinessAutopilotProvider(merchantId, providerKey, {
    ...input,
    shipmentId,
    includeArbitration: input.includeArbitration ?? true
  }, dependencies);
}

export const __courierReadinessAutopilotInternals = {
  capabilities,
  lifecycleState,
  nextSafeAction,
  sellerSafeMessage,
  safeSummaryBool
};
