import { ShipmentStatus, type Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import type { InternalCourierProviderAdapter } from "../courierPartners/providers/provider-adapter.types.js";
import { createShiprocketLiveAdapter } from "../courierPartners/providers/shiprocket/shiprocket-live.adapter.js";
import type { ShiprocketLiveCredentials } from "../courierPartners/providers/shiprocket/shiprocket-live-credentials.js";
import { createMockSafeShippingAdapter } from "./shipping-pickup-location.service.js";
import {
  PUBLIC_COURIER_NETWORK,
  serviceCodeForName,
  toPrismaJson,
  trackingPublicUrlForShipment,
  trackingUrlForAwb
} from "./shipping-public-serializers.js";
import { ensureShipmentTrackingToken } from "./shipping-tracking-token.js";
import { fetchShipmentRates } from "./shipping-rates.service.js";
import { assertLiveAwbLabelAllowed } from "./shipping-live-ship-gate.service.js";
import { recordSlaEvent } from "./shipping-sla-learning.service.js";
import {
  publicTierSummary,
  selectShippingTiers,
  type ShippingTier,
  type ShippingTierCandidate
} from "./shipping-tier-decision.service.js";
import {
  ensureShipmentIsNotTerminal,
  getSellerShipment,
  shipmentMetadata,
  shipmentWeightForProvider
} from "./shipping-shipments.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

type ShipNowOptions = {
  client?: Db;
  adapter?: InternalCourierProviderAdapter;
  liveAwbLabelSource?: Record<string, unknown>;
  shiprocketPickupClient?: {
    login(credentials: ShiprocketLiveCredentials): Promise<{ token?: string; expires_in?: number; expiresIn?: number }>;
    listPickupLocations(token: string): Promise<Record<string, unknown>>;
  };
};

type ProviderRefForLabel = {
  providerOrderId?: string | null;
  providerShipmentId?: string | null;
} | null;

type ShipmentForPublicResponse = {
  id: string;
  awbNumber?: string | null;
  trackingUrl?: string | null;
  trackingToken?: string | null;
  trackingPublicUrl?: string | null;
  serviceLevel?: string | null;
  metadata?: unknown;
};

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function phase6Metadata(value: unknown) {
  const metadata = metadataObject(value);
  return metadataObject(metadata.phase6);
}

function stringMetadata(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberMetadata(value: unknown, fallback: number | null = null) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function boolMetadata(value: unknown, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
}

function publicAwb(shipmentId: string, fallback: string | null | undefined) {
  if (fallback?.startsWith("SM")) return fallback;
  const suffix = shipmentId.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  return `SM${suffix || "SHIPMENT"}`;
}

function publicShipNowResponse(input: {
  shipment: ShipmentForPublicResponse;
  tier: ShippingTier;
  serviceLevel: string | null;
  labelUrl?: string | null;
  trackingUrl?: string | null;
  status?: "label_generated" | "awb_assigned";
}) {
  const awbNumber = input.shipment.awbNumber ?? null;
  const labelUrl = input.labelUrl ?? stringMetadata(phase6Metadata(input.shipment.metadata).labelUrl);
  const trackingPublicUrl = trackingPublicUrlForShipment(input.shipment);
  const trackingUrl = trackingPublicUrl ?? input.trackingUrl ?? input.shipment.trackingUrl ?? trackingUrlForAwb(awbNumber);

  return {
    shipmentId: input.shipment.id,
    shipment_id: input.shipment.id,
    status: input.status ?? (labelUrl ? "label_generated" : "awb_assigned"),
    tier: input.tier,
    serviceLevel: input.serviceLevel,
    courierNetwork: PUBLIC_COURIER_NETWORK,
    awbNumber,
    labelUrl,
    trackingUrl,
    trackingPublicUrl,
    message: labelUrl ? "Shipment created successfully" : "Shipment AWB generated. Label is pending."
  };
}

function selectedCourierId(rateBreakup: unknown) {
  const metadata = metadataObject(rateBreakup);
  const value = metadata.internalCourierId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstStringMetadata(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function liveShiprocketCourierId(rateBreakup: unknown) {
  const metadata = metadataObject(rateBreakup);
  const phase6 = metadataObject(metadata.phase6);
  const result = metadataObject(metadata.result);
  const value = firstStringMetadata(
    metadata.shiprocketCourierId,
    metadata.providerCourierId,
    metadata.courier_id,
    metadata.courierId,
    metadata.internalCourierId,
    phase6.shiprocketCourierId,
    phase6.providerCourierId,
    phase6.courier_id,
    phase6.courierId,
    result.courier_id,
    result.courierId,
    result.providerCourierId
  );
  return value && /^[0-9]+$/.test(value) ? value : null;
}

function strictBoolMetadata(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function liveShiprocketRateEligibility(rateBreakup: unknown) {
  const metadata = metadataObject(rateBreakup);
  const phase6 = metadataObject(metadata.phase6);
  const liveMode = firstStringMetadata(phase6.livePilotRatesMode, metadata.livePilotRatesMode);
  const liveReady = phase6.livePilotRatesReady === true || metadata.livePilotRatesReady === true;
  return {
    liveMode: liveMode === "LIVE",
    liveReady,
    pickupAvailable: strictBoolMetadata(phase6.pickupAvailable),
    providerCourierId: liveShiprocketCourierId(rateBreakup)
  };
}

function assertLiveShiprocketRateEligible(rateBreakup: unknown) {
  const eligibility = liveShiprocketRateEligibility(rateBreakup);
  if (!eligibility.liveMode || !eligibility.liveReady || !eligibility.providerCourierId) {
    throw new HttpError(409, "SHIPROCKET_LIVE_RATE_PROVIDER_ID_MISSING");
  }
  if (eligibility.pickupAvailable !== true) {
    throw new HttpError(409, "SHIPROCKET_LIVE_PICKUP_UNAVAILABLE");
  }
  return eligibility;
}

function shipmentProducts(metadata: ReturnType<typeof shipmentMetadata>) {
  return metadata.boxes.flatMap((box) => box.products ?? []).map((product) => ({
    name: product.name,
    sku: product.sku ?? null,
    quantity: product.quantity,
    unitPrice: product.unit_price
  }));
}

function liveAwbSource(source?: Record<string, unknown>) {
  return source ?? {};
}

function liveShiprocketAdapter(input: {
  source?: Record<string, unknown>;
  credentialRef?: string | null;
  override?: InternalCourierProviderAdapter;
}) {
  if (input.override) return input.override;
  if (!input.credentialRef) throw new HttpError(409, "LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
  return createShiprocketLiveAdapter({
    credentialRef: input.credentialRef,
    source: liveAwbSource(input.source)
  });
}

function providerErrorJson(error: unknown) {
  const maybe = error as { code?: unknown; retryable?: unknown; statusCode?: unknown };
  const result: Record<string, unknown> = {
    code: typeof maybe?.code === "string" ? maybe.code : "COURIER_PROVIDER_ERROR",
    message: "Courier provider request failed.",
    retryable: typeof maybe?.retryable === "boolean" ? maybe.retryable : true
  };

  if (typeof maybe?.statusCode === "number") result.statusCode = maybe.statusCode;
  return result;
}

function rateCandidate(rate: {
  id: string;
  amountPaise: number;
  currency: string;
  estimatedDeliveryDays?: number | null;
  chargeableWeightKg?: unknown;
  rateBreakup?: unknown;
}): ShippingTierCandidate {
  const metadata = metadataObject(metadataObject(rate.rateBreakup).phase6);

  return {
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
}

function serviceCodeForTier(tier: ShippingTier) {
  return tier === "economy"
    ? "shipmastr_economy"
    : tier === "express"
      ? "shipmastr_express"
      : "shipmastr_smart";
}

function isRateForTier(rate: { publicServiceCode?: string | null; publicServiceName?: string | null }, tier: ShippingTier) {
  return rate.publicServiceCode === serviceCodeForTier(tier)
    || serviceCodeForName(rate.publicServiceName ?? "") === serviceCodeForTier(tier);
}

async function recordShipmentSlaEvent(input: {
  client: Db;
  adapter: InternalCourierProviderAdapter;
  sellerId: string;
  shipment: Awaited<ReturnType<typeof getSellerShipment>>;
  tier: ShippingTier;
  serviceType?: string | null;
  eventType: "awb_assigned" | "label_generated" | "failed";
  courierCode?: string | null;
}) {
  await recordSlaEvent({
    merchantId: input.sellerId,
    shipmentId: input.shipment.id,
    orderId: input.shipment.orderId ?? null,
    provider: input.adapter.code,
    courierCode: input.courierCode ?? null,
    courierName: null,
    serviceType: input.serviceType ?? null,
    selectedTier: input.tier,
    pickupPincode: input.shipment.fromPincode ?? null,
    deliveryPincode: input.shipment.toPincode ?? null,
    eventType: input.eventType,
    metadata: { source: "ship_now" }
  }, input.client);
}

async function findRates(client: Db, shipmentId: string, sellerId: string) {
  return client.shipmentRate.findMany({
    where: {
      shipmentId,
      sellerId
    },
    orderBy: { createdAt: "desc" }
  });
}

async function storeProviderError(input: {
  client: Db;
  shipment: Awaited<ReturnType<typeof getSellerShipment>>;
  error: unknown;
  providerStatus?: string;
}) {
  const metadata = metadataObject(input.shipment.metadata);
  const phase6 = phase6Metadata(input.shipment.metadata);

  await input.client.shipment.update({
    where: { id: input.shipment.id },
    data: {
      metadata: toPrismaJson({
        ...metadata,
        phase6: {
          ...phase6,
          providerStatus: input.providerStatus ?? "provider_failed",
          providerErrorJson: providerErrorJson(input.error)
        }
      })
    }
  });
}

async function tryFetchLabel(input: {
  client: Db;
  adapter: InternalCourierProviderAdapter;
  sellerId: string;
  shipment: Awaited<ReturnType<typeof getSellerShipment>>;
  providerRef: ProviderRefForLabel;
  tier: ShippingTier;
  serviceLevel: string | null;
}) {
  const awb = input.shipment.awbNumber;
  if (!awb) {
    return publicShipNowResponse({
      shipment: input.shipment,
      tier: input.tier,
      serviceLevel: input.serviceLevel,
      status: "awb_assigned"
    });
  }

  try {
    const label = await input.adapter.getLabel({
      sellerId: input.sellerId,
      shipmentId: input.shipment.id,
      awb,
      trackingNumber: awb,
      providerOrderId: input.providerRef?.providerOrderId ?? null,
      providerShipmentId: input.providerRef?.providerShipmentId ?? null
    });
    const metadata = metadataObject(input.shipment.metadata);
    const phase6 = phase6Metadata(input.shipment.metadata);
    const trackingUrl = label.trackingUrl ?? input.shipment.trackingUrl ?? trackingUrlForAwb(awb);

    const updated = await input.client.shipment.update({
      where: { id: input.shipment.id },
      data: {
        trackingUrl,
        metadata: toPrismaJson({
          ...metadata,
          phase6: {
            ...phase6,
            selectedTier: input.tier,
            labelUrl: label.labelUrl,
            trackingUrl,
            providerStatus: label.labelUrl ? "label_generated" : "awb_assigned",
            labelGeneratedAt: label.labelUrl ? new Date().toISOString() : null,
            providerResponseJson: {
              ...metadataObject(phase6.providerResponseJson),
              label: label.providerMetadata
            }
          }
        })
      }
    });
    const tracked = await ensureShipmentTrackingToken(updated, input.client);
    if (label.labelUrl) {
      await recordShipmentSlaEvent({
        client: input.client,
        adapter: input.adapter,
        sellerId: input.sellerId,
        shipment: tracked,
        tier: input.tier,
        serviceType: input.serviceLevel,
        eventType: "label_generated"
      });
    }

    return publicShipNowResponse({
      shipment: tracked,
      tier: input.tier,
      serviceLevel: input.serviceLevel,
      labelUrl: label.labelUrl,
      trackingUrl: tracked.trackingPublicUrl ?? trackingUrl,
      status: label.labelUrl ? "label_generated" : "awb_assigned"
    });
  } catch (error) {
    await storeProviderError({
      client: input.client,
      shipment: input.shipment,
      error,
      providerStatus: "awb_assigned"
    });
    const tracked = await ensureShipmentTrackingToken(input.shipment, input.client);
    return publicShipNowResponse({
      shipment: tracked,
      tier: input.tier,
      serviceLevel: input.serviceLevel,
      status: "awb_assigned"
    });
  }
}

async function ensureLiveShiprocketProviderRef(input: {
  client: Db;
  adapter: InternalCourierProviderAdapter;
  sellerId: string;
  shipment: Awaited<ReturnType<typeof getSellerShipment>>;
  courierPartnerId: string | null;
  existingProviderRef: ProviderRefForLabel & { id?: string | null; providerPickupId?: string | null; metadata?: unknown } | null;
}) {
  const existingOrderId = stringMetadata(input.existingProviderRef?.providerOrderId);
  if (existingOrderId && /^[0-9]+$/.test(existingOrderId)) return input.existingProviderRef!;
  if (!input.courierPartnerId) throw new HttpError(409, "SHIPROCKET_LIVE_AWB_ADAPTER_INCOMPLETE");
  if (!input.shipment.pickupLocationId) throw new HttpError(409, "SHIPMENT_PICKUP_LOCATION_MISSING");

  const pickupLocation = await input.client.pickupLocation.findFirst({
    where: {
      id: input.shipment.pickupLocationId,
      sellerId: input.sellerId
    }
  });
  if (!pickupLocation) throw new HttpError(404, "PICKUP_LOCATION_NOT_FOUND");

  const pickupMapping = await input.client.pickupLocationProviderMapping.findUnique({
    where: {
      pickupLocationId_courierPartnerId: {
        pickupLocationId: pickupLocation.id,
        courierPartnerId: input.courierPartnerId
      }
    }
  });
  const pickupLocationProviderId = stringMetadata(pickupMapping?.providerPickupId)
    ?? stringMetadata(pickupLocation.label)
    ?? pickupLocation.id;
  const metadata = shipmentMetadata(input.shipment.metadata);
  const weight = shipmentWeightForProvider(input.shipment);
  const draft = await input.adapter.createDraftOrder({
    sellerId: input.sellerId,
    shipmentId: input.shipment.id,
    sellerOrderId: input.shipment.externalOrderId ?? input.shipment.id,
    segment: input.shipment.segment,
    paymentMode: input.shipment.paymentMode,
    pickupLocationProviderId,
    returnLocationProviderId: pickupLocationProviderId,
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

  const safeMetadata = toPrismaJson({
    phase41b: {
      status: draft.status,
      reference: draft.providerReferenceNumber,
      liveProviderBridge: true,
      rawProviderResponseStored: false
    }
  });

  if (input.existingProviderRef?.id) {
    return input.client.shipmentProviderRef.update({
      where: { id: input.existingProviderRef.id },
      data: {
        courierPartnerId: input.courierPartnerId,
        providerShipmentId: draft.providerOrderId,
        providerOrderId: draft.providerOrderId,
        providerPickupId: pickupLocationProviderId,
        metadata: safeMetadata
      }
    });
  }

  return input.client.shipmentProviderRef.create({
    data: {
      shipmentId: input.shipment.id,
      courierPartnerId: input.courierPartnerId,
      providerShipmentId: draft.providerOrderId,
      providerOrderId: draft.providerOrderId,
      providerPickupId: pickupLocationProviderId,
      metadata: safeMetadata
    }
  });
}

export async function shipNowShipment(
  sellerId: string,
  shipmentId: string,
  tier: ShippingTier,
  options: ShipNowOptions = {}
) {
  const client = options.client ?? prisma;
  const adapter = options.adapter ?? createMockSafeShippingAdapter();
  const shipment = await getSellerShipment(sellerId, shipmentId, client);
  ensureShipmentIsNotTerminal(shipment.status);
  const existingPhase6 = phase6Metadata(shipment.metadata);
  const existingLabelUrl = stringMetadata(existingPhase6.labelUrl);
  if (shipment.awbNumber && existingLabelUrl) {
    const existingTier = stringMetadata(existingPhase6.selectedTier) as ShippingTier | null;
    const tracked = await ensureShipmentTrackingToken(shipment, client);
    return publicShipNowResponse({
      shipment: tracked,
      tier: existingTier ?? tier,
      serviceLevel: shipment.serviceLevel ?? null,
      labelUrl: existingLabelUrl,
      trackingUrl: tracked.trackingPublicUrl ?? stringMetadata(existingPhase6.trackingUrl) ?? shipment.trackingUrl
    });
  }

  const liveAwbLabelReadiness = await assertLiveAwbLabelAllowed(sellerId, {
    client,
    shipmentId: shipment.id,
    includePickupAlignment: true,
    ...(options.liveAwbLabelSource ? { source: options.liveAwbLabelSource } : {}),
    ...(options.shiprocketPickupClient ? { shiprocketPickupClient: options.shiprocketPickupClient } : {})
  });

  let rates = await findRates(client, shipment.id, sellerId);
  const liveShiprocketReady = liveAwbLabelReadiness.ready;
  if (!rates.length && liveShiprocketReady) {
    throw new HttpError(409, "SHIPMENT_RATE_NOT_FOUND");
  }
  if (!rates.length) {
    await fetchShipmentRates(sellerId, shipment.id, { client, adapter });
    rates = await findRates(client, shipment.id, sellerId);
  }

  if (liveShiprocketReady) {
    const liveRateForRequestedTier = rates.find((rate) => isRateForTier(rate, tier));
    if (!liveRateForRequestedTier) {
      throw new HttpError(409, "SHIPMENT_RATE_NOT_FOUND");
    }
    assertLiveShiprocketRateEligible(liveRateForRequestedTier.rateBreakup);
  }

  const tiers = selectShippingTiers(rates.map(rateCandidate), shipment.paymentMode);
  const selectedTier = tiers[tier];
  const selectedRate = rates.find((rate) => rate.id === selectedTier.rateId);

  if (!selectedRate) {
    throw new HttpError(409, "SHIPMENT_RATE_NOT_FOUND");
  }

  const activeAdapter = liveShiprocketReady
    ? liveShiprocketAdapter({
      ...(options.liveAwbLabelSource ? { source: options.liveAwbLabelSource } : {}),
      ...(liveAwbLabelReadiness.shiprocket.credentialRef ? { credentialRef: liveAwbLabelReadiness.shiprocket.credentialRef } : {}),
      ...(options.adapter ? { override: options.adapter } : {})
    })
    : adapter;
  const existingProviderRef = await client.shipmentProviderRef.findFirst({
    where: {
      shipmentId: shipment.id,
      courierPartnerId: selectedRate.courierPartnerId
    },
    orderBy: { createdAt: "desc" }
  });

  const providerRef = liveShiprocketReady
    ? await ensureLiveShiprocketProviderRef({
      client,
      adapter: activeAdapter,
      sellerId,
      shipment,
      courierPartnerId: selectedRate.courierPartnerId,
      existingProviderRef
    })
    : existingProviderRef;

  if (!providerRef?.providerOrderId) {
    throw new HttpError(409, "SHIPMENT_PROVIDER_DRAFT_MISSING");
  }

  if (shipment.awbNumber) {
    return tryFetchLabel({
      client,
      adapter: activeAdapter,
      sellerId,
      shipment,
      providerRef,
      tier,
      serviceLevel: selectedRate.publicServiceName
    });
  }

  const internalCourierId = liveShiprocketReady
    ? liveShiprocketCourierId(selectedRate.rateBreakup)
    : selectedCourierId(selectedRate.rateBreakup);
  if (!internalCourierId) {
    throw new HttpError(409, "SHIPMENT_RATE_INTERNAL_MAPPING_MISSING");
  }

  try {
    if (!providerRef.id) throw new HttpError(409, "SHIPMENT_PROVIDER_DRAFT_MISSING");
    const manifested = await activeAdapter.manifestOrder({
      sellerId,
      shipmentId: shipment.id,
      providerOrderId: providerRef.providerOrderId,
      providerCourierId: internalCourierId,
      selectedRateId: selectedRate.id
    });
    const awb = publicAwb(shipment.id, manifested.awb);
    const trackingUrl = manifested.trackingUrl ?? trackingUrlForAwb(awb);
    const metadata = metadataObject(shipment.metadata);
    const phase6 = phase6Metadata(shipment.metadata);
    const serviceLevel = selectedRate.publicServiceName;

    await client.shipmentProviderRef.update({
      where: { id: providerRef.id },
      data: {
        providerAwb: manifested.providerAwb ?? manifested.awb,
        metadata: toPrismaJson({
          ...metadataObject(providerRef.metadata),
          phase6: {
            ...metadataObject(metadataObject(providerRef.metadata).phase6),
            manifestReference: manifested.providerReferenceNumber,
            manifestStatus: manifested.status,
            providerResponseJson: manifested.providerMetadata
          }
        })
      }
    });

    const updated = await client.shipment.update({
      where: { id: shipment.id },
      data: {
        status: ShipmentStatus.manifested,
        awbNumber: awb,
        trackingUrl,
        serviceLevel,
        sellerCourierPartnerId: selectedRate.sellerCourierPartnerId,
        courierPartnerId: selectedRate.courierPartnerId,
        metadata: toPrismaJson({
          ...metadata,
          phase6: {
            ...phase6,
            selectedTier: tier,
            selectedTierLabel: selectedTier.label,
            selectedRateId: selectedRate.id,
            selectedServiceCode: serviceCodeForName(serviceLevel),
            tierSummary: publicTierSummary(tiers),
            providerStatus: "awb_assigned",
            awbAssignedAt: new Date().toISOString(),
            trackingUrl,
            providerResponseJson: {
              ...metadataObject(phase6.providerResponseJson),
              manifest: manifested.providerMetadata
            },
            livePilotAwbLabelMode: liveAwbLabelReadiness.runtime.mode,
            livePilotAwbLabelReady: liveAwbLabelReadiness.ready
          }
        })
      }
    });
    await recordShipmentSlaEvent({
      client,
      adapter: activeAdapter,
      sellerId,
      shipment: updated,
      tier,
      serviceType: serviceLevel,
      eventType: "awb_assigned",
      courierCode: internalCourierId
    });

    return tryFetchLabel({
      client,
      adapter,
      sellerId,
      shipment: updated,
      providerRef,
      tier,
      serviceLevel
    });
  } catch (error) {
    await storeProviderError({ client, shipment, error });
    await recordShipmentSlaEvent({
      client,
      adapter: activeAdapter,
      sellerId,
      shipment,
      tier,
      serviceType: null,
      eventType: "failed"
    });
    throw new HttpError(502, "SHIPMENT_CREATION_FAILED", {
      retryable: providerErrorJson(error).retryable
    });
  }
}
