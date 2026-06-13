import { Prisma } from "@prisma/client";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { createShiprocketLiveAdapter } from "../providers/shiprocket/shiprocket-live.adapter.js";
import type {
  InternalCourierProviderAdapter,
  ProviderRateResult
} from "../providers/provider-adapter.types.js";
import {
  createMockSafeShippingAdapter
} from "../../shippingNetwork/shipping-pickup-location.service.js";
import {
  moneyToPaise,
  serviceCodeForName,
  toPrismaJson
} from "../../shippingNetwork/shipping-public-serializers.js";
import { assertLiveCourierRatesAllowed } from "../../shippingNetwork/shipping-live-rates-gate.service.js";
import {
  getSellerShipment,
  shipmentWeightForProvider
} from "../../shippingNetwork/shipping-shipments.service.js";
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

type LiveRatesAdapterFactory = (input: Parameters<typeof createShiprocketLiveAdapter>[0]) => InternalCourierProviderAdapter;

type RateRefreshOptions = TrialOptions & {
  adapter?: InternalCourierProviderAdapter;
  liveRatesSource?: Record<string, unknown>;
  liveRatesAdapterFactory?: LiveRatesAdapterFactory;
  now?: () => Date;
};

type StoredTrialEvidence = {
  status?: unknown;
  rate_context?: unknown;
  public_rate_options?: unknown;
  blockers?: unknown;
  warnings?: unknown;
  seller_safe_message?: unknown;
  admin_next_actions?: unknown;
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

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringList(value: unknown) {
  return arrayValue(value).map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
}

function safeStatus(value: unknown): CourierPickupTrialStatus | null {
  if ([
    "ELIGIBLE_RATES_FOUND",
    "NO_ELIGIBLE_RATES",
    "PICKUP_UNAVAILABLE",
    "NO_PROVIDER_CANDIDATES",
    "BLOCKED",
    "CONTROLLED_REFRESH_REQUIRED",
    "DRY_RUN_ONLY"
  ].includes(String(value))) return value as CourierPickupTrialStatus;
  return null;
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

function providerRateMetadata(rate: ProviderRateResult) {
  return metadataObject(rate.providerMetadata);
}

function providerRateCourierId(rate: ProviderRateResult) {
  const metadata = providerRateMetadata(rate);
  return stringValue(rate.providerCourierId)
    ?? stringValue(metadata.providerCourierId)
    ?? stringValue(metadata.courier_id)
    ?? stringValue(metadata.courierId);
}

function providerRatePublicCode(rate: ProviderRateResult) {
  return safeServiceCode(serviceCodeForName(rate.serviceLevel) || rate.serviceLevel);
}

function providerRateEligible(rate: ProviderRateResult) {
  return rate.pickupAvailable !== false
    && rate.deliveryAvailable !== false
    && isNumericProviderCourierId(providerRateCourierId(rate))
    && Number.isFinite(rate.totalCharge)
    && rate.totalCharge > 0;
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

function contextFromProviderRates(rates: ProviderRateResult[]): CourierPickupTrialRateContext {
  return {
    candidate_count: rates.length,
    eligible_count: rates.filter(providerRateEligible).length,
    pickup_available_count: rates.filter((rate) => rate.pickupAvailable === true).length,
    delivery_available_count: rates.filter((rate) => rate.deliveryAvailable !== false).length,
    numeric_courier_id_count: rates.filter((rate) => isNumericProviderCourierId(providerRateCourierId(rate))).length
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

function publicOptionsFromProviderRates(rates: ProviderRateResult[]): CourierPickupTrialRateOption[] {
  return rates
    .filter(providerRateEligible)
    .slice(0, 3)
    .map((rate) => {
      const code = providerRatePublicCode(rate);
      return {
        public_service_code: code,
        public_service_name: serviceNameFor(code),
        amount_paise: Number.isFinite(rate.totalCharge) ? moneyToPaise(rate.totalCharge) : null,
        estimated_delivery_days: numberValue(rate.tatDays)
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
  if (status === "CONTROLLED_REFRESH_REQUIRED") return ["CONTROLLED_TRIAL_REQUIRES_RATE_REFRESH"];
  if (status === "DRY_RUN_ONLY") return ["CONTROLLED_TRIAL_REQUIRES_RATE_REFRESH"];
  if (status === "BLOCKED") return ["CONTROLLED_TRIAL_BLOCKED"];
  return [];
}

function sellerMessage(status: CourierPickupTrialStatus) {
  if (status === "ELIGIBLE_RATES_FOUND") return "Shipmastr shipping options are available for this pickup trial.";
  if (status === "CONTROLLED_REFRESH_REQUIRED") return "This pickup needs a controlled rate refresh before shipping.";
  if (status === "DRY_RUN_ONLY") return "This pickup has not been checked yet. Run a controlled rate refresh before shipping.";
  return "Shipping is temporarily unavailable for this pickup. Try another pickup location or keep this order in safe review.";
}

function adminNextActions(status: CourierPickupTrialStatus) {
  if (status === "ELIGIBLE_RATES_FOUND") return ["Review the trial options, then explicitly confirm pickup change before refreshing rates."];
  if (status === "CONTROLLED_REFRESH_REQUIRED") return ["Run a controlled alternate pickup rate refresh for this pickup. Do not Ship Now until rates are refreshed."];
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

function alternatePickupTrialEvidence(shipment: { metadata?: unknown }, pickupLocationId: string): StoredTrialEvidence | null {
  const metadata = metadataObject(shipment.metadata);
  const phase44d = metadataObject(metadata.phase44d);
  const trials = metadataObject(phase44d.alternatePickupRateRefreshTrials);
  const evidence = metadataObject(trials[pickupLocationId]);
  return Object.keys(evidence).length ? evidence as StoredTrialEvidence : null;
}

function contextFromEvidence(value: unknown): CourierPickupTrialRateContext | null {
  const context = metadataObject(value);
  if (!Object.keys(context).length) return null;
  return {
    candidate_count: numberValue(context.candidate_count) ?? 0,
    eligible_count: numberValue(context.eligible_count) ?? 0,
    pickup_available_count: numberValue(context.pickup_available_count) ?? 0,
    delivery_available_count: numberValue(context.delivery_available_count) ?? 0,
    numeric_courier_id_count: numberValue(context.numeric_courier_id_count) ?? 0
  };
}

function publicOptionsFromEvidence(value: unknown): CourierPickupTrialRateOption[] {
  return arrayValue(value)
    .map((item) => metadataObject(item))
    .map((item) => {
      const code = safeServiceCode(item.public_service_code ?? item.public_service_name);
      return {
        public_service_code: code,
        public_service_name: serviceNameFor(code),
        amount_paise: numberValue(item.amount_paise),
        estimated_delivery_days: numberValue(item.estimated_delivery_days)
      };
    })
    .slice(0, 3);
}

function resultFromEvidence(input: {
  evidence: StoredTrialEvidence;
  providerKey: string;
  shipment: Awaited<ReturnType<typeof getSellerShipment>>;
  pickupLocationId: string;
  pickupPincode: string;
  deliveryPincode: string | null;
}): CourierPickupTrialResult | null {
  const context = contextFromEvidence(input.evidence.rate_context);
  if (!context) return null;
  const status = safeStatus(input.evidence.status) ?? statusFrom(context);
  return {
    trial_id: `pickup_trial_${input.shipment.id}_${input.pickupLocationId}`,
    provider_key: input.providerKey,
    public_network_name: "Shipmastr Courier Network",
    shipment_id: input.shipment.id,
    current_pickup_location_id: input.shipment.pickupLocationId ?? null,
    trial_pickup_location_id: input.pickupLocationId,
    trial_pickup_pincode: input.pickupPincode,
    delivery_pincode: input.deliveryPincode,
    status,
    rate_context: context,
    public_rate_options: publicOptionsFromEvidence(input.evidence.public_rate_options),
    blockers: stringList(input.evidence.blockers).length ? stringList(input.evidence.blockers) : blockersFor(status),
    warnings: stringList(input.evidence.warnings).length
      ? stringList(input.evidence.warnings)
      : ["Result is based on stored safe controlled refresh evidence only."],
    seller_safe_message: stringValue(input.evidence.seller_safe_message) ?? sellerMessage(status),
    admin_next_actions: stringList(input.evidence.admin_next_actions).length
      ? stringList(input.evidence.admin_next_actions)
      : adminNextActions(status)
  };
}

function providerErrorCode(error: unknown) {
  const maybe = error as { code?: unknown; message?: unknown };
  const code = stringValue(maybe?.code) ?? stringValue(maybe?.message) ?? "CONTROLLED_RATE_REFRESH_FAILED";
  return code.replace(/[^A-Z0-9_]/gi, "_").toUpperCase().slice(0, 80) || "CONTROLLED_RATE_REFRESH_FAILED";
}

function liveRatesSource(source?: Record<string, unknown>) {
  return {
    ...env,
    ...(source ?? {})
  };
}

async function controlledRateRefreshAdapter(
  merchantId: string,
  options: RateRefreshOptions,
  client: Db
) {
  if (options.adapter) {
    return {
      adapter: options.adapter,
      liveReady: false,
      mode: "DRY_RUN" as const
    };
  }
  const readiness = await assertLiveCourierRatesAllowed(merchantId, {
    client,
    ...(options.liveRatesSource ? { source: options.liveRatesSource } : {})
  });
  if (!readiness.ready) {
    return {
      adapter: createMockSafeShippingAdapter(),
      liveReady: false,
      mode: readiness.runtime.mode
    };
  }
  const factory = options.liveRatesAdapterFactory ?? createShiprocketLiveAdapter;
  return {
    adapter: factory({
      credentialRef: readiness.shiprocket.credentialRef ?? "",
      source: liveRatesSource(options.liveRatesSource)
    }),
    liveReady: true,
    mode: readiness.runtime.mode
  };
}

function evidenceForResult(input: {
  result: CourierPickupTrialResult;
  refreshedAt: string;
}) {
  return {
    trial_id: input.result.trial_id,
    provider_key: input.result.provider_key,
    trial_pickup_location_id: input.result.trial_pickup_location_id,
    trial_pickup_pincode: input.result.trial_pickup_pincode,
    delivery_pincode: input.result.delivery_pincode,
    status: input.result.status,
    rate_context: input.result.rate_context,
    public_rate_options: input.result.public_rate_options,
    blockers: input.result.blockers,
    warnings: input.result.warnings,
    seller_safe_message: input.result.seller_safe_message,
    admin_next_actions: input.result.admin_next_actions,
    rawProviderResponseStored: false,
    refreshed_at: input.refreshedAt
  };
}

async function storeTrialEvidence(input: {
  client: Db;
  shipment: Awaited<ReturnType<typeof getSellerShipment>>;
  pickupLocationId: string;
  evidence: ReturnType<typeof evidenceForResult>;
}) {
  const existingMetadata = metadataObject(input.shipment.metadata);
  const phase44d = metadataObject(existingMetadata.phase44d);
  const trials = metadataObject(phase44d.alternatePickupRateRefreshTrials);
  await input.client.shipment.update({
    where: { id: input.shipment.id },
    data: {
      metadata: toPrismaJson({
        ...existingMetadata,
        phase44d: {
          ...phase44d,
          latestAlternatePickupRateRefreshTrialId: input.evidence.trial_id,
          alternatePickupRateRefreshTrials: {
            ...trials,
            [input.pickupLocationId]: input.evidence
          }
        }
      })
    }
  });
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
  const pickupPincode = pickup.pincode ?? "";
  const storedEvidence = alternatePickupTrialEvidence(shipment, input.pickupLocationId);
  if (storedEvidence) {
    const result = resultFromEvidence({
      evidence: storedEvidence,
      providerKey: input.providerKey,
      shipment,
      pickupLocationId: input.pickupLocationId,
      pickupPincode,
      deliveryPincode
    });
    if (result) return result;
  }

  const allRates = await shipmentRates(client, merchantId, shipment.id);
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

export async function createControlledCourierPickupRateRefresh(
  merchantId: string,
  input: {
    providerKey: "SHIPROCKET" | string;
    shipmentId: string;
    pickupLocationId: string;
    mode: "CONTROLLED_REFRESH";
  },
  options: RateRefreshOptions = {}
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

  const pickupPincode = pickup.pincode ?? "";
  const deliveryPincode = shipment.toPincode ?? null;
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  let status: CourierPickupTrialStatus = "BLOCKED";
  let context = emptyContext();
  let publicOptions: CourierPickupTrialRateOption[] = [];
  let blockers: string[] = [];
  const warnings: string[] = [
    "Controlled alternate pickup rate refresh stores safe trial evidence only.",
    "Provider responses were not stored in trial evidence."
  ];

  try {
    const { adapter, liveReady, mode } = await controlledRateRefreshAdapter(merchantId, options, client);
    const weight = shipmentWeightForProvider(shipment);
    const providerRates = await adapter.getRates({
      sellerId: merchantId,
      shipmentId: shipment.id,
      providerOrderId: null,
      pickupPincode,
      deliveryPincode: deliveryPincode ?? "",
      paymentMode: shipment.paymentMode,
      collectableAmount: shipment.codAmountPaise / 100,
      deadWeightKg: weight.deadWeightKg,
      dimensions: weight.dimensions
    });
    context = contextFromProviderRates(providerRates);
    status = statusFrom(context);
    publicOptions = publicOptionsFromProviderRates(providerRates);
    blockers = blockersFor(status);
    warnings.push(liveReady && mode === "LIVE"
      ? "Controlled live rates were evaluated for this pilot merchant only."
      : "Controlled refresh ran without live shipping activation.");
  } catch (error) {
    status = "BLOCKED";
    blockers = ["CONTROLLED_RATE_REFRESH_FAILED", providerErrorCode(error)];
    warnings.push("Controlled alternate pickup rate refresh could not complete safely.");
  }

  const result: CourierPickupTrialResult = {
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
    blockers,
    warnings,
    seller_safe_message: sellerMessage(status),
    admin_next_actions: adminNextActions(status)
  };

  await storeTrialEvidence({
    client,
    shipment,
    pickupLocationId: input.pickupLocationId,
    evidence: evidenceForResult({
      result,
      refreshedAt: checkedAt
    })
  });

  return result;
}
