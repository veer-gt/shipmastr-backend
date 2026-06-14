import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { getSellerShipment } from "../../shippingNetwork/shipping-shipments.service.js";
import { arbitrateCourierPickup } from "../arbitration/courier-arbitration.service.js";
import type { CourierArbitrationCapability } from "../arbitration/courier-arbitration.types.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import {
  evaluateCourierShipmentReadinessAutopilot
} from "../readinessAutopilot/courier-readiness-autopilot.service.js";
import type { CourierReadinessAutopilotProviderResult } from "../readinessAutopilot/courier-readiness-autopilot.types.js";
import type {
  CertifiedProviderRoutingDecision,
  CertifiedProviderRoutingDependencies,
  CertifiedProviderRoutingInput,
  CertifiedProviderRoutingOutcome,
  CertifiedProviderRoutingPublicTier,
  CertifiedProviderRoutingRateCandidate,
  CertifiedProviderRoutingResult,
  CertifiedProviderRoutingSelection
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

function routingDecision(input: {
  primary: CourierReadinessAutopilotProviderResult | null;
  selected: CourierReadinessAutopilotProviderResult | null;
  liveReady: CourierReadinessAutopilotProviderResult[];
  capabilityReady: CourierReadinessAutopilotProviderResult[];
  capability: CourierArbitrationCapability;
  arbitrationDecision?: string;
}) {
  if (!input.primary && !input.selected) return "SAFE_REVIEW" as const;
  if (input.primary && !pickupAvailable(input.primary)) {
    if (input.arbitrationDecision === "TRY_ALTERNATE_PICKUP") return "TRY_ALTERNATE_PICKUP" as const;
    if (input.arbitrationDecision === "RUN_PICKUP_TRIAL") return "RUN_PICKUP_TRIAL" as const;
    return "RUN_PICKUP_TRIAL" as const;
  }
  if (input.capability === "RATES") {
    return input.capabilityReady.length ? "RATES_ONLY" as const : "SAFE_REVIEW" as const;
  }
  if (input.primary && providerCanRouteCapability(input.primary, input.capability)) {
    return input.capability === "AWB" ? "AWB_READY" as const : "ROUTE_READY" as const;
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
    ...(arbitration?.decision ? { arbitrationDecision: arbitration.decision } : {})
  });
  const selectedTier = selectedPublicTier(decision, tier);
  const selection = selectionFor({
    decision,
    selected: decision === "TRY_ALTERNATE_PROVIDER"
      ? chosen.liveReady.find((provider) => provider.provider_key_internal !== primary?.provider_key_internal) ?? chosen.selected
      : chosen.selected,
    rate,
    pickupLocationId: arbitration?.selected_option?.pickup_location_id ?? pickupLocationId
  });
  const selectedProvider = selection.provider;
  const blockers = unique([
    ...(selectedProvider?.blockers ?? primary?.blockers ?? []),
    ...(arbitration?.blockers ?? []),
    ...(decision === "RATES_ONLY" && requestedCapability !== "RATES" ? ["PROVIDER_NOT_CERTIFIED_FOR_LIVE_AWB"] : [])
  ]);
  const warnings = unique([
    ...(selectedProvider?.warnings ?? primary?.warnings ?? []),
    ...(arbitration?.warnings ?? [])
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
      ...routeNextActions(decision)
    ])
  };
}

export const __certifiedProviderRoutingInternals = {
  publicTier,
  publicServiceName,
  providerCourierIdPresent,
  routingDecision,
  selectedRate
};
