import { Prisma } from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { getSellerShipment } from "../../shippingNetwork/shipping-shipments.service.js";
import type {
  CourierPickupTrialRateContext,
  CourierPickupTrialRateOption,
  CourierPickupTrialRatePreview,
  CourierPickupTrialResult,
  CourierPickupTrialStatus
} from "./courier-pickup-trial.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

type PickupRecord = {
  id: string;
  sellerId?: string | null;
  pincode?: string | null;
  status?: string | null;
};

type RateRecord = {
  id: string;
  publicServiceCode?: string | null;
  publicServiceName?: string | null;
  amountPaise?: number | null;
  estimatedDeliveryDays?: number | null;
  rateBreakup?: unknown;
};

type TrialOptions = {
  client?: Db;
  ratePreviewer?: (input: {
    merchantId: string;
    shipmentId: string;
    pickupLocationId: string;
    pickupPincode: string;
    deliveryPincode: string | null;
  }) => Promise<CourierPickupTrialRatePreview[]>;
};

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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

function boolValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function isNumericProviderCourierId(value: unknown) {
  const normalized = stringValue(value);
  return Boolean(normalized && /^[0-9]+$/.test(normalized));
}

function safeServiceCode(value: unknown): CourierPickupTrialRateOption["public_service_code"] {
  if (value === "shipmastr_economy" || value === "shipmastr_express" || value === "shipmastr_smart") return value;
  const name = String(value ?? "").toLowerCase();
  if (name.includes("economy")) return "shipmastr_economy";
  if (name.includes("express")) return "shipmastr_express";
  return "shipmastr_smart";
}

function serviceNameFor(code: CourierPickupTrialRateOption["public_service_code"]) {
  if (code === "shipmastr_economy") return "Shipmastr Economy";
  if (code === "shipmastr_express") return "Shipmastr Express";
  return "Shipmastr Smart";
}

function phase6Metadata(rate: RateRecord) {
  return metadataObject(metadataObject(rate.rateBreakup).phase6);
}

function rootMetadata(rate: RateRecord) {
  return metadataObject(rate.rateBreakup);
}

function providerCourierIdPresent(rate: RateRecord) {
  const phase6 = phase6Metadata(rate);
  const root = rootMetadata(rate);
  const result = metadataObject(root.result);
  return isNumericProviderCourierId(phase6.providerCourierId)
    || isNumericProviderCourierId(root.providerCourierId)
    || isNumericProviderCourierId(root.internalCourierId)
    || isNumericProviderCourierId(result.providerCourierId)
    || isNumericProviderCourierId(result.courier_id)
    || isNumericProviderCourierId(result.courierId);
}

function previewProviderCourierIdPresent(rate: CourierPickupTrialRatePreview) {
  return isNumericProviderCourierId(rate.providerCourierId);
}

function storedRateBelongsToPickup(rate: RateRecord, pickupLocationId: string, pickupPincode: string) {
  const phase6 = phase6Metadata(rate);
  const root = rootMetadata(rate);
  return stringValue(phase6.trialPickupLocationId) === pickupLocationId
    || stringValue(phase6.pickupLocationId) === pickupLocationId
    || stringValue(root.trialPickupLocationId) === pickupLocationId
    || stringValue(root.pickupLocationId) === pickupLocationId
    || stringValue(phase6.pickupPincode) === pickupPincode
    || stringValue(root.pickupPincode) === pickupPincode;
}

function emptyContext(): CourierPickupTrialRateContext {
  return {
    candidate_count: 0,
    eligible_count: 0,
    pickup_available_count: 0,
    delivery_available_count: 0,
    numeric_courier_id_count: 0
  };
}

function contextFromRates(rates: RateRecord[]): CourierPickupTrialRateContext {
  return {
    candidate_count: rates.length,
    eligible_count: rates.filter((rate) => {
      const phase6 = phase6Metadata(rate);
      const amount = numberValue(rate.amountPaise);
      return boolValue(phase6.pickupAvailable) !== false
        && boolValue(phase6.deliveryAvailable) !== false
        && providerCourierIdPresent(rate)
        && (amount === null || amount > 0);
    }).length,
    pickup_available_count: rates.filter((rate) => boolValue(phase6Metadata(rate).pickupAvailable) === true).length,
    delivery_available_count: rates.filter((rate) => boolValue(phase6Metadata(rate).deliveryAvailable) !== false).length,
    numeric_courier_id_count: rates.filter(providerCourierIdPresent).length
  };
}

function contextFromPreview(rates: CourierPickupTrialRatePreview[]): CourierPickupTrialRateContext {
  return {
    candidate_count: rates.length,
    eligible_count: rates.filter((rate) => {
      const amount = numberValue(rate.amountPaise);
      return rate.pickupAvailable !== false
        && rate.deliveryAvailable !== false
        && previewProviderCourierIdPresent(rate)
        && (amount === null || amount > 0);
    }).length,
    pickup_available_count: rates.filter((rate) => rate.pickupAvailable === true).length,
    delivery_available_count: rates.filter((rate) => rate.deliveryAvailable !== false).length,
    numeric_courier_id_count: rates.filter(previewProviderCourierIdPresent).length
  };
}

function publicOptionsFromRates(rates: RateRecord[]): CourierPickupTrialRateOption[] {
  return rates
    .filter((rate) => {
      const phase6 = phase6Metadata(rate);
      return boolValue(phase6.pickupAvailable) !== false
        && boolValue(phase6.deliveryAvailable) !== false
        && providerCourierIdPresent(rate);
    })
    .slice(0, 3)
    .map((rate) => {
      const code = safeServiceCode(rate.publicServiceCode ?? rate.publicServiceName);
      return {
        public_service_code: code,
        public_service_name: serviceNameFor(code),
        amount_paise: numberValue(rate.amountPaise),
        estimated_delivery_days: numberValue(rate.estimatedDeliveryDays)
      };
    });
}

function publicOptionsFromPreview(rates: CourierPickupTrialRatePreview[]): CourierPickupTrialRateOption[] {
  return rates
    .filter((rate) => rate.pickupAvailable !== false && rate.deliveryAvailable !== false && previewProviderCourierIdPresent(rate))
    .slice(0, 3)
    .map((rate) => {
      const code = safeServiceCode(rate.publicServiceCode ?? rate.publicServiceName);
      return {
        public_service_code: code,
        public_service_name: serviceNameFor(code),
        amount_paise: numberValue(rate.amountPaise),
        estimated_delivery_days: numberValue(rate.estimatedDeliveryDays)
      };
    });
}

function statusFrom(context: CourierPickupTrialRateContext): CourierPickupTrialStatus {
  if (context.candidate_count === 0) return "NO_PROVIDER_CANDIDATES";
  if (context.pickup_available_count === 0 && context.delivery_available_count > 0 && context.numeric_courier_id_count > 0) {
    return "PICKUP_UNAVAILABLE";
  }
  if (context.eligible_count === 0) return "NO_ELIGIBLE_RATES";
  return "ELIGIBLE_RATES_FOUND";
}

function blockersFor(status: CourierPickupTrialStatus) {
  if (status === "PICKUP_UNAVAILABLE") return ["PROVIDER_PICKUP_UNAVAILABLE"];
  if (status === "NO_ELIGIBLE_RATES") return ["PROVIDER_LATEST_RATE_REFRESH_NO_ELIGIBLE_RATES"];
  if (status === "NO_PROVIDER_CANDIDATES") return ["PROVIDER_NO_PICKUP_AVAILABLE_CANDIDATES"];
  if (status === "DRY_RUN_ONLY") return ["CONTROLLED_TRIAL_REQUIRES_RATE_REFRESH"];
  if (status === "BLOCKED") return ["CONTROLLED_TRIAL_BLOCKED"];
  return [];
}

function sellerMessage(status: CourierPickupTrialStatus) {
  if (status === "ELIGIBLE_RATES_FOUND") return "Shipmastr shipping options are available for this pickup trial.";
  if (status === "DRY_RUN_ONLY") return "This pickup has not been checked yet. Run a controlled rate refresh before shipping.";
  return "Shipping is temporarily unavailable for this pickup. Try another pickup location or keep this order in safe review.";
}

function adminNextActions(status: CourierPickupTrialStatus) {
  if (status === "ELIGIBLE_RATES_FOUND") return ["Review the trial options, then explicitly confirm pickup change before refreshing rates."];
  if (status === "DRY_RUN_ONLY") return ["Run a controlled alternate pickup rate refresh for this pickup. Do not Ship Now until rates are refreshed."];
  if (status === "PICKUP_UNAVAILABLE") return ["Try another pickup location or verify pickup availability in the shipping account."];
  if (status === "NO_PROVIDER_CANDIDATES") return ["Try another pickup or provider after confirming serviceability."];
  return ["Keep shipment in safe review."];
}

async function shipmentRates(client: Db, merchantId: string, shipmentId: string): Promise<RateRecord[]> {
  return client.shipmentRate.findMany({
    where: {
      sellerId: merchantId,
      shipmentId
    },
    orderBy: { createdAt: "desc" }
  }) as Promise<RateRecord[]>;
}

export async function createControlledCourierPickupTrial(
  merchantId: string,
  input: {
    providerKey: "SHIPROCKET" | string;
    shipmentId: string;
    pickupLocationId: string;
    mode: "DRY_RUN";
  },
  options: TrialOptions = {}
): Promise<CourierPickupTrialResult> {
  const client = options.client ?? prisma;
  if (input.providerKey !== "SHIPROCKET") throw new HttpError(400, "COURIER_PICKUP_TRIAL_UNSUPPORTED_PROVIDER");
  const shipment = await getSellerShipment(merchantId, input.shipmentId, client);
  const pickup = await client.pickupLocation.findFirst({
    where: {
      id: input.pickupLocationId,
      sellerId: merchantId
    }
  }) as PickupRecord | null;

  if (!pickup) throw new HttpError(404, "PICKUP_LOCATION_NOT_FOUND");
  if (pickup.status !== "active") throw new HttpError(409, "PICKUP_LOCATION_NOT_ACTIVE");

  const deliveryPincode = shipment.toPincode ?? null;
  const allRates = await shipmentRates(client, merchantId, shipment.id);
  const pickupPincode = pickup.pincode ?? "";
  const storedTrialRates = input.pickupLocationId === shipment.pickupLocationId
    ? allRates
    : allRates.filter((rate) => storedRateBelongsToPickup(rate, input.pickupLocationId, pickupPincode));

  let status: CourierPickupTrialStatus = "DRY_RUN_ONLY";
  let context = emptyContext();
  let publicOptions: CourierPickupTrialRateOption[] = [];
  const warnings: string[] = [];

  if (storedTrialRates.length) {
    context = contextFromRates(storedTrialRates);
    status = statusFrom(context);
    publicOptions = publicOptionsFromRates(storedTrialRates);
    warnings.push("Result is based on stored safe rate evidence only.");
  } else if (options.ratePreviewer) {
    const preview = await options.ratePreviewer({
      merchantId,
      shipmentId: shipment.id,
      pickupLocationId: input.pickupLocationId,
      pickupPincode,
      deliveryPincode
    });
    context = contextFromPreview(preview);
    status = statusFrom(context);
    publicOptions = publicOptionsFromPreview(preview);
    warnings.push("Result is based on a controlled mocked trial preview.");
  } else {
    warnings.push("No stored safe rate evidence exists for this alternate pickup yet.");
  }

  return {
    trial_id: `pickup_trial_${shipment.id}_${input.pickupLocationId}`,
    provider_key: input.providerKey,
    public_network_name: "Shipmastr Courier Network",
    shipment_id: shipment.id,
    current_pickup_location_id: shipment.pickupLocationId ?? null,
    trial_pickup_location_id: input.pickupLocationId,
    trial_pickup_pincode: pickupPincode,
    delivery_pincode: deliveryPincode,
    status,
    rate_context: context,
    public_rate_options: publicOptions,
    blockers: blockersFor(status),
    warnings,
    seller_safe_message: sellerMessage(status),
    admin_next_actions: adminNextActions(status)
  };
}
