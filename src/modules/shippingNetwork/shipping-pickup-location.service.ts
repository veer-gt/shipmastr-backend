import {
  CourierPartnerStatus,
  PartnerType,
  SellerCourierPartnerStatus,
  ShipmentSegment,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { createBigshipAdapter } from "../courierPartners/providers/bigship/bigship.adapter.js";
import type { InternalCourierProviderAdapter } from "../courierPartners/providers/provider-adapter.types.js";
import { SHIPMASTR_PUBLIC_COURIER_NETWORK } from "../courierPartners/courier-partners.config.js";
import type { CreatePickupLocationInput } from "./shipping-validation.js";
import { serializePickupLocation, toPrismaJson } from "./shipping-public-serializers.js";

type Db = Prisma.TransactionClient | typeof prisma;

type ShippingProviderOptions = {
  client?: Db;
  adapter?: InternalCourierProviderAdapter;
};

export function createMockSafeShippingAdapter() {
  return createBigshipAdapter({
    enabled: false,
    mockMode: true
  });
}

export async function ensureSystemManagedCourierNetwork(
  sellerId: string,
  client: Db = prisma
) {
  const partner = await client.courierPartner.findFirst({
    where: {
      active: true,
      status: CourierPartnerStatus.active,
      isSystemManaged: true,
      defaultForNewSellers: true,
      credentialsRequiredFromSeller: false,
      country: "IN",
      supportedSegments: {
        has: ShipmentSegment.domestic_b2c
      }
    },
    orderBy: [
      { priority: "asc" },
      { createdAt: "asc" }
    ]
  });

  if (!partner) {
    throw new HttpError(409, "COURIER_NETWORK_UNAVAILABLE");
  }

  const existing = await client.sellerCourierPartner.findUnique({
    where: {
      sellerId_courierPartnerId: {
        sellerId,
        courierPartnerId: partner.id
      }
    },
    include: {
      courierPartner: true
    }
  });

  if (existing) {
    return {
      partner,
      mapping: existing
    };
  }

  const mapping = await client.sellerCourierPartner.create({
    data: {
      sellerId,
      courierPartnerId: partner.id,
      status: SellerCourierPartnerStatus.active,
      partnerType: PartnerType.system_managed,
      credentialsRequiredFromSeller: false,
      enabledSegments: [ShipmentSegment.domestic_b2c],
      country: "IN",
      displayCode: SHIPMASTR_PUBLIC_COURIER_NETWORK.partnerCode,
      displayName: SHIPMASTR_PUBLIC_COURIER_NETWORK.partnerName
    },
    include: {
      courierPartner: true
    }
  });

  return {
    partner,
    mapping
  };
}

export async function createShippingPickupLocation(
  sellerId: string,
  input: CreatePickupLocationInput,
  options: ShippingProviderOptions = {}
) {
  const client = options.client ?? prisma;
  const adapter = options.adapter ?? createMockSafeShippingAdapter();
  const { partner, mapping } = await ensureSystemManagedCourierNetwork(sellerId, client);

  const location = await client.pickupLocation.create({
    data: {
      sellerId,
      label: input.name,
      contactName: input.contact_person,
      phone: input.phone,
      addressLine1: input.address.line1,
      addressLine2: input.address.line2 ?? null,
      city: input.address.city,
      state: input.address.state,
      pincode: input.address.pincode,
      country: input.address.country.toUpperCase(),
      status: "active",
      metadata: toPrismaJson({
        landmark: input.address.landmark ?? null,
        latitude: input.address.latitude ?? null,
        longitude: input.address.longitude ?? null,
        addressType: input.address_type ?? null
      })
    }
  });

  const providerPickup = await adapter.createPickupLocation({
    sellerId,
    pickupLocationId: location.id,
    name: input.name,
    contactPerson: input.contact_person,
    phone: input.phone,
    email: input.email ?? null,
    addressLine1: input.address.line1,
    addressLine2: input.address.line2 ?? null,
    landmark: input.address.landmark ?? null,
    city: input.address.city,
    state: input.address.state,
    country: input.address.country.toUpperCase(),
    pincode: input.address.pincode,
    latitude: input.address.latitude ?? null,
    longitude: input.address.longitude ?? null
  });

  await client.pickupLocationProviderMapping.upsert({
    where: {
      pickupLocationId_courierPartnerId: {
        pickupLocationId: location.id,
        courierPartnerId: partner.id
      }
    },
    create: {
      pickupLocationId: location.id,
      sellerCourierPartnerId: mapping.id,
      courierPartnerId: partner.id,
      providerPickupId: providerPickup.providerPickupId,
      providerCode: partner.code,
      status: providerPickup.status,
      metadata: toPrismaJson({
        message: providerPickup.message,
        result: providerPickup.providerMetadata
      })
    },
    update: {
      sellerCourierPartnerId: mapping.id,
      providerPickupId: providerPickup.providerPickupId,
      providerCode: partner.code,
      status: providerPickup.status,
      metadata: toPrismaJson({
        message: providerPickup.message,
        result: providerPickup.providerMetadata
      })
    }
  });

  return serializePickupLocation(location);
}

export async function listShippingPickupLocations(
  sellerId: string,
  client: Db = prisma
) {
  const locations = await client.pickupLocation.findMany({
    where: { sellerId },
    orderBy: { createdAt: "desc" }
  });

  return locations.map(serializePickupLocation);
}
