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
};

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
    }
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
    rates.push(await client.shipmentRate.create({
      data: {
        shipmentId: shipment.id,
        sellerId,
        sellerCourierPartnerId: mapping.id,
        courierPartnerId: partner.id,
        publicServiceCode: serviceCodeForName(providerRate.serviceLevel),
        publicServiceName: providerRate.serviceLevel,
        segment: shipment.segment,
        chargeableWeightKg: providerRate.chargedWeightKg,
        amountPaise: moneyToPaise(providerRate.totalCharge),
        currency: providerRate.currency,
        estimatedDeliveryDays: providerRate.tatDays,
        rateBreakup: toPrismaJson({
          internalRateId: providerRate.rateId,
          internalCourierId: providerRate.providerCourierId ?? null,
          result: providerRate.providerMetadata
        })
      }
    }));
  }

  if (shipment.status === ShipmentStatus.draft) {
    await client.shipment.update({
      where: { id: shipment.id },
      data: {
        status: ShipmentStatus.rates_fetched,
        sellerCourierPartnerId: mapping.id,
        courierPartnerId: partner.id
      }
    });
  }

  return {
    shipment_id: shipment.id,
    rates: rates.map(serializeRate)
  };
}
