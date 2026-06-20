import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { getSellerShipment } from "../../shippingNetwork/shipping-shipments.service.js";
import { arbitrateCourierPickup } from "../arbitration/courier-arbitration.service.js";
import type { CourierArbitrationCapability } from "../arbitration/courier-arbitration.types.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import {
  checkCourierProviderLiveWorkflowAllowed
} from "../providerRegistry/courier-provider-registry.service.js";
import type {
  CourierProviderCapability,
  CourierProviderLaneCode
} from "../providerRegistry/courier-provider-registry.types.js";
import {
  evaluateCourierShipmentReadinessAutopilot
} from "../readinessAutopilot/courier-readiness-autopilot.service.js";
import type { CourierReadinessAutopilotProviderResult } from "../readinessAutopilot/courier-readiness-autopilot.types.js";
import type {
  CertifiedProviderRoutingDecision,
  CertifiedProviderRoutingDependencies,
  CertifiedProviderRoutingInput,
  CertifiedProviderRoutingOutcome,
  CertifiedProviderRoutingProviderDiagnostic,
  CertifiedProviderRoutingPublicTier,
  CertifiedProviderRoutingRateCandidate,
  CertifiedProviderRoutingResult,
  CertifiedProviderRoutingSelection,
  CertifiedProviderRoutingWorkflowGuard
} from "./certified-provider-routing.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

const PUBLIC_NETWORK_NAME = "Shipmastr Courier Network" as const;
const DEFAULT_PROVIDER: CourierLiveProviderKey = "SHIPROCKET";
const DEFAULT_CAPABILITY: CourierArbitrationCapability = "AWB";
const DEFAULT_OUTCOME: CertifiedProviderRoutingOutcome = "DEFAULT_SMART";

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function publicTier(input: {
  preferred?: CertifiedProviderRoutingPublicTier;
  outcome: CertifiedProviderRoutingOutcome;
}): CertifiedProviderRoutingPublicTier {
  if (input.preferred) return input.preferred;
  if (input.outcome === "CHEAPEST") return "shipmastr_economy";
  if (input.outcome === "FASTEST") return "shipmastr_express";
  return "shipmastr_smart";
}

function publicServiceName(tier: CertifiedProviderRoutingPublicTier | null) {
  if (tier === "shipmastr_economy") return "Shipmastr Economy";
  if (tier === "shipmastr_express") return "Shipmastr Express";
  if (tier === "shipmastr_smart") return "Shipmastr Smart";
  return null;
}

function rateMatchesTier(rate: CertifiedProviderRoutingRateCandidate, tier: CertifiedProviderRoutingPublicTier) {
  return rate.publicServiceCode === tier
    || (tier === "shipmastr_smart" && rate.publicServiceName === "Shipmastr Smart")
    || (tier === "shipmastr_economy" && rate.publicServiceName === "Shipmastr Economy")
    || (tier === "shipmastr_express" && rate.publicServiceName === "Shipmastr Express");
}

function selectedRate(rates: CertifiedProviderRoutingRateCandidate[], tier: CertifiedProviderRoutingPublicTier) {
  return rates.find((rate) => rateMatchesTier(rate, tier)) ?? rates[0] ?? null;
}

function providerCourierIdPresent(rate: CertifiedProviderRoutingRateCandidate | null) {
  const root = metadataObject(rate?.rateBreakup);
  const phase6 = metadataObject(root.phase6);
  const result = metadataObject(root.result);
  const value = firstString(
    phase6.providerCourierId,
    phase6.shiprocketCourierId,
    phase6.courier_id,
    phase6.courierId,
    root.providerCourierId,
    root.internalCourierId,
    root.courier_id,
    root.courierId,
    result.providerCourierId,
    result.courier_id,
    result.courierId
  );
  return Boolean(value && /^[0-9]+$/.test(value));
}

function pickupAvailable(provider: CourierReadinessAutopilotProviderResult | null) {
  if (!provider) return false;
  return !provider.blockers.some((blocker) => [
    "PROVIDER_PICKUP_UNAVAILABLE",
    "PROVIDER_PICKUP_NOT_FOUND",
    "PROVIDER_PICKUP_PINCODE_MISMATCH",
    "PROVIDER_LATEST_RATE_REFRESH_NO_ELIGIBLE_RATES",
    "PROVIDER_SERVICEABILITY_NO_CANDIDATES"
  ].includes(blocker));
}

function providerLiveReady(provider: CourierReadinessAutopilotProviderResult) {
  return provider.lifecycle_state === "LIVE_READY"
    && provider.capabilities.awb === "READY"
    && provider.capabilities.label === "READY"
    && provider.capabilities.tracking === "READY";
}

function providerCanRouteCapability(
  provider: CourierReadinessAutopilotProviderResult,
  capability: CourierArbitrationCapability
) {
  if (capability === "RATES") return provider.capabilities.rates === "READY";
  if (capability === "AWB") return providerLiveReady(provider) && provider.capabilities.awb === "READY";
  if (capability === "LABEL") return providerLiveReady(provider) && provider.capabilities.label === "READY";
  return providerLiveReady(provider) && provider.capabilities.tracking === "READY";
}

function providerCapabilityStatus(
  provider: CourierReadinessAutopilotProviderResult,
  capability: CourierArbitrationCapability
) {
  if (capability === "RATES") return provider.capabilities.rates;
  if (capability === "AWB") return provider.capabilities.awb;
  if (capability === "LABEL") return provider.capabilities.label;
  return provider.capabilities.tracking;
}

function providerRegistryCapability(capability: CourierArbitrationCapability): CourierProviderCapability {
  if (capability === "RATES") return "RATE";
  return capability;
}

function providerLaneCode(providerKey: CourierLiveProviderKey): CourierProviderLaneCode | null {
  if (providerKey === "BIGSHIP") return "BIGSHIP";
  if (providerKey === "SHIPROCKET") return "SHIPROCKET";
  return null;
}

function fallbackReason(blockers: readonly string[]) {
  if (!blockers.length) return null;
  if (blockers.some((blocker) => blocker.includes("SUSPENDED"))) return "LANE_SUSPENDED";
  if (blockers.some((blocker) => blocker.includes("DISABLED"))) return "LANE_DISABLED";
  if (blockers.some((blocker) => blocker.includes("CREDENTIAL"))) return "CREDENTIALS_NOT_READY";
  if (blockers.some((blocker) => blocker.includes("UNSUPPORTED"))) return "CAPABILITY_UNSUPPORTED";
  if (blockers.some((blocker) => blocker.includes("PICKUP"))) return "PICKUP_OR_SERVICEABILITY_NOT_READY";
  if (blockers.some((blocker) => blocker.includes("CERTIFIED") || blocker.includes("ONE_SHOT"))) return "CERTIFICATION_NOT_READY";
  if (blockers.some((blocker) => blocker.includes("DRY_RUN"))) return "DRY_RUN_ONLY";
  return "READINESS_NOT_READY";
}

function readinessBlockers(
  provider: CourierReadinessAutopilotProviderResult,
  capability: CourierArbitrationCapability
) {
  const blockers = [...provider.blockers];
  const lifecycle = provider.lifecycle_state;
  if (lifecycle === "NOT_CONFIGURED") blockers.push("PROVIDER_NOT_CONFIGURED");
  if (lifecycle === "REVOKED") blockers.push("PROVIDER_REVOKED");
  if (lifecycle === "DRY_RUN_ONLY") blockers.push("PROVIDER_DRY_RUN_ONLY");
  if (lifecycle === "BLOCKED") blockers.push("PROVIDER_BLOCKED");
  if (!pickupAvailable(provider)) blockers.push("PROVIDER_PICKUP_OR_SERVICEABILITY_NOT_READY");
  if (!providerCanRouteCapability(provider, capability)) blockers.push("PROVIDER_CAPABILITY_NOT_READY");
  return unique(blockers);
}

function notModeledWorkflowGuard(input: {
  laneCode: CourierProviderLaneCode | null;
  capability: CourierProviderCapability;
}): CertifiedProviderRoutingWorkflowGuard {
  return {
    lane_code: input.laneCode,
    capability: input.capability,
    requested_mode: "LIVE",
    status: "NOT_MODELED",
    allowed: true,
    blockers: [],
    warnings: input.laneCode ? [] : ["Provider registry lane is not modeled for this legacy provider."],
    next_actions: []
  };
}

async function defaultProviderWorkflowGuard(
  merchantId: string,
  input: {
    provider: CourierReadinessAutopilotProviderResult;
    providerKey: CourierLiveProviderKey;
    laneCode: CourierProviderLaneCode | null;
    requestedCapability: CourierArbitrationCapability;
    providerCapability: CourierProviderCapability;
  },
  client: Db
): Promise<CertifiedProviderRoutingWorkflowGuard> {
  if (!input.laneCode) {
    return notModeledWorkflowGuard({
      laneCode: input.laneCode,
      capability: input.providerCapability
    });
  }
  const guard = await checkCourierProviderLiveWorkflowAllowed({
    merchantId,
    laneCode: input.laneCode,
    capability: input.providerCapability,
    mode: "LIVE"
  }, {}, client);
  return {
    lane_code: guard.lane_code,
    capability: guard.capability,
    requested_mode: guard.requested_mode,
    status: guard.status,
    allowed: guard.allowed,
    blockers: guard.blockers,
    warnings: guard.warnings,
    next_actions: []
  };
}

function decisionMessage(decision: CertifiedProviderRoutingDecision) {
  if (decision === "AWB_READY" || decision === "ROUTE_READY") {
    return "Shipmastr selected a safe shipping path for this shipment.";
  }
  if (decision === "RATES_ONLY") {
    return "Shipmastr rates are available, but this shipment remains in safe review before shipping.";
  }
  if (decision === "TRY_ALTERNATE_PICKUP" || decision === "RUN_PICKUP_TRIAL") {
    return "Try another pickup location.";
  }
  if (decision === "TRY_ALTERNATE_PROVIDER") {
    return "Shipmastr found another safe shipping path to review.";
  }
  return "Shipmastr will keep this shipment in safe review.";
}

function routeNextActions(decision: CertifiedProviderRoutingDecision) {
  if (decision === "AWB_READY") return ["Proceed only through explicit Ship Now after final operator approval."];
  if (decision === "ROUTE_READY") return ["Use the selected Shipmastr tier for controlled routing."];
  if (decision === "RATES_ONLY") return ["Complete AWB, label, and tracking certification before live Ship Now."];
  if (decision === "TRY_ALTERNATE_PICKUP") return ["Review the alternate pickup option before refreshing rates."];
  if (decision === "RUN_PICKUP_TRIAL") return ["Run a controlled alternate pickup trial. Do not Ship Now."];
  if (decision === "TRY_ALTERNATE_PROVIDER") return ["Review the alternate certified provider path before shipping."];
  return ["Keep this shipment in safe review."];
}

async function defaultShipmentProvider(merchantId: string, shipmentId: string, client: Db) {
  const shipment = await getSellerShipment(merchantId, shipmentId, client);
  return {
    id: shipment.id,
    pickupLocationId: shipment.pickupLocationId
  };
}

async function defaultRatesProvider(merchantId: string, shipmentId: string, client: Db) {
  const model = (client as Db & { shipmentRate?: { findMany?: Function } }).shipmentRate;
  if (!model?.findMany) return [];
  return model.findMany({
    where: {
      sellerId: merchantId,
      shipmentId
    },
    orderBy: { createdAt: "desc" },
    take: 20
  }) as Promise<CertifiedProviderRoutingRateCandidate[]>;
}

async function readinessList(
  merchantId: string,
  input: CertifiedProviderRoutingInput,
  dependencies: CertifiedProviderRoutingDependencies
) {
  return dependencies.readinessProvider
    ? dependencies.readinessProvider(merchantId, input)
    : evaluateCourierShipmentReadinessAutopilot(merchantId, input.shipmentId, {
      requestedCapability: input.requestedCapability ?? DEFAULT_CAPABILITY,
      includeArbitration: false,
      ...(input.pickupLocationId ? { pickupLocationId: input.pickupLocationId } : {})
    });
}

async function arbitrationDecision(
  merchantId: string,
  input: CertifiedProviderRoutingInput,
  providerKey: CourierLiveProviderKey,
  dependencies: CertifiedProviderRoutingDependencies
) {
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

function primaryProvider(providers: CourierReadinessAutopilotProviderResult[]) {
  return providers.find((provider) => provider.provider_key_internal === DEFAULT_PROVIDER) ?? providers[0] ?? null;
}

function chooseProvider(input: {
  providers: CourierReadinessAutopilotProviderResult[];
  primary: CourierReadinessAutopilotProviderResult | null;
  capability: CourierArbitrationCapability;
  arbitration: Awaited<ReturnType<typeof arbitrationDecision>> | null;
}) {
  const liveReady = input.providers.filter(providerLiveReady);
  const capabilityReady = input.providers.filter((provider) => providerCanRouteCapability(provider, input.capability));
  const selectedByArbitration = input.arbitration?.selected_option?.provider_key_internal
    ? input.providers.find((provider) => provider.provider_key_internal === input.arbitration?.selected_option?.provider_key_internal) ?? null
    : null;
  return {
    selectedByArbitration,
    liveReady,
    capabilityReady,
    selected: selectedByArbitration ?? input.primary ?? capabilityReady[0] ?? liveReady[0] ?? null
  };
}

async function providerDiagnostics(input: {
  merchantId: string;
  providers: CourierReadinessAutopilotProviderResult[];
  primary: CourierReadinessAutopilotProviderResult | null;
  capability: CourierArbitrationCapability;
  dependencies: CertifiedProviderRoutingDependencies;
  client: Db;
  selectedByArbitration: CourierReadinessAutopilotProviderResult | null;
}) {
  const providerCapability = providerRegistryCapability(input.capability);
  const preferredProviderKey = input.selectedByArbitration?.provider_key_internal
    ?? input.primary?.provider_key_internal
    ?? null;

  const rows = await Promise.all(input.providers.map(async (provider) => {
    const laneCode = providerLaneCode(provider.provider_key_internal);
    const guard = input.dependencies.providerWorkflowGuardProvider
      ? await input.dependencies.providerWorkflowGuardProvider(input.merchantId, {
        provider,
        providerKey: provider.provider_key_internal,
        laneCode,
        requestedCapability: input.capability,
        providerCapability,
        mode: "LIVE"
      })
      : await defaultProviderWorkflowGuard(input.merchantId, {
        provider,
        providerKey: provider.provider_key_internal,
        laneCode,
        requestedCapability: input.capability,
        providerCapability
      }, input.client);
    const blockers = unique([
      ...readinessBlockers(provider, input.capability),
      ...(guard.allowed ? [] : guard.blockers)
    ]);
    const eligible = providerCanRouteCapability(provider, input.capability)
      && pickupAvailable(provider)
      && guard.allowed
      && !["NOT_CONFIGURED", "BLOCKED", "DRY_RUN_ONLY", "REVOKED"].includes(provider.lifecycle_state);
    const preferred = provider.provider_key_internal === preferredProviderKey;

    return {
      provider,
      guard,
      diagnostic: {
        provider_key_internal: provider.provider_key_internal,
        lane_code_internal: laneCode,
        eligible,
        preferred,
        selected: false,
        fallback_reason: eligible ? null : fallbackReason(blockers),
        lifecycle_state: provider.lifecycle_state,
        capability_status: providerCapabilityStatus(provider, input.capability),
        registry_status: guard.status,
        pickup_available: pickupAvailable(provider),
        blockers,
        warnings: unique([
          ...provider.warnings,
          ...guard.warnings
        ]),
        next_actions: unique([
          ...provider.admin_next_actions,
          ...guard.next_actions
        ])
      } satisfies CertifiedProviderRoutingProviderDiagnostic
    };
  }));

  const preferred = rows.find((row) => row.diagnostic.preferred && row.diagnostic.eligible) ?? null;
  const selected = preferred ?? rows.find((row) => row.diagnostic.eligible) ?? null;
  const diagnostics = rows.map((row) => ({
    ...row.diagnostic,
    selected: row.provider.provider_key_internal === selected?.provider.provider_key_internal
  }));

  return {
    selectedProvider: selected?.provider ?? null,
    selectedDiagnostic: diagnostics.find((row) => row.selected) ?? null,
    diagnostics,
    fallbackUsed: Boolean(selected && !selected.diagnostic.preferred),
    noEligibleProvider: !selected
  };
}

function routingDecision(input: {
  primary: CourierReadinessAutopilotProviderResult | null;
  selected: CourierReadinessAutopilotProviderResult | null;
  liveReady: CourierReadinessAutopilotProviderResult[];
  capabilityReady: CourierReadinessAutopilotProviderResult[];
  capability: CourierArbitrationCapability;
  fallbackUsed: boolean;
  arbitrationDecision?: string;
}) {
  if (!input.primary && !input.selected) return "SAFE_REVIEW" as const;
  if (input.selected && input.fallbackUsed) return input.capability === "RATES" ? "RATES_ONLY" as const : "TRY_ALTERNATE_PROVIDER" as const;
  if (input.selected && providerCanRouteCapability(input.selected, input.capability)) {
    if (input.capability === "RATES") return "RATES_ONLY" as const;
    return input.capability === "AWB" ? "AWB_READY" as const : "ROUTE_READY" as const;
  }
  if (input.primary && !pickupAvailable(input.primary)) {
    if (input.arbitrationDecision === "TRY_ALTERNATE_PICKUP") return "TRY_ALTERNATE_PICKUP" as const;
    if (input.arbitrationDecision === "RUN_PICKUP_TRIAL") return "RUN_PICKUP_TRIAL" as const;
    return "RUN_PICKUP_TRIAL" as const;
  }
  if (input.capability === "RATES") {
    return input.capabilityReady.length ? "RATES_ONLY" as const : "SAFE_REVIEW" as const;
  }
  if (input.primary?.capabilities.rates === "READY") return "RATES_ONLY" as const;
  const alternateLive = input.liveReady.find((provider) => provider.provider_key_internal !== input.primary?.provider_key_internal);
  if (alternateLive) return "TRY_ALTERNATE_PROVIDER" as const;
  const dryRunOnly = input.selected?.lifecycle_state === "DRY_RUN_ONLY" || input.primary?.lifecycle_state === "DRY_RUN_ONLY";
  return dryRunOnly ? "SAFE_REVIEW" as const : "SAFE_REVIEW" as const;
}

function selectedPublicTier(decision: CertifiedProviderRoutingDecision, tier: CertifiedProviderRoutingPublicTier) {
  return decision === "SAFE_REVIEW" || decision === "BLOCKED" || decision === "RUN_PICKUP_TRIAL" || decision === "TRY_ALTERNATE_PICKUP"
    ? null
    : tier;
}

function selectionFor(input: {
  decision: CertifiedProviderRoutingDecision;
  selected: CourierReadinessAutopilotProviderResult | null;
  rate: CertifiedProviderRoutingRateCandidate | null;
  pickupLocationId: string | null;
}): CertifiedProviderRoutingSelection {
  return {
    provider: ["SAFE_REVIEW", "BLOCKED"].includes(input.decision) ? null : input.selected,
    rate: ["SAFE_REVIEW", "BLOCKED", "RUN_PICKUP_TRIAL", "TRY_ALTERNATE_PICKUP"].includes(input.decision) ? null : input.rate,
    pickupLocationId: ["RUN_PICKUP_TRIAL", "SAFE_REVIEW", "BLOCKED"].includes(input.decision) ? null : input.pickupLocationId
  };
}

export async function evaluateCertifiedProviderRouting(
  merchantId: string,
  input: CertifiedProviderRoutingInput,
  dependencies: CertifiedProviderRoutingDependencies = {},
  options: { client?: Db } = {}
): Promise<CertifiedProviderRoutingResult> {
  const client = options.client ?? prisma;
  const requestedCapability = input.requestedCapability ?? DEFAULT_CAPABILITY;
  const requestedOutcome = input.requestedOutcome ?? DEFAULT_OUTCOME;
  const shipment = dependencies.shipmentProvider
    ? await dependencies.shipmentProvider(merchantId, input.shipmentId)
    : await defaultShipmentProvider(merchantId, input.shipmentId, client);
  const pickupLocationId = input.pickupLocationId ?? shipment.pickupLocationId ?? null;
  const [readiness, rates] = await Promise.all([
    readinessList(merchantId, {
      ...input,
      requestedCapability,
      ...(pickupLocationId ? { pickupLocationId } : {})
    }, dependencies),
    dependencies.ratesProvider
      ? dependencies.ratesProvider(merchantId, shipment.id)
      : defaultRatesProvider(merchantId, shipment.id, client)
  ]);
  const primary = primaryProvider(readiness.providers);
  const arbitration = primary
    ? await arbitrationDecision(merchantId, {
      ...input,
      requestedCapability,
      ...(pickupLocationId ? { pickupLocationId } : {})
    }, primary.provider_key_internal, dependencies)
    : null;
  const chosen = chooseProvider({
    providers: readiness.providers,
    primary,
    capability: requestedCapability,
    arbitration
  });
  const readinessDiagnostics = await providerDiagnostics({
    merchantId,
    providers: readiness.providers,
    primary,
    capability: requestedCapability,
    dependencies,
    client,
    selectedByArbitration: chosen.selectedByArbitration
  });
  const tier = publicTier({
    ...(input.preferredPublicTier ? { preferred: input.preferredPublicTier } : {}),
    outcome: requestedOutcome
  });
  const rate = selectedRate(rates, tier);
  const decision = routingDecision({
    primary,
    selected: chosen.selected,
    liveReady: chosen.liveReady,
    capabilityReady: chosen.capabilityReady,
    capability: requestedCapability,
    fallbackUsed: readinessDiagnostics.fallbackUsed,
    ...(arbitration?.decision ? { arbitrationDecision: arbitration.decision } : {})
  });
  const selectedTier = selectedPublicTier(decision, tier);
  const selection = selectionFor({
    decision,
    selected: readinessDiagnostics.selectedProvider,
    rate,
    pickupLocationId: arbitration?.selected_option?.pickup_location_id ?? pickupLocationId
  });
  const selectedProvider = selection.provider;
  const blockers = unique([
    ...(selectedProvider?.blockers ?? primary?.blockers ?? []),
    ...(arbitration?.blockers ?? []),
    ...(readinessDiagnostics.selectedDiagnostic?.blockers ?? []),
    ...(readinessDiagnostics.noEligibleProvider ? ["NO_ELIGIBLE_CERTIFIED_PROVIDER"] : []),
    ...(decision === "RATES_ONLY" && requestedCapability !== "RATES" ? ["PROVIDER_NOT_CERTIFIED_FOR_LIVE_AWB"] : [])
  ]);
  const warnings = unique([
    ...(selectedProvider?.warnings ?? primary?.warnings ?? []),
    ...(arbitration?.warnings ?? []),
    ...(readinessDiagnostics.fallbackUsed ? ["PREFERRED_PROVIDER_SKIPPED_FOR_SAFE_FALLBACK"] : []),
    ...(readinessDiagnostics.selectedDiagnostic?.warnings ?? [])
  ]);
  return {
    shipment_id: shipment.id,
    public_network_name: PUBLIC_NETWORK_NAME,
    decision,
    selected_public_tier: selectedTier,
    selected_public_service_name: publicServiceName(selectedTier),
    selected_rate_id: selection.rate?.id ?? null,
    selected_pickup_location_id: selection.pickupLocationId,
    internal_selection: {
      provider_key_internal: selectedProvider?.provider_key_internal ?? null,
      internal_courier_id_present: providerCourierIdPresent(selection.rate),
      provider_rate_id_present: Boolean(selection.rate),
      provider_refs_required: requestedCapability !== "RATES" && ["AWB_READY", "ROUTE_READY"].includes(decision)
    },
    readiness: {
      provider_lifecycle_state: selectedProvider?.lifecycle_state ?? primary?.lifecycle_state ?? "NOT_CONFIGURED",
      rates_ready: selectedProvider?.capabilities.rates === "READY" || primary?.capabilities.rates === "READY",
      awb_ready: selectedProvider?.capabilities.awb === "READY",
      label_ready: selectedProvider?.capabilities.label === "READY",
      tracking_ready: selectedProvider?.capabilities.tracking === "READY",
      pickup_available: pickupAvailable(selectedProvider ?? primary)
    },
    blockers,
    warnings,
    seller_safe_message: decisionMessage(decision),
    admin_next_actions: unique([
      ...(selectedProvider?.admin_next_actions ?? primary?.admin_next_actions ?? []),
      ...(arbitration?.admin_next_actions ?? []),
      ...(readinessDiagnostics.selectedDiagnostic?.next_actions ?? []),
      ...routeNextActions(decision)
    ]),
    admin_diagnostics: {
      fallback_used: readinessDiagnostics.fallbackUsed,
      no_eligible_provider: readinessDiagnostics.noEligibleProvider,
      evaluated_providers: readinessDiagnostics.diagnostics
    }
  };
}

export const __certifiedProviderRoutingInternals = {
  publicTier,
  publicServiceName,
  providerCourierIdPresent,
  routingDecision,
  selectedRate,
  providerLaneCode,
  providerRegistryCapability
};
