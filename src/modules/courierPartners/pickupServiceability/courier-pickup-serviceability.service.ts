import { Prisma } from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import {
  latestRateRefreshDiagnosticFromShipment,
  type LiveRateRefreshDiagnostic
} from "../../shippingNetwork/shipping-rates.service.js";
import { getSellerShipment } from "../../shippingNetwork/shipping-shipments.service.js";
import { getCourierPickupLearningForShipment } from "../pickupLearning/courier-pickup-learning.service.js";
import type {
  CourierPickupServiceabilityContext,
  CourierPickupServiceabilityRecommendationAction,
  CourierPickupServiceabilityResult,
  CourierPickupServiceabilityStatus,
  CourierPickupTrialResult,
  CourierPickupTrialStatus
} from "./courier-pickup-serviceability.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

type RateRecord = {
  id: string;
  publicServiceCode?: string | null;
  publicServiceName?: string | null;
  rateBreakup?: unknown;
  amountPaise?: number | null;
};

type PickupRecord = {
  id: string;
  label?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  status?: string | null;
};

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function boolValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function stringValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function isNumericProviderCourierId(value: unknown) {
  const normalized = stringValue(value);
  return Boolean(normalized && /^[0-9]+$/.test(normalized));
}

function phase6Metadata(rate: RateRecord) {
  return metadataObject(metadataObject(rate.rateBreakup).phase6);
}

function rootRateMetadata(rate: RateRecord) {
  return metadataObject(rate.rateBreakup);
}

function rateProviderCourierIdPresent(rate: RateRecord) {
  const phase6 = phase6Metadata(rate);
  const root = rootRateMetadata(rate);
  const result = metadataObject(root.result);
  return isNumericProviderCourierId(phase6.providerCourierId)
    || isNumericProviderCourierId(root.providerCourierId)
    || isNumericProviderCourierId(root.internalCourierId)
    || isNumericProviderCourierId(result.providerCourierId)
    || isNumericProviderCourierId(result.courier_id)
    || isNumericProviderCourierId(result.courierId);
}

function rateContext(rates: RateRecord[]): CourierPickupServiceabilityContext {
  const candidateCount = rates.length;
  const pickupAvailableCount = rates.filter((rate) => boolValue(phase6Metadata(rate).pickupAvailable) === true).length;
  const deliveryAvailableCount = rates.filter((rate) => boolValue(phase6Metadata(rate).deliveryAvailable) !== false).length;
  const numericCourierIdCount = rates.filter(rateProviderCourierIdPresent).length;
  const liveMode = rates.some((rate) => stringValue(phase6Metadata(rate).livePilotRatesMode) === "LIVE");
  const liveReady = rates.some((rate) => phase6Metadata(rate).livePilotRatesReady === true);
  const eligibleCount = rates.filter((rate) => {
    const phase6 = phase6Metadata(rate);
    const amount = numberValue(rate.amountPaise);
    return boolValue(phase6.pickupAvailable) !== false
      && boolValue(phase6.deliveryAvailable) !== false
      && rateProviderCourierIdPresent(rate)
      && (amount === null || amount > 0);
  }).length;
  return {
    live_mode: liveMode,
    live_ready: liveReady,
    candidate_count: candidateCount,
    eligible_count: eligibleCount,
    pickup_available_count: pickupAvailableCount,
    delivery_available_count: deliveryAvailableCount,
    numeric_courier_id_count: numericCourierIdCount
  };
}

function selectedPickupFrom(row: PickupRecord | null) {
  if (!row) return null;
  return {
    pickup_location_id: row.id,
    name: row.label ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    pincode: row.pincode ?? "",
    active: row.status === "active"
  };
}

function statusFrom(input: {
  context: CourierPickupServiceabilityContext;
  latestRefresh: LiveRateRefreshDiagnostic | null;
  pickupContextMismatch: boolean;
  pickupActive: boolean;
}): CourierPickupServiceabilityStatus {
  if (input.pickupContextMismatch) return "PICKUP_CONTEXT_MISMATCH";
  if (!input.pickupActive) return "NEEDS_PROVIDER_PICKUP_VERIFICATION";
  if (input.latestRefresh?.status === "PROVIDER_SERVICEABILITY_NO_CANDIDATES") return "NO_PROVIDER_CANDIDATES";
  if (input.latestRefresh?.status === "NO_ELIGIBLE_SHIPPING_RATES" && input.context.candidate_count === 0) return "NO_PROVIDER_CANDIDATES";
  if (input.context.candidate_count === 0) return "NO_PROVIDER_CANDIDATES";
  if (input.context.pickup_available_count === 0 && input.context.delivery_available_count > 0 && input.context.numeric_courier_id_count > 0) {
    return "PICKUP_UNAVAILABLE";
  }
  if (input.context.eligible_count === 0) return "NO_ELIGIBLE_RATES";
  if (input.context.pickup_available_count > 0) return "PICKUP_AVAILABLE";
  return "UNKNOWN";
}

function blockersFor(status: CourierPickupServiceabilityStatus, activeAlternatePickupCount: number) {
  const blockers: string[] = [];
  if (status === "PICKUP_UNAVAILABLE") blockers.push("PROVIDER_PICKUP_UNAVAILABLE");
  if (status === "NO_ELIGIBLE_RATES") blockers.push("PROVIDER_LATEST_RATE_REFRESH_NO_ELIGIBLE_RATES", "PROVIDER_NO_ELIGIBLE_COURIER_FOR_PICKUP");
  if (status === "NO_PROVIDER_CANDIDATES") blockers.push("PROVIDER_NO_PICKUP_AVAILABLE_CANDIDATES");
  if (status === "PICKUP_CONTEXT_MISMATCH") blockers.push("PROVIDER_PICKUP_CONTEXT_MISMATCH");
  if (status === "NEEDS_PROVIDER_PICKUP_VERIFICATION") blockers.push("PROVIDER_PICKUP_REQUIRES_VERIFICATION");
  if (["PICKUP_UNAVAILABLE", "NO_ELIGIBLE_RATES", "NO_PROVIDER_CANDIDATES"].includes(status) && activeAlternatePickupCount > 0) {
    blockers.push("TRY_ALTERNATE_PICKUP");
  }
  if (["NO_ELIGIBLE_RATES", "NO_PROVIDER_CANDIDATES"].includes(status)) blockers.push("TRY_ALTERNATE_PROVIDER");
  return [...new Set(blockers)];
}

function recommendationAction(status: CourierPickupServiceabilityStatus, activeAlternatePickupCount: number): CourierPickupServiceabilityRecommendationAction {
  if (status === "PICKUP_AVAILABLE") return "KEEP_SELECTED";
  if (["PICKUP_UNAVAILABLE", "NO_ELIGIBLE_RATES", "NO_PROVIDER_CANDIDATES"].includes(status) && activeAlternatePickupCount > 0) {
    return "TRY_ALTERNATE_PICKUP";
  }
  if (["NO_ELIGIBLE_RATES", "NO_PROVIDER_CANDIDATES"].includes(status)) return "TRY_ALTERNATE_PROVIDER";
  return "SAFE_REVIEW";
}

function nextActionsFor(status: CourierPickupServiceabilityStatus, action: CourierPickupServiceabilityRecommendationAction) {
  const actions: string[] = [];
  if (status === "PICKUP_UNAVAILABLE") actions.push("Verify or activate this pickup in your shipping account, or try another pickup.");
  if (status === "NO_PROVIDER_CANDIDATES") actions.push("Confirm serviceability for this pickup and delivery pincode before retrying rates.");
  if (status === "NO_ELIGIBLE_RATES") actions.push("Refresh rates after fixing pickup or serviceability, or try another pickup.");
  if (status === "PICKUP_CONTEXT_MISMATCH") actions.push("Use the shipment pickup context or update the shipment pickup before refreshing rates.");
  if (status === "NEEDS_PROVIDER_PICKUP_VERIFICATION") actions.push("Verify the pickup address before live shipping.");
  if (action === "TRY_ALTERNATE_PICKUP") actions.push("Run a controlled rate refresh with another active pickup location.");
  if (action === "TRY_ALTERNATE_PROVIDER") actions.push("Keep the shipment in safe review or try another certified provider.");
  if (!actions.length) actions.push("Keep the selected pickup and continue controlled readiness checks.");
  return [...new Set(actions)];
}

function sellerMessage(status: CourierPickupServiceabilityStatus) {
  if (status === "PICKUP_AVAILABLE") return "Shipmastr shipping is available for this pickup.";
  if (status === "PICKUP_CONTEXT_MISMATCH") return "Pickup context needs review before shipping.";
  if (status === "NEEDS_PROVIDER_PICKUP_VERIFICATION") return "Pickup address needs verification before shipping.";
  return "No Shipmastr shipping option is currently available for this pickup. Try another pickup location or keep this order in review.";
}

async function activePickups(merchantId: string, client: Db): Promise<PickupRecord[]> {
  return client.pickupLocation.findMany({
    where: {
      sellerId: merchantId,
      status: "active"
    },
    orderBy: { createdAt: "asc" }
  }) as Promise<PickupRecord[]>;
}

async function shipmentRates(merchantId: string, shipmentId: string, client: Db): Promise<RateRecord[]> {
  return client.shipmentRate.findMany({
    where: {
      shipmentId,
      sellerId: merchantId
    },
    orderBy: { createdAt: "desc" }
  }) as Promise<RateRecord[]>;
}

export async function diagnoseCourierPickupServiceability(
  merchantId: string,
  input: {
    providerKey: "SHIPROCKET" | string;
    shipmentId: string;
    pickupLocationId?: string;
    deliveryPincode?: string;
  },
  options: { client?: Db } = {}
): Promise<CourierPickupServiceabilityResult> {
  const client = options.client ?? prisma;
  if (input.providerKey !== "SHIPROCKET") throw new HttpError(400, "COURIER_PICKUP_SERVICEABILITY_UNSUPPORTED_PROVIDER");
  const shipment = await getSellerShipment(merchantId, input.shipmentId, client);
  const pickupLocationId = input.pickupLocationId ?? shipment.pickupLocationId ?? null;
  const selectedPickup = pickupLocationId
    ? selectedPickupFrom(await client.pickupLocation.findFirst({
      where: {
        id: pickupLocationId,
        sellerId: merchantId
      }
    }) as PickupRecord | null)
    : null;
  const rates = await shipmentRates(merchantId, shipment.id, client);
  const context = rateContext(rates);
  const latestRefresh = latestRateRefreshDiagnosticFromShipment(shipment);
  const pickups = await activePickups(merchantId, client);
  const activeAlternatePickupCount = pickups.filter((pickup) => pickup.id !== pickupLocationId).length;
  const pickupContextMismatch = Boolean(input.pickupLocationId && shipment.pickupLocationId && input.pickupLocationId !== shipment.pickupLocationId);
  const status = statusFrom({
    context,
    latestRefresh,
    pickupContextMismatch,
    pickupActive: selectedPickup?.active ?? false
  });
  const action = recommendationAction(status, activeAlternatePickupCount);
  const blockers = blockersFor(status, activeAlternatePickupCount);
  const learning = await getCourierPickupLearningForShipment(merchantId, input.providerKey, shipment.id, { client });
  return {
    provider_key: input.providerKey,
    public_network_name: "Shipmastr Courier Network",
    shipment_id: shipment.id,
    pickup_location_id: pickupLocationId,
    pickup_pincode: selectedPickup?.pincode || shipment.fromPincode || null,
    delivery_pincode: input.deliveryPincode ?? shipment.toPincode ?? latestRefresh?.delivery_pincode ?? null,
    status,
    latest_rate_context: context,
    blockers,
    warnings: latestRefresh?.status ? [`Latest rate refresh status: ${latestRefresh.status}`] : [],
    next_actions: nextActionsFor(status, action),
    seller_safe_message: sellerMessage(status),
    recommended_action: action,
    learning_summary: learning
  };
}

function pickupStatusFor(input: {
  pickup: PickupRecord;
  selectedPickupId: string | null;
  selectedDiagnosis: CourierPickupServiceabilityResult;
}): CourierPickupTrialStatus {
  if (input.pickup.id !== input.selectedPickupId) return input.pickup.status === "active" ? "NOT_CHECKED" : "UNKNOWN";
  if (input.selectedDiagnosis.status === "PICKUP_AVAILABLE") return "PICKUP_AVAILABLE";
  if (input.selectedDiagnosis.status === "PICKUP_UNAVAILABLE") return "PICKUP_UNAVAILABLE";
  if (input.selectedDiagnosis.status === "PICKUP_CONTEXT_MISMATCH") return "MISMATCH";
  return input.selectedDiagnosis.latest_rate_context.candidate_count ? "PICKUP_UNAVAILABLE" : "NOT_CHECKED";
}

export async function listCourierPickupServiceabilityTrials(
  merchantId: string,
  input: {
    providerKey: "SHIPROCKET" | string;
    shipmentId: string;
    pickupLocationId?: string;
    deliveryPincode?: string;
  },
  options: { client?: Db } = {}
): Promise<CourierPickupTrialResult> {
  const client = options.client ?? prisma;
  const diagnosis = await diagnoseCourierPickupServiceability(merchantId, input, { client });
  const pickups = await activePickups(merchantId, client);
  const selectedPickupId = diagnosis.pickup_location_id;
  const rows = pickups.map((pickup) => {
    const status = pickupStatusFor({ pickup, selectedPickupId, selectedDiagnosis: diagnosis });
    const selected = pickup.id === selectedPickupId;
    return {
      pickup_location_id: pickup.id,
      name: pickup.label ?? null,
      city: pickup.city ?? null,
      state: pickup.state ?? null,
      pincode: pickup.pincode ?? "",
      active: pickup.status === "active",
      selected,
      status,
      blockers: selected ? diagnosis.blockers : [],
      seller_safe_message: selected
        ? diagnosis.seller_safe_message
        : "This pickup has not been checked for this shipment. Refresh rates with this pickup before shipping."
    };
  });
  const alternate = rows.find((pickup) => !pickup.selected && pickup.active) ?? null;
  const recommendedPickupId = diagnosis.recommended_action === "TRY_ALTERNATE_PICKUP"
    ? alternate?.pickup_location_id ?? null
    : selectedPickupId;
  const reason = diagnosis.recommended_action === "TRY_ALTERNATE_PICKUP"
    ? "Selected pickup is not currently serviceable. Try a controlled rate refresh with another active pickup."
    : diagnosis.seller_safe_message;
  return {
    shipment_id: diagnosis.shipment_id,
    provider_key: input.providerKey,
    pickups: rows,
    recommendation: {
      action: diagnosis.recommended_action,
      pickup_location_id: recommendedPickupId,
      reason
    }
  };
}
