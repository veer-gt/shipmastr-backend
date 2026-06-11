import { ShipmentStatus, type Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import type { InternalCourierProviderAdapter } from "../courierPartners/providers/provider-adapter.types.js";
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

type RateOptions = {
  client?: Db;
  adapter?: InternalCourierProviderAdapter;
  refresh?: boolean;
  liveRatesSource?: Record<string, unknown>;
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

function rateBreakupObject(value: unknown) {
  return metadataObject(value);
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

  if (!options.refresh) {
    const existingRates = await findExistingRates(client, shipment.id, sellerId);
    if (existingRates.length) {
      return rateTierResponse(shipment.id, shipment.paymentMode, existingRates);
    }
  }

  const { partner, mapping } = await ensureSystemManagedCourierNetwork(sellerId, client);
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
  const weight = shipmentWeightForProvider(shipment);

  const providerRates = await adapter.getRates({
    sellerId,
    shipmentId: shipment.id,
    providerOrderId: providerRef.providerOrderId,
    pickupPincode: shipment.fromPincode ?? "",
    deliveryPincode: shipment.toPincode ?? "",
    paymentMode: shipment.paymentMode,
    collectableAmount: shipment.codAmountPaise / 100,
    deadWeightKg: weight.deadWeightKg,
    dimensions: weight.dimensions
  });

  const rates = [];
  for (const providerRate of providerRates) {
    const publicServiceCode = serviceCodeForName(providerRate.serviceLevel);
    const selectedTier = shippingTierFromServiceCode(publicServiceCode);
    const reliabilityScore = await getReliabilityScoreForRate({
      provider: adapter.code,
      courierCode: providerRate.providerCourierId ?? null,
      deliveryPincode: shipment.toPincode ?? null,
      selectedTier
    }, client);

    rates.push(await client.shipmentRate.create({
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
          internalCourierId: providerRate.providerCourierId ?? null,
          result: providerRate.providerMetadata,
          phase6: {
            tier: selectedTier,
            codSupported: providerRate.codSupported ?? true,
            pickupAvailable: providerRate.pickupAvailable ?? true,
            deliveryAvailable: providerRate.deliveryAvailable ?? true,
            reliabilityScore,
            providerResponseJson: providerRate.providerMetadata,
            livePilotRatesMode: liveRatesReadiness.runtime.mode,
            livePilotRatesReady: liveRatesReadiness.ready
          }
        })
      }
    }));
  }

  if (!rates.length) {
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
            livePilotRatesMode: liveRatesReadiness.runtime.mode,
            livePilotRatesReady: liveRatesReadiness.ready
          }
        })
      }
    });
  }

  return rateTierResponse(shipment.id, shipment.paymentMode, rates);
}
