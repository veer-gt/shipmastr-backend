import { ShipmentStatus, type Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { normalizeIndianPhone } from "./shipping-order-validation.js";
import { normalizeStateName } from "./shipping-indian-states.js";
import {
  serializePickupLocation,
  toPrismaJson,
  terminalShipmentStatuses
} from "./shipping-public-serializers.js";
import type { UpdatePickupLocationInput } from "./shipping-validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

function metadataRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isDefaultPickup(value: unknown) {
  return metadataRecord(value).isDefault === true;
}

async function unsetOtherDefaults(sellerId: string, keepId: string, client: Db) {
  const defaults = await client.pickupLocation.findMany({
    where: {
      sellerId,
      status: "active"
    }
  });

  await Promise.all(defaults
    .filter((pickup) => pickup.id !== keepId && isDefaultPickup(pickup.metadata))
    .map((pickup) => client.pickupLocation.update({
      where: { id: pickup.id },
      data: {
        metadata: toPrismaJson({
          ...metadataRecord(pickup.metadata),
          isDefault: false
        })
      }
    })));
}

async function assignNextDefault(sellerId: string, client: Db) {
  const next = await client.pickupLocation.findFirst({
    where: {
      sellerId,
      status: "active"
    },
    orderBy: { createdAt: "asc" }
  });

  if (!next) return null;
  return client.pickupLocation.update({
    where: { id: next.id },
    data: {
      metadata: toPrismaJson({
        ...metadataRecord(next.metadata),
        isDefault: true
      })
    }
  });
}

function assertValidPickupInput(input: UpdatePickupLocationInput) {
  if (input.phone && !/^[6-9][0-9]{9}$/.test(normalizeIndianPhone(input.phone))) {
    throw new HttpError(400, "INVALID_PICKUP_PHONE");
  }
  if (input.address?.pincode && !/^[1-9][0-9]{5}$/.test(input.address.pincode)) {
    throw new HttpError(400, "INVALID_PICKUP_PINCODE");
  }
}

export async function updateShippingPickupLocation(
  sellerId: string,
  pickupLocationId: string,
  input: UpdatePickupLocationInput,
  client: Db = prisma
) {
  assertValidPickupInput(input);
  const existing = await client.pickupLocation.findFirst({
    where: {
      id: pickupLocationId,
      sellerId
    }
  });
  if (!existing) throw new HttpError(404, "PICKUP_LOCATION_NOT_FOUND");
  const metadata = metadataRecord(existing.metadata);
  const updated = await client.pickupLocation.update({
    where: { id: existing.id },
    data: {
      ...(input.name ? { label: input.name } : {}),
      ...(input.contact_person ? { contactName: input.contact_person } : {}),
      ...(input.phone ? { phone: normalizeIndianPhone(input.phone) } : {}),
      ...(input.address?.line1 ? { addressLine1: input.address.line1 } : {}),
      ...(input.address?.line2 !== undefined ? { addressLine2: input.address.line2 ?? null } : {}),
      ...(input.address?.city ? { city: input.address.city } : {}),
      ...(input.address?.state ? { state: normalizeStateName(input.address.state) } : {}),
      ...(input.address?.pincode ? { pincode: input.address.pincode } : {}),
      ...(input.address?.country ? { country: input.address.country.toUpperCase() } : {}),
      metadata: toPrismaJson({
        ...metadata,
        ...(input.address?.landmark !== undefined ? { landmark: input.address.landmark ?? null } : {}),
        ...(input.address?.latitude !== undefined ? { latitude: input.address.latitude ?? null } : {}),
        ...(input.address?.longitude !== undefined ? { longitude: input.address.longitude ?? null } : {}),
        ...(input.address_type !== undefined ? { addressType: input.address_type ?? null } : {}),
        ...(input.is_default !== undefined ? { isDefault: input.is_default } : {})
      })
    }
  });

  if (input.is_default === true) {
    await unsetOtherDefaults(sellerId, updated.id, client);
  }

  return {
    ...serializePickupLocation(updated),
    is_default: isDefaultPickup(updated.metadata)
  };
}

export async function deleteShippingPickupLocation(
  sellerId: string,
  pickupLocationId: string,
  client: Db = prisma
) {
  const existing = await client.pickupLocation.findFirst({
    where: {
      id: pickupLocationId,
      sellerId
    }
  });
  if (!existing) throw new HttpError(404, "PICKUP_LOCATION_NOT_FOUND");
  const activeShipment = await client.shipment.findFirst({
    where: {
      sellerId,
      pickupLocationId: existing.id,
      status: {
        notIn: [
          ...Array.from(terminalShipmentStatuses),
          ShipmentStatus.cancelled
        ] as ShipmentStatus[]
      }
    }
  });
  if (activeShipment) throw new HttpError(409, "PICKUP_LOCATION_IN_USE");
  const wasDefault = isDefaultPickup(existing.metadata);
  const deleted = await client.pickupLocation.update({
    where: { id: existing.id },
    data: {
      status: "inactive",
      metadata: toPrismaJson({
        ...metadataRecord(existing.metadata),
        isDefault: false
      })
    }
  });

  if (wasDefault) {
    await assignNextDefault(sellerId, client);
  }

  return {
    pickup_location_id: deleted.id,
    status: deleted.status
  };
}
