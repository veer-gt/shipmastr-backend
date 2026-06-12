import { ShipmentStatus, type Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import type { InternalCourierProviderAdapter } from "../courierPartners/providers/provider-adapter.types.js";
import { createShiprocketLiveAdapter } from "../courierPartners/providers/shiprocket/shiprocket-live.adapter.js";
import {
  moneyToPaise,
  serializeRate,
  serviceCodeForName,
  toPrismaJson
} from "./shipping-public-serializers.js";
import {
  publicTierSummary,
  selectShippingTiers,
  shippingTierFromServiceCode,
  type ShippingTierCandidate
} from "./shipping-tier-decision.service.js";
import { getReliabilityScoreForRate } from "./shipping-sla-learning.service.js";
import { assertLiveCourierRatesAllowed } from "./shipping-live-rates-gate.service.js";
import {
  createMockSafeShippingAdapter,
  ensureSystemManagedCourierNetwork
} from "./shipping-pickup-location.service.js";
import {
  ensureShipmentIsNotTerminal,
  getSellerShipment,
  shipmentMetadata,
  shipmentWeightForProvider
} from "./shipping-shipments.service.js";

type Db = Prisma.TransactionClient | typeof prisma;
type LiveRatesAdapterFactory = (input: Parameters<typeof createShiprocketLiveAdapter>[0]) => InternalCourierProviderAdapter;
type SafeRateRejectionReason =
  | "PICKUP_UNAVAILABLE"
  | "DELIVERY_UNAVAILABLE"
  | "BLOCKED"
  | "MISSING_COURIER_ID"
  | "MISSING_RATE"
  | "UNSUPPORTED_SERVICE"
  | "UNKNOWN";

export type LiveRateRefreshDiagnostic = {
  status: "RATES_AVAILABLE" | "NO_ELIGIBLE_SHIPPING_RATES" | "PROVIDER_SERVICEABILITY_NO_CANDIDATES";
  selected_pickup_pincode: string | null;
  delivery_pincode: string | null;
  live_provider_checked: boolean;
  live_serviceability_returned_count: number;
  live_rate_candidates_count: number;
  eligible_rate_count: number;
  rejected_rate_reasons: Array<{ safe_reason: SafeRateRejectionReason; count: number }>;
  provider_pickup_available_any: boolean | null;
  provider_delivery_available_any: boolean | null;
  stale_selected_rate_ignored: boolean;
  checked_at: string;
};

type RateOptions = {
  client?: Db;
  adapter?: InternalCourierProviderAdapter;
  refresh?: boolean;
  liveRatesSource?: Record<string, unknown>;
  liveRatesAdapterFactory?: LiveRatesAdapterFactory;
};

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function shipmentProducts(metadata: ReturnType<typeof shipmentMetadata>) {
  return metadata.boxes.flatMap((box) => box.products ?? []).map((product) => ({
    name: product.name,
    sku: product.sku ?? null,
    quantity: product.quantity,
    unitPrice: product.unit_price
  }));
}

function boolMetadata(value: unknown, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
}

function numberMetadata(value: unknown, fallback: number | null = null) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function stringMetadata(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstStringMetadata(...values: unknown[]) {
  for (const value of values) {
    const normalized = stringMetadata(value);
    if (normalized) return normalized;
  }
  return null;
}

function rateBreakupObject(value: unknown) {
  return metadataObject(value);
}

function safeRefreshStatus(value: unknown): LiveRateRefreshDiagnostic["status"] | null {
  if (value === "RATES_AVAILABLE" || value === "NO_ELIGIBLE_SHIPPING_RATES" || value === "PROVIDER_SERVICEABILITY_NO_CANDIDATES") {
    return value;
  }
  return null;
}

function numberField(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function boolField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function rejectionReason(value: unknown): SafeRateRejectionReason {
  const normalized = typeof value === "string" ? value : "";
  if ([
    "PICKUP_UNAVAILABLE",
    "DELIVERY_UNAVAILABLE",
    "BLOCKED",
    "MISSING_COURIER_ID",
    "MISSING_RATE",
    "UNSUPPORTED_SERVICE",
    "UNKNOWN"
  ].includes(normalized)) return normalized as SafeRateRejectionReason;
  return "UNKNOWN";
}

function compactRejectedReasons(reasons: SafeRateRejectionReason[]) {
  const counts = new Map<SafeRateRejectionReason, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()].map(([safe_reason, count]) => ({ safe_reason, count }));
}

function providerRateSafeReason(input: {
  liveShiprocketReady: boolean;
  providerCourierId: string | null;
  totalCharge: number;
  pickupAvailable?: boolean | null | undefined;
  deliveryAvailable?: boolean | null | undefined;
  codSupported?: boolean | null | undefined;
  paymentMode: string;
  publicServiceCode: string;
}): SafeRateRejectionReason | null {
  if (input.liveShiprocketReady && !input.providerCourierId) return "MISSING_COURIER_ID";
  if (!Number.isFinite(input.totalCharge) || input.totalCharge <= 0) return "MISSING_RATE";
  if (!input.publicServiceCode) return "UNSUPPORTED_SERVICE";
  if (input.pickupAvailable === false) return "PICKUP_UNAVAILABLE";
  if (input.deliveryAvailable === false) return "DELIVERY_UNAVAILABLE";
  if (input.paymentMode === "cod" && input.codSupported === false) return "BLOCKED";
  return null;
}

export function sanitizeLiveRateRefreshDiagnostic(value: unknown): LiveRateRefreshDiagnostic | null {
  const metadata = metadataObject(value);
  const status = safeRefreshStatus(metadata.status);
  if (!status) return null;
  const rejected = Array.isArray(metadata.rejected_rate_reasons)
    ? metadata.rejected_rate_reasons
      .map((item) => metadataObject(item))
      .map((item) => ({
        safe_reason: rejectionReason(item.safe_reason),
        count: numberField(item.count)
      }))
      .filter((item) => item.count > 0)
    : [];
  return {
    status,
    selected_pickup_pincode: stringMetadata(metadata.selected_pickup_pincode),
    delivery_pincode: stringMetadata(metadata.delivery_pincode),
    live_provider_checked: metadata.live_provider_checked === true,
    live_serviceability_returned_count: numberField(metadata.live_serviceability_returned_count),
    live_rate_candidates_count: numberField(metadata.live_rate_candidates_count),
    eligible_rate_count: numberField(metadata.eligible_rate_count),
    rejected_rate_reasons: rejected,
    provider_pickup_available_any: boolField(metadata.provider_pickup_available_any),
    provider_delivery_available_any: boolField(metadata.provider_delivery_available_any),
    stale_selected_rate_ignored: metadata.stale_selected_rate_ignored === true,
    checked_at: stringMetadata(metadata.checked_at) ?? new Date(0).toISOString()
  };
}

export function latestRateRefreshDiagnosticFromShipment(shipment: { metadata?: unknown }) {
  const metadata = metadataObject(shipment.metadata);
  const phase6 = metadataObject(metadata.phase6);
  return sanitizeLiveRateRefreshDiagnostic(phase6.latestRateRefresh);
}

function buildRateRefreshDiagnostic(input: {
  shipment: Awaited<ReturnType<typeof getSellerShipment>>;
  liveProviderChecked: boolean;
  providerRatesCount: number;
  candidates: ShippingTierCandidate[];
  rejectedReasons: SafeRateRejectionReason[];
  status?: LiveRateRefreshDiagnostic["status"];
}): LiveRateRefreshDiagnostic {
  const pickupValues = input.candidates.map((candidate) => candidate.pickupAvailable);
  const deliveryValues = input.candidates.map((candidate) => candidate.deliveryAvailable);
  const eligibleCount = input.candidates.filter((candidate) => (
    candidate.pickupAvailable !== false
    && candidate.deliveryAvailable !== false
    && !(input.shipment.paymentMode === "cod" && candidate.codSupported === false)
  )).length;
  return {
    status: input.status ?? (eligibleCount > 0 ? "RATES_AVAILABLE" : "NO_ELIGIBLE_SHIPPING_RATES"),
    selected_pickup_pincode: input.shipment.fromPincode ?? null,
    delivery_pincode: input.shipment.toPincode ?? null,
    live_provider_checked: input.liveProviderChecked,
    live_serviceability_returned_count: input.providerRatesCount,
    live_rate_candidates_count: input.candidates.length,
    eligible_rate_count: eligibleCount,
    rejected_rate_reasons: compactRejectedReasons(input.rejectedReasons),
    provider_pickup_available_any: pickupValues.length ? pickupValues.some((value) => value !== false) : null,
    provider_delivery_available_any: deliveryValues.length ? deliveryValues.some((value) => value !== false) : null,
    stale_selected_rate_ignored: eligibleCount === 0,
    checked_at: new Date().toISOString()
  };
}

function phase6RateMetadata(rateBreakup: unknown) {
  const metadata = rateBreakupObject(rateBreakup);
  const phase6 = metadata.phase6;
  return metadataObject(phase6);
}

function tierCandidateFromRate(rate: {
  id: string;
  publicServiceCode?: string | null;
  publicServiceName?: string | null;
  amountPaise: number;
  currency: string;
  estimatedDeliveryDays?: number | null;
  chargeableWeightKg?: unknown;
  rateBreakup?: unknown;
}): ShippingTierCandidate {
  const metadata = phase6RateMetadata(rate.rateBreakup);
  const candidate: ShippingTierCandidate = {
    id: rate.id,
    amountPaise: rate.amountPaise,
    currency: rate.currency,
    estimatedDeliveryDays: rate.estimatedDeliveryDays ?? null,
    chargeableWeightKg: rate.chargeableWeightKg,
    codSupported: boolMetadata(metadata.codSupported, true),
    pickupAvailable: boolMetadata(metadata.pickupAvailable, true),
    deliveryAvailable: boolMetadata(metadata.deliveryAvailable, true),
    reliabilityScore: numberMetadata(metadata.reliabilityScore, 0.75)
  };

  if (rate.publicServiceName !== undefined) candidate.publicServiceName = rate.publicServiceName;
  return candidate;
}

function liveRatesSource(source?: Record<string, unknown>) {
  return {
    ...env,
    ...(source ?? {})
  };
}

function liveShiprocketRatesAdapter(input: {
  source?: Record<string, unknown>;
  credentialRef?: string | null;
  override?: InternalCourierProviderAdapter;
  factory?: LiveRatesAdapterFactory;
}) {
  if (input.override) return input.override;
  if (!input.credentialRef) throw new HttpError(409, "LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
  const factory = input.factory ?? createShiprocketLiveAdapter;
  return factory({
    credentialRef: input.credentialRef,
    source: liveRatesSource(input.source)
  });
}

function providerErrorCode(error: unknown) {
  const maybe = error as { code?: unknown; message?: unknown };
  if (typeof maybe?.code === "string" && maybe.code.trim()) return maybe.code.trim();
  if (typeof maybe?.message === "string" && maybe.message.trim()) return maybe.message.trim();
  return "COURIER_PROVIDER_RATE_ERROR";
}

function numericProviderCourierId(value: unknown) {
  const normalized = stringMetadata(value);
  return normalized && /^[0-9]+$/.test(normalized) ? normalized : null;
}

function providerRateSafeMetadata(value: unknown) {
  const metadata = metadataObject(value);
  return {
    providerCourierId: firstStringMetadata(metadata.providerCourierId, metadata.courier_id, metadata.courierId),
    providerServiceId: firstStringMetadata(metadata.providerServiceId, metadata.service_id, metadata.serviceId),
    providerRateId: firstStringMetadata(metadata.providerRateId, metadata.rate_id, metadata.rateId),
    providerStatus: firstStringMetadata(metadata.providerStatus, metadata.status)
  };
}

function rateTierResponse(
  shipmentId: string,
  paymentMode: string,
  rates: Array<Parameters<typeof tierCandidateFromRate>[0]>
) {
  let tiers: ReturnType<typeof selectShippingTiers>;
  try {
    tiers = selectShippingTiers(rates.map(tierCandidateFromRate), paymentMode);
  } catch {
    throw new HttpError(409, "NO_ELIGIBLE_SHIPPING_RATES");
  }

  return {
    shipment_id: shipmentId,
    shipmentId,
    status: "rates_available",
    tiers: publicTierSummary(tiers),
    rates: rates.map((rate) => serializeRate({
      id: rate.id,
      publicServiceName: rate.publicServiceName ?? "Shipmastr Smart",
      chargeableWeightKg: rate.chargeableWeightKg,
      amountPaise: rate.amountPaise,
      currency: rate.currency,
      estimatedDeliveryDays: rate.estimatedDeliveryDays ?? null
    }))
  };
}

async function findExistingRates(client: Db, shipmentId: string, sellerId: string) {
  return client.shipmentRate.findMany({
    where: {
      shipmentId,
      sellerId
    },
    orderBy: { createdAt: "desc" }
  });
}

async function recordShipmentRateRefreshDiagnostic(input: {
  client: Db;
  shipment: Awaited<ReturnType<typeof getSellerShipment>>;
  sellerCourierPartnerId?: string | null;
  courierPartnerId?: string | null;
  diagnostic: LiveRateRefreshDiagnostic;
}) {
  const existingMetadata = metadataObject(input.shipment.metadata);
  const existingPhase6 = metadataObject(existingMetadata.phase6);
  await input.client.shipment.update({
    where: { id: input.shipment.id },
    data: {
      ...(input.sellerCourierPartnerId ? { sellerCourierPartnerId: input.sellerCourierPartnerId } : {}),
      ...(input.courierPartnerId ? { courierPartnerId: input.courierPartnerId } : {}),
      metadata: toPrismaJson({
        ...existingMetadata,
        phase6: {
          ...existingPhase6,
          providerStatus: input.diagnostic.status === "RATES_AVAILABLE" ? "rates_available" : "no_eligible_rates",
          ratedAt: input.diagnostic.checked_at,
          latestRateRefresh: input.diagnostic,
          providerResponseJson: {
            rateCount: input.diagnostic.live_serviceability_returned_count
          }
        }
      })
    }
  });
}

async function ensurePickupProviderMapping(input: {
  sellerId: string;
  shipment: Awaited<ReturnType<typeof getSellerShipment>>;
  courierPartnerId: string;
  sellerCourierPartnerId: string;
  client: Db;
  adapter: InternalCourierProviderAdapter;
}) {
  if (!input.shipment.pickupLocationId) {
    throw new HttpError(409, "SHIPMENT_PICKUP_LOCATION_MISSING");
  }

  const existing = await input.client.pickupLocationProviderMapping.findUnique({
    where: {
      pickupLocationId_courierPartnerId: {
        pickupLocationId: input.shipment.pickupLocationId,
        courierPartnerId: input.courierPartnerId
      }
    }
  });

  if (existing?.providerPickupId) return existing;

  const pickupLocation = await input.client.pickupLocation.findFirst({
    where: {
      id: input.shipment.pickupLocationId,
      sellerId: input.sellerId
    }
  });

  if (!pickupLocation) {
    throw new HttpError(404, "PICKUP_LOCATION_NOT_FOUND");
  }

  const providerPickup = await input.adapter.createPickupLocation({
    sellerId: input.sellerId,
    pickupLocationId: pickupLocation.id,
    name: pickupLocation.label,
    contactPerson: pickupLocation.contactName ?? pickupLocation.label,
    phone: pickupLocation.phone ?? "0000000000",
    addressLine1: pickupLocation.addressLine1 ?? "",
    addressLine2: pickupLocation.addressLine2 ?? null,
    city: pickupLocation.city ?? "",
    state: pickupLocation.state ?? "",
    country: pickupLocation.country,
    pincode: pickupLocation.pincode ?? "",
    email: null,
    landmark: null,
    latitude: null,
    longitude: null
  });

  return input.client.pickupLocationProviderMapping.upsert({
    where: {
      pickupLocationId_courierPartnerId: {
        pickupLocationId: pickupLocation.id,
        courierPartnerId: input.courierPartnerId
      }
    },
    create: {
      pickupLocationId: pickupLocation.id,
      sellerCourierPartnerId: input.sellerCourierPartnerId,
      courierPartnerId: input.courierPartnerId,
      providerPickupId: providerPickup.providerPickupId,
      status: providerPickup.status,
      metadata: toPrismaJson({
        message: providerPickup.message,
        result: providerPickup.providerMetadata
      })
    },
    update: {
      sellerCourierPartnerId: input.sellerCourierPartnerId,
      providerPickupId: providerPickup.providerPickupId,
      status: providerPickup.status,
      metadata: toPrismaJson({
        message: providerPickup.message,
        result: providerPickup.providerMetadata
      })
    }
  });
}

async function ensureShipmentProviderRef(input: {
  sellerId: string;
  shipment: Awaited<ReturnType<typeof getSellerShipment>>;
  courierPartnerId: string;
  pickupProviderId: string;
  client: Db;
  adapter: InternalCourierProviderAdapter;
}) {
  const existing = await input.client.shipmentProviderRef.findFirst({
    where: {
      shipmentId: input.shipment.id,
      courierPartnerId: input.courierPartnerId
    },
    orderBy: { createdAt: "desc" }
  });

  if (existing?.providerOrderId) return existing;

  const metadata = shipmentMetadata(input.shipment.metadata);
  const weight = shipmentWeightForProvider(input.shipment);
  const draft = await input.adapter.createDraftOrder({
    sellerId: input.sellerId,
    shipmentId: input.shipment.id,
    sellerOrderId: input.shipment.externalOrderId ?? input.shipment.id,
    segment: input.shipment.segment,
    paymentMode: input.shipment.paymentMode,
    pickupLocationProviderId: input.pickupProviderId,
    returnLocationProviderId: input.pickupProviderId,
    invoiceNumber: metadata.invoice.invoice_number ?? null,
    invoiceAmount: metadata.invoice.invoice_amount,
    collectableAmount: metadata.invoice.collectable_amount ?? null,
    deadWeightKg: weight.deadWeightKg,
    dimensions: weight.dimensions,
    buyer: {
      name: metadata.buyer.name,
      phone: metadata.buyer.phone,
      email: metadata.buyer.email ?? null,
      addressLine1: metadata.buyer.address.line1,
      addressLine2: metadata.buyer.address.line2 ?? null,
      landmark: metadata.buyer.address.landmark ?? null,
      city: metadata.buyer.address.city,
      state: metadata.buyer.address.state,
      country: metadata.buyer.address.country.toUpperCase(),
      pincode: metadata.buyer.address.pincode
    },
    products: shipmentProducts(metadata)
  });

  if (existing) {
    return input.client.shipmentProviderRef.update({
      where: { id: existing.id },
      data: {
        providerShipmentId: draft.providerOrderId,
        providerOrderId: draft.providerOrderId,
        metadata: toPrismaJson({
          reference: draft.providerReferenceNumber,
          status: draft.status,
          result: draft.providerMetadata
        })
      }
    });
  }

  return input.client.shipmentProviderRef.create({
    data: {
      shipmentId: input.shipment.id,
      courierPartnerId: input.courierPartnerId,
      providerShipmentId: draft.providerOrderId,
      providerOrderId: draft.providerOrderId,
      providerPickupId: input.pickupProviderId,
      metadata: toPrismaJson({
        reference: draft.providerReferenceNumber,
        status: draft.status,
        result: draft.providerMetadata
      })
    }
  });
}

export async function fetchShipmentRates(
  sellerId: string,
  shipmentId: string,
  options: RateOptions = {}
) {
  const client = options.client ?? prisma;
  const adapter = options.adapter ?? createMockSafeShippingAdapter();
  const shipment = await getSellerShipment(sellerId, shipmentId, client);
  ensureShipmentIsNotTerminal(shipment.status);
  const liveRatesReadiness = await assertLiveCourierRatesAllowed(sellerId, {
    client,
    ...(options.liveRatesSource ? { source: options.liveRatesSource } : {})
  });
  const liveShiprocketReady = liveRatesReadiness.ready;
  const activeAdapter = liveShiprocketReady
    ? liveShiprocketRatesAdapter({
      ...(options.liveRatesSource ? { source: options.liveRatesSource } : {}),
      ...(liveRatesReadiness.shiprocket.credentialRef ? { credentialRef: liveRatesReadiness.shiprocket.credentialRef } : {}),
      ...(options.adapter ? { override: options.adapter } : {}),
      ...(options.liveRatesAdapterFactory ? { factory: options.liveRatesAdapterFactory } : {})
    })
    : adapter;

  if (!options.refresh) {
    const existingRates = await findExistingRates(client, shipment.id, sellerId);
    if (existingRates.length) {
      return rateTierResponse(shipment.id, shipment.paymentMode, existingRates);
    }
  }

  const { partner, mapping } = await ensureSystemManagedCourierNetwork(sellerId, client);
  let providerOrderId: string | null = null;
  if (!liveShiprocketReady) {
    const pickupMapping = await ensurePickupProviderMapping({
      sellerId,
      shipment,
      courierPartnerId: partner.id,
      sellerCourierPartnerId: mapping.id,
      client,
      adapter
    });

    if (!pickupMapping.providerPickupId) {
      throw new HttpError(409, "PICKUP_PROVIDER_MAPPING_MISSING");
    }

    const providerRef = await ensureShipmentProviderRef({
      sellerId,
      shipment,
      courierPartnerId: partner.id,
      pickupProviderId: pickupMapping.providerPickupId,
      client,
      adapter
    });
    providerOrderId = providerRef.providerOrderId;
  }
  const weight = shipmentWeightForProvider(shipment);

  let providerRates;
  try {
    providerRates = await activeAdapter.getRates({
      sellerId,
      shipmentId: shipment.id,
      providerOrderId,
      pickupPincode: shipment.fromPincode ?? "",
      deliveryPincode: shipment.toPincode ?? "",
      paymentMode: shipment.paymentMode,
      collectableAmount: shipment.codAmountPaise / 100,
      deadWeightKg: weight.deadWeightKg,
      dimensions: weight.dimensions
    });
  } catch (error) {
    const code = providerErrorCode(error);
    throw new HttpError(
      ["SHIPROCKET_LIVE_RATE_PROVIDER_ID_MISSING", "LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED"].includes(code) ? 409 : 502,
      code
    );
  }

  const rates = [];
  const tierCandidates: ShippingTierCandidate[] = [];
  const rejectedReasons: SafeRateRejectionReason[] = [];
  for (const providerRate of providerRates) {
    const providerMetadata = providerRateSafeMetadata(providerRate.providerMetadata);
    const providerCourierId = numericProviderCourierId(providerRate.providerCourierId ?? providerMetadata.providerCourierId);
    const publicServiceCode = serviceCodeForName(providerRate.serviceLevel);
    const rejection = providerRateSafeReason({
      liveShiprocketReady,
      providerCourierId,
      totalCharge: providerRate.totalCharge,
      pickupAvailable: providerRate.pickupAvailable,
      deliveryAvailable: providerRate.deliveryAvailable,
      codSupported: providerRate.codSupported,
      paymentMode: shipment.paymentMode,
      publicServiceCode
    });
    if (rejection) {
      rejectedReasons.push(rejection);
      if (rejection === "MISSING_COURIER_ID") continue;
    }
    const selectedTier = shippingTierFromServiceCode(publicServiceCode);
    const reliabilityScore = await getReliabilityScoreForRate({
      provider: activeAdapter.code,
      courierCode: providerCourierId ?? providerRate.providerCourierId ?? null,
      deliveryPincode: shipment.toPincode ?? null,
      selectedTier
    }, client);

    const rate = await client.shipmentRate.create({
      data: {
        shipmentId: shipment.id,
        sellerId,
        sellerCourierPartnerId: mapping.id,
        courierPartnerId: partner.id,
        publicServiceCode,
        publicServiceName: providerRate.serviceLevel,
        segment: shipment.segment,
        chargeableWeightKg: providerRate.chargedWeightKg,
        amountPaise: moneyToPaise(providerRate.totalCharge),
        currency: providerRate.currency,
        estimatedDeliveryDays: providerRate.tatDays,
        rateBreakup: toPrismaJson({
          internalRateId: providerRate.rateId,
          internalCourierId: providerCourierId ?? providerRate.providerCourierId ?? null,
          providerCourierId,
          providerServiceId: providerMetadata.providerServiceId,
          providerRateId: providerMetadata.providerRateId ?? providerRate.rateId,
          result: providerRate.providerMetadata,
          phase6: {
            tier: selectedTier,
            codSupported: providerRate.codSupported ?? true,
            pickupAvailable: providerRate.pickupAvailable ?? true,
            deliveryAvailable: providerRate.deliveryAvailable ?? true,
            reliabilityScore,
            providerCourierId,
            providerServiceId: providerMetadata.providerServiceId,
            providerRateId: providerMetadata.providerRateId ?? providerRate.rateId,
            providerResponseJson: providerRate.providerMetadata,
            livePilotRatesMode: liveRatesReadiness.runtime.mode,
            livePilotRatesReady: liveRatesReadiness.ready
          }
        })
      }
    });
    rates.push(rate);
    tierCandidates.push(tierCandidateFromRate(rate));
  }

  const diagnosticInput = {
    shipment,
    liveProviderChecked: liveShiprocketReady,
    providerRatesCount: providerRates.length,
    candidates: tierCandidates,
    rejectedReasons,
    ...(providerRates.length === 0 ? { status: "PROVIDER_SERVICEABILITY_NO_CANDIDATES" as const } : {})
  };
  let diagnostic = buildRateRefreshDiagnostic(diagnosticInput);

  if (!rates.length) {
    await recordShipmentRateRefreshDiagnostic({
      client,
      shipment,
      sellerCourierPartnerId: mapping.id,
      courierPartnerId: partner.id,
      diagnostic
    });
    throw new HttpError(409, "NO_ELIGIBLE_SHIPPING_RATES");
  }

  try {
    selectShippingTiers(tierCandidates, shipment.paymentMode);
  } catch {
    diagnostic = {
      ...diagnostic,
      status: "NO_ELIGIBLE_SHIPPING_RATES",
      eligible_rate_count: 0,
      stale_selected_rate_ignored: true
    };
    await recordShipmentRateRefreshDiagnostic({
      client,
      shipment,
      sellerCourierPartnerId: mapping.id,
      courierPartnerId: partner.id,
      diagnostic
    });
    throw new HttpError(409, "NO_ELIGIBLE_SHIPPING_RATES");
  }

  const existingMetadata = metadataObject(shipment.metadata);
  const existingPhase6 = metadataObject(existingMetadata.phase6);

  if (shipment.status === ShipmentStatus.draft) {
    await client.shipment.update({
      where: { id: shipment.id },
      data: {
        status: ShipmentStatus.rates_fetched,
        sellerCourierPartnerId: mapping.id,
        courierPartnerId: partner.id,
        metadata: toPrismaJson({
          ...existingMetadata,
          phase6: {
            ...existingPhase6,
            providerStatus: "rates_available",
            ratedAt: new Date().toISOString(),
            providerResponseJson: {
              rateCount: providerRates.length
            },
            latestRateRefresh: diagnostic,
            livePilotRatesMode: liveRatesReadiness.runtime.mode,
            livePilotRatesReady: liveRatesReadiness.ready
          }
        })
      }
    });
  } else {
    await client.shipment.update({
      where: { id: shipment.id },
      data: {
        sellerCourierPartnerId: mapping.id,
        courierPartnerId: partner.id,
        metadata: toPrismaJson({
          ...existingMetadata,
          phase6: {
            ...existingPhase6,
            providerStatus: "rates_available",
            ratedAt: new Date().toISOString(),
            providerResponseJson: {
              rateCount: providerRates.length
            },
            latestRateRefresh: diagnostic,
            livePilotRatesMode: liveRatesReadiness.runtime.mode,
            livePilotRatesReady: liveRatesReadiness.ready
          }
        })
      }
    });
  }

  return rateTierResponse(shipment.id, shipment.paymentMode, rates);
}
