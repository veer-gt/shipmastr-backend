import {
  AccountGstinVerificationStatus,
  PickupPointStatus,
  type Prisma
} from "@prisma/client";
import { normalizeRequiredGstin } from "../../lib/gstin.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { normalizeOptionalText, normalizePincode, normalizeState } from "../../lib/state.js";
import { markAddressForGeocoding } from "../addressGeocoding/address-geocoding.service.js";
import { audit } from "../audit/audit.service.js";

type Db = Prisma.TransactionClient | typeof prisma;
type OwnerType = "merchant" | "courier";

export type GstinRecordInput = {
  gstin: string;
  legalName?: string | null | undefined;
  tradeName?: string | null | undefined;
  registrationStatus?: string | null | undefined;
  registeredAddress?: string | null | undefined;
  registeredState: string;
  registeredPincode?: string | null | undefined;
  source?: string | null | undefined;
};

export type LocationInput = {
  label: string;
  contactName: string;
  phone: string;
  email?: string | null | undefined;
  addressLine1: string;
  addressLine2?: string | null | undefined;
  city: string;
  state: string;
  pincode: string;
  isDefault?: boolean | undefined;
  googlePlaceId?: string | null | undefined;
};

export type LocationPatchInput = {
  label?: string | undefined;
  contactName?: string | undefined;
  phone?: string | undefined;
  email?: string | null | undefined;
  addressLine1?: string | undefined;
  addressLine2?: string | null | undefined;
  city?: string | undefined;
  state?: string | undefined;
  pincode?: string | undefined;
  isDefault?: boolean | undefined;
  googlePlaceId?: string | null | undefined;
  status?: PickupPointStatus | undefined;
  rejectionReason?: string | null | undefined;
};

function cleanTextRequired(value: string | undefined, error: string) {
  const cleaned = normalizeOptionalText(value);
  if (!cleaned) throw new HttpError(400, error);
  return cleaned;
}

function cleanPhone(value: string | undefined) {
  const cleaned = value?.trim();
  if (!cleaned || !/^[0-9+\-\s()]{8,20}$/.test(cleaned)) {
    throw new HttpError(400, "INVALID_PHONE");
  }

  return cleaned;
}

function cleanEmail(value: string | null | undefined) {
  const cleaned = normalizeOptionalText(value);
  if (!cleaned) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    throw new HttpError(400, "INVALID_EMAIL");
  }

  return cleaned.toLowerCase();
}

function cleanGstinInput(input: GstinRecordInput) {
  const registeredPincode = input.registeredPincode ? normalizePincode(input.registeredPincode) : null;

  return {
    gstin: normalizeRequiredGstin(input.gstin),
    legalName: normalizeOptionalText(input.legalName),
    tradeName: normalizeOptionalText(input.tradeName),
    registrationStatus: normalizeOptionalText(input.registrationStatus),
    registeredAddress: normalizeOptionalText(input.registeredAddress),
    registeredState: normalizeState(input.registeredState),
    registeredPincode
  };
}

function cleanCourierGstinInput(input: GstinRecordInput) {
  return {
    ...cleanGstinInput(input),
    source: normalizeOptionalText(input.source)
  };
}

function cleanLocationInput(input: LocationInput) {
  return {
    label: cleanTextRequired(input.label, "PICKUP_LABEL_REQUIRED"),
    contactName: cleanTextRequired(input.contactName, "PICKUP_CONTACT_REQUIRED"),
    phone: cleanPhone(input.phone),
    email: cleanEmail(input.email),
    addressLine1: cleanTextRequired(input.addressLine1, "PICKUP_ADDRESS_REQUIRED"),
    addressLine2: normalizeOptionalText(input.addressLine2),
    city: cleanTextRequired(input.city, "PICKUP_CITY_REQUIRED"),
    state: normalizeState(input.state),
    pincode: normalizePincode(input.pincode),
    isDefault: Boolean(input.isDefault),
    googlePlaceId: normalizeOptionalText(input.googlePlaceId)
  };
}

function gstinResponse(record: {
  id: string;
  gstin: string;
  legalName: string | null;
  tradeName: string | null;
  registrationStatus: string | null;
  registeredAddress: string | null;
  registeredState: string;
  registeredPincode: string | null;
  source?: string | null;
  verificationStatus: AccountGstinVerificationStatus;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  latitude?: unknown;
  longitude?: unknown;
  googleGeocodePlaceId?: string | null;
  googleFormattedAddress?: string | null;
  geocodeProvider?: string | null;
  geocodeStatus?: string | null;
  geocodeLocationType?: string | null;
  geocodePartialMatch?: boolean | null;
  geocodeErrorCode?: string | null;
  geocodedAt?: Date | null;
  addressFingerprint?: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: record.id,
    gstin: record.gstin,
    legalName: record.legalName,
    tradeName: record.tradeName,
    registrationStatus: record.registrationStatus,
    registeredAddress: record.registeredAddress,
    registeredState: record.registeredState,
    registeredPincode: record.registeredPincode,
    source: record.source ?? null,
    verificationStatus: record.verificationStatus,
    verifiedAt: record.verifiedAt,
    verifiedBy: record.verifiedBy,
    rejectedAt: record.rejectedAt,
    rejectedBy: record.rejectedBy,
    rejectionReason: record.rejectionReason,
    latitude: record.latitude ?? null,
    longitude: record.longitude ?? null,
    googleGeocodePlaceId: record.googleGeocodePlaceId ?? null,
    googleFormattedAddress: record.googleFormattedAddress ?? null,
    geocodeProvider: record.geocodeProvider ?? null,
    geocodeStatus: record.geocodeStatus ?? "SKIPPED",
    geocodeLocationType: record.geocodeLocationType ?? null,
    geocodePartialMatch: record.geocodePartialMatch ?? null,
    geocodeErrorCode: record.geocodeErrorCode ?? null,
    geocodedAt: record.geocodedAt ?? null,
    addressFingerprint: record.addressFingerprint ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function locationResponse<T extends {
  id: string;
  linkedGstinId: string | null;
  label: string;
  contactName: string;
  phone: string;
  email?: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  pincode: string;
  status: PickupPointStatus;
  isDefault: boolean;
  blockerReason: string | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  linkedGstin?: { gstin: string; registeredState: string; verificationStatus: AccountGstinVerificationStatus } | null;
}>(record: T) {
  return {
    id: record.id,
    linkedGstinId: record.linkedGstinId,
    linkedGstin: record.linkedGstin ? {
      gstin: record.linkedGstin.gstin,
      registeredState: record.linkedGstin.registeredState,
      verificationStatus: record.linkedGstin.verificationStatus
    } : null,
    label: record.label,
    contactName: record.contactName,
    phone: record.phone,
    email: record.email ?? null,
    addressLine1: record.addressLine1,
    addressLine2: record.addressLine2,
    city: record.city,
    state: record.state,
    pincode: record.pincode,
    status: record.status,
    isDefault: record.isDefault,
    blockerReason: record.blockerReason,
    approvedAt: record.approvedAt,
    approvedBy: record.approvedBy,
    rejectedAt: record.rejectedAt,
    rejectedBy: record.rejectedBy,
    rejectionReason: record.rejectionReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    stateGstinMatched: Boolean(record.linkedGstinId)
  };
}

async function writeTaxAudit(input: {
  ownerType: OwnerType;
  ownerId: string;
  merchantId?: string | undefined;
  actorId?: string | undefined;
  action: string;
  entityType: string;
  entityId?: string | undefined;
  metadata?: unknown;
}, client: Db) {
  const auditInput: Parameters<typeof audit>[0] = {
    action: input.action,
    entityType: input.entityType,
    metadata: {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      ...(typeof input.metadata === "object" && input.metadata !== null ? input.metadata as Record<string, unknown> : { detail: input.metadata })
    }
  };
  if (input.merchantId) auditInput.merchantId = input.merchantId;
  if (input.actorId) auditInput.actorId = input.actorId;
  if (input.entityId) auditInput.entityId = input.entityId;

  await audit(auditInput, client).catch(() => undefined);
}

async function findVerifiedMerchantGstin(merchantId: string, state: string, client: Db) {
  return client.merchantGstinRecord.findFirst({
    where: {
      merchantId,
      registeredState: state,
      verificationStatus: AccountGstinVerificationStatus.VERIFIED
    },
    orderBy: [{ verifiedAt: "desc" }, { createdAt: "desc" }]
  });
}

async function findVerifiedCourierGstin(courierId: string, state: string, client: Db) {
  const records = await client.courierGstinRecord.findMany({
    where: {
      courierId,
      registeredState: state,
      verificationStatus: AccountGstinVerificationStatus.VERIFIED
    },
    orderBy: [{ verifiedAt: "desc" }, { createdAt: "desc" }]
  });

  return records.find((record) => !isBlockedGstinRegistrationStatus(record.registrationStatus)) || null;
}

function linkedStatus(linkedGstinId?: string | null) {
  return linkedGstinId ? PickupPointStatus.PENDING : PickupPointStatus.REQUIRE_STATE_GSTIN;
}

function courierOfficeLinkedStatus(linkedGstinId?: string | null) {
  return linkedGstinId ? PickupPointStatus.PENDING_REVIEW : PickupPointStatus.REQUIRE_STATE_GSTIN;
}

function normalizeCourierOfficeStatus(status?: PickupPointStatus | undefined) {
  if (!status) return undefined;
  if (status === PickupPointStatus.PENDING) return PickupPointStatus.PENDING_REVIEW;
  if (status === PickupPointStatus.BLOCKED) return PickupPointStatus.HOLD;

  if (![
    PickupPointStatus.PENDING_REVIEW,
    PickupPointStatus.APPROVED,
    PickupPointStatus.REJECTED,
    PickupPointStatus.REQUIRE_STATE_GSTIN,
    PickupPointStatus.HOLD
  ].includes(status)) {
    throw new HttpError(400, "COURIER_OPERATIONAL_OFFICE_STATUS_INVALID");
  }

  return status;
}

function blockerForState(state: string) {
  return `Pickup state ${state} requires one verified GSTIN registered in the same state. Pincode match is not required.`;
}

const blockedRegistrationStatuses = [
  "CANCEL",
  "CANCELLED",
  "INACTIVE",
  "SUSPEND",
  "SUSPENDED",
  "REVOKE",
  "REVOKED"
];

function isBlockedGstinRegistrationStatus(status: string | null | undefined) {
  const normalized = status?.trim().toUpperCase();
  if (!normalized) return false;
  return blockedRegistrationStatuses.some((blocked) => normalized.includes(blocked));
}

function normalizeNameForComparison(value: string | null | undefined) {
  return value?.toUpperCase().replace(/[^A-Z0-9]/g, "") || "";
}

function jsonObject(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringFromJson(value: unknown) {
  return typeof value === "string" ? value : null;
}

async function courierNameCandidates(courierId: string, client: Db) {
  const courier = await client.courierPartner.findUnique({
    where: { id: courierId },
    select: {
      id: true,
      name: true,
      onboarding: {
        select: { companyLegal: true }
      }
    }
  }) as unknown as {
    name?: string | null;
    onboarding?: { companyLegal?: unknown } | null;
  } | null;

  const companyLegal = jsonObject(courier?.onboarding?.companyLegal);
  return [
    courier?.name,
    stringFromJson(companyLegal.companyName),
    stringFromJson(companyLegal.legalName),
    stringFromJson(companyLegal.tradeName)
  ].map(normalizeNameForComparison).filter(Boolean);
}

async function courierGstinNameMismatch(input: {
  courierId: string;
  legalName: string | null;
  tradeName: string | null;
}, client: Db) {
  const submittedNames = [
    input.legalName,
    input.tradeName
  ].map(normalizeNameForComparison).filter(Boolean);
  if (!submittedNames.length) return false;

  const expectedNames = await courierNameCandidates(input.courierId, client);
  if (!expectedNames.length) return false;

  return !submittedNames.some((submitted) => expectedNames.includes(submitted));
}

async function holdCourierGstinRecord(input: {
  courierId: string;
  gstinRecordId: string;
  actorId?: string | undefined;
  reason: string;
  action: string;
}, client: Db) {
  const record = await client.courierGstinRecord.update({
    where: { id: input.gstinRecordId },
    data: {
      verificationStatus: AccountGstinVerificationStatus.HOLD,
      verifiedAt: null,
      verifiedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: input.reason
    }
  });

  const blockedLocations = await client.courierOperationalLocation.updateMany({
    where: { courierId: input.courierId, linkedGstinId: record.id },
    data: {
      linkedGstinId: null,
      status: PickupPointStatus.REQUIRE_STATE_GSTIN,
      blockerReason: input.reason
    }
  });

  await writeTaxAudit({
    ownerType: "courier",
    ownerId: input.courierId,
    actorId: input.actorId,
    action: input.action,
    entityType: "courier_gstin_record",
    entityId: record.id,
    metadata: {
      courierId: input.courierId,
      gstin: record.gstin,
      registeredState: record.registeredState,
      registrationStatus: record.registrationStatus,
      reason: input.reason,
      blockedLocationCount: blockedLocations.count
    }
  }, client);

  return record;
}

export async function listMerchantTaxProfile(merchantId: string, client: Db = prisma) {
  const [gstins, pickupPoints] = await Promise.all([
    client.merchantGstinRecord.findMany({
      where: { merchantId },
      orderBy: [{ verificationStatus: "asc" }, { registeredState: "asc" }, { createdAt: "desc" }]
    }),
    client.merchantPickupPoint.findMany({
      where: { merchantId },
      include: { linkedGstin: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }]
    })
  ]);

  return {
    gstinRecords: gstins.map(gstinResponse),
    pickupPoints: pickupPoints.map(locationResponse)
  };
}

export async function createMerchantGstinRecord(input: {
  merchantId: string;
  actorId?: string | undefined;
  record: GstinRecordInput;
}, client: Db = prisma) {
  const data = cleanGstinInput(input.record);
  const record = await client.merchantGstinRecord.create({
    data: {
      merchantId: input.merchantId,
      ...data
    }
  });

  await writeTaxAudit({
    ownerType: "merchant",
    ownerId: input.merchantId,
    merchantId: input.merchantId,
    actorId: input.actorId,
    action: "MERCHANT_GSTIN_ADDED",
    entityType: "merchant_gstin_record",
    entityId: record.id,
    metadata: {
      gstin: record.gstin,
      registeredState: record.registeredState,
      verificationStatus: record.verificationStatus
    }
  }, client);

  return gstinResponse(record);
}

export async function verifyMerchantGstinRecord(input: {
  merchantId: string;
  gstinRecordId: string;
  actorId?: string | undefined;
}, client: Db = prisma) {
  const existing = await client.merchantGstinRecord.findFirst({
    where: { id: input.gstinRecordId, merchantId: input.merchantId }
  });
  if (!existing) throw new HttpError(404, "GSTIN_RECORD_NOT_FOUND");

  const record = await client.merchantGstinRecord.update({
    where: { id: existing.id },
    data: {
      verificationStatus: AccountGstinVerificationStatus.VERIFIED,
      verifiedAt: new Date(),
      verifiedBy: input.actorId || null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null
    }
  });

  const relinked = await client.merchantPickupPoint.updateMany({
    where: {
      merchantId: input.merchantId,
      state: record.registeredState,
      status: PickupPointStatus.REQUIRE_STATE_GSTIN
    },
    data: {
      linkedGstinId: record.id,
      status: PickupPointStatus.PENDING,
      blockerReason: null
    }
  });

  await writeTaxAudit({
    ownerType: "merchant",
    ownerId: input.merchantId,
    merchantId: input.merchantId,
    actorId: input.actorId,
    action: "MERCHANT_GSTIN_VERIFIED",
    entityType: "merchant_gstin_record",
    entityId: record.id,
    metadata: {
      gstin: record.gstin,
      registeredState: record.registeredState,
      relinkedPickupCount: relinked.count
    }
  }, client);

  return gstinResponse(record);
}

export async function rejectMerchantGstinRecord(input: {
  merchantId: string;
  gstinRecordId: string;
  reason?: string | null | undefined;
  actorId?: string | undefined;
}, client: Db = prisma) {
  const existing = await client.merchantGstinRecord.findFirst({
    where: { id: input.gstinRecordId, merchantId: input.merchantId }
  });
  if (!existing) throw new HttpError(404, "GSTIN_RECORD_NOT_FOUND");

  const reason = normalizeOptionalText(input.reason);
  const record = await client.merchantGstinRecord.update({
    where: { id: existing.id },
    data: {
      verificationStatus: AccountGstinVerificationStatus.REJECTED,
      rejectedAt: new Date(),
      rejectedBy: input.actorId || null,
      rejectionReason: reason,
      verifiedAt: null,
      verifiedBy: null
    }
  });

  await client.merchantPickupPoint.updateMany({
    where: { merchantId: input.merchantId, linkedGstinId: record.id },
    data: {
      linkedGstinId: null,
      status: PickupPointStatus.REQUIRE_STATE_GSTIN,
      blockerReason: blockerForState(record.registeredState)
    }
  });

  await writeTaxAudit({
    ownerType: "merchant",
    ownerId: input.merchantId,
    merchantId: input.merchantId,
    actorId: input.actorId,
    action: "MERCHANT_GSTIN_REJECTED",
    entityType: "merchant_gstin_record",
    entityId: record.id,
    metadata: {
      gstin: record.gstin,
      registeredState: record.registeredState,
      reason
    }
  }, client);

  return gstinResponse(record);
}

export async function createMerchantPickupPoint(input: {
  merchantId: string;
  actorId?: string | undefined;
  pickup: LocationInput;
}, client: Db = prisma) {
  const pickup = cleanLocationInput(input.pickup);
  const verified = await findVerifiedMerchantGstin(input.merchantId, pickup.state, client);
  const status = linkedStatus(verified?.id);
  const blockerReason = verified ? null : blockerForState(pickup.state);

  if (pickup.isDefault) {
    await client.merchantPickupPoint.updateMany({
      where: { merchantId: input.merchantId },
      data: { isDefault: false }
    });
  }

  const record = await client.merchantPickupPoint.create({
    data: {
      merchantId: input.merchantId,
      linkedGstinId: verified?.id || null,
      label: pickup.label,
      contactName: pickup.contactName,
      phone: pickup.phone,
      addressLine1: pickup.addressLine1,
      addressLine2: pickup.addressLine2,
      city: pickup.city,
      state: pickup.state,
      pincode: pickup.pincode,
      googleGeocodePlaceId: pickup.googlePlaceId,
      isDefault: pickup.isDefault,
      status,
      blockerReason
    },
    include: { linkedGstin: true }
  });

  await writeTaxAudit({
    ownerType: "merchant",
    ownerId: input.merchantId,
    merchantId: input.merchantId,
    actorId: input.actorId,
    action: "MERCHANT_PICKUP_CREATED",
    entityType: "merchant_pickup_point",
    entityId: record.id,
    metadata: {
      state: record.state,
      pincode: record.pincode,
      status: record.status,
      linkedGstinId: record.linkedGstinId
    }
  }, client);

  if (!verified) {
    await writeTaxAudit({
      ownerType: "merchant",
      ownerId: input.merchantId,
      merchantId: input.merchantId,
      actorId: input.actorId,
      action: "MERCHANT_PICKUP_STATE_GSTIN_MISMATCH",
      entityType: "merchant_pickup_point",
      entityId: record.id,
      metadata: {
        state: record.state,
        status: record.status,
        blockerReason
      }
    }, client);
  }

  const geocodeState = await markAddressForGeocoding({
    entityType: "MERCHANT_PICKUP_POINT",
    entityId: record.id,
    merchantId: input.merchantId,
    address: {
      addressLine1: record.addressLine1,
      addressLine2: record.addressLine2,
      city: record.city,
      state: record.state,
      pincode: record.pincode,
      country: "IN",
      googlePlaceId: pickup.googlePlaceId
    },
    previousAddressFingerprint: null
  }, client);

  return locationResponse({
    ...record,
    geocodeStatus: geocodeState.status,
    addressFingerprint: geocodeState.addressFingerprint
  });
}

export async function updateMerchantPickupPoint(input: {
  merchantId: string;
  pickupPointId: string;
  actorId?: string | undefined;
  patch: LocationPatchInput;
}, client: Db = prisma) {
  const existing = await client.merchantPickupPoint.findFirst({
    where: { id: input.pickupPointId, merchantId: input.merchantId },
    include: { linkedGstin: true }
  });
  if (!existing) throw new HttpError(404, "PICKUP_POINT_NOT_FOUND");

  const next = {
    label: input.patch.label !== undefined ? cleanTextRequired(input.patch.label, "PICKUP_LABEL_REQUIRED") : existing.label,
    contactName: input.patch.contactName !== undefined ? cleanTextRequired(input.patch.contactName, "PICKUP_CONTACT_REQUIRED") : existing.contactName,
    phone: input.patch.phone !== undefined ? cleanPhone(input.patch.phone) : existing.phone,
    addressLine1: input.patch.addressLine1 !== undefined ? cleanTextRequired(input.patch.addressLine1, "PICKUP_ADDRESS_REQUIRED") : existing.addressLine1,
    addressLine2: input.patch.addressLine2 !== undefined ? normalizeOptionalText(input.patch.addressLine2) : existing.addressLine2,
    city: input.patch.city !== undefined ? cleanTextRequired(input.patch.city, "PICKUP_CITY_REQUIRED") : existing.city,
    state: input.patch.state !== undefined ? normalizeState(input.patch.state) : existing.state,
    pincode: input.patch.pincode !== undefined ? normalizePincode(input.patch.pincode) : existing.pincode,
    isDefault: input.patch.isDefault !== undefined ? Boolean(input.patch.isDefault) : existing.isDefault,
    googlePlaceId: input.patch.googlePlaceId !== undefined ? normalizeOptionalText(input.patch.googlePlaceId) : existing.googleGeocodePlaceId
  };

  const verified = await findVerifiedMerchantGstin(input.merchantId, next.state, client);
  if (input.patch.status === PickupPointStatus.APPROVED && !verified) {
    await writeTaxAudit({
      ownerType: "merchant",
      ownerId: input.merchantId,
      merchantId: input.merchantId,
      actorId: input.actorId,
      action: "MERCHANT_PICKUP_APPROVE_BLOCKED_STATE_GSTIN_MISMATCH",
      entityType: "merchant_pickup_point",
      entityId: existing.id,
      metadata: {
        state: next.state,
        previousLinkedGstinId: existing.linkedGstinId
      }
    }, client);
    throw new HttpError(400, "PICKUP_STATE_GSTIN_REQUIRED");
  }

  const nextStatus = verified
    ? input.patch.status || (existing.status === PickupPointStatus.REQUIRE_STATE_GSTIN ? PickupPointStatus.PENDING : existing.status)
    : PickupPointStatus.REQUIRE_STATE_GSTIN;
  const blockerReason = verified ? null : blockerForState(next.state);

  if (next.isDefault) {
    await client.merchantPickupPoint.updateMany({
      where: { merchantId: input.merchantId, id: { not: existing.id } },
      data: { isDefault: false }
    });
  }

  const { googlePlaceId, ...nextData } = next;
  const record = await client.merchantPickupPoint.update({
    where: { id: existing.id },
    data: {
      ...nextData,
      googleGeocodePlaceId: googlePlaceId,
      linkedGstinId: verified?.id || null,
      status: nextStatus,
      blockerReason,
      approvedAt: nextStatus === PickupPointStatus.APPROVED ? new Date() : existing.approvedAt,
      approvedBy: nextStatus === PickupPointStatus.APPROVED ? input.actorId || null : existing.approvedBy,
      rejectedAt: nextStatus === PickupPointStatus.REJECTED ? new Date() : existing.rejectedAt,
      rejectedBy: nextStatus === PickupPointStatus.REJECTED ? input.actorId || null : existing.rejectedBy,
      rejectionReason: nextStatus === PickupPointStatus.REJECTED ? normalizeOptionalText(input.patch.rejectionReason) : existing.rejectionReason
    },
    include: { linkedGstin: true }
  });

  await writeTaxAudit({
    ownerType: "merchant",
    ownerId: input.merchantId,
    merchantId: input.merchantId,
    actorId: input.actorId,
    action: "MERCHANT_PICKUP_UPDATED",
    entityType: "merchant_pickup_point",
    entityId: record.id,
    metadata: {
      before: {
        state: existing.state,
        status: existing.status,
        linkedGstinId: existing.linkedGstinId
      },
      after: {
        state: record.state,
        status: record.status,
        linkedGstinId: record.linkedGstinId
      },
      linkedGstinChanged: existing.linkedGstinId !== record.linkedGstinId
    }
  }, client);

  if (!verified) {
    await writeTaxAudit({
      ownerType: "merchant",
      ownerId: input.merchantId,
      merchantId: input.merchantId,
      actorId: input.actorId,
      action: "MERCHANT_PICKUP_STATE_GSTIN_MISMATCH",
      entityType: "merchant_pickup_point",
      entityId: record.id,
      metadata: {
        state: record.state,
        status: record.status,
        blockerReason
      }
    }, client);
  }

  const geocodeState = await markAddressForGeocoding({
    entityType: "MERCHANT_PICKUP_POINT",
    entityId: record.id,
    merchantId: input.merchantId,
    address: {
      addressLine1: record.addressLine1,
      addressLine2: record.addressLine2,
      city: record.city,
      state: record.state,
      pincode: record.pincode,
      country: "IN",
      googlePlaceId
    },
    previousAddressFingerprint: existing.addressFingerprint
  }, client);

  return locationResponse({
    ...record,
    geocodeStatus: geocodeState.status,
    addressFingerprint: geocodeState.addressFingerprint
  });
}

export async function approveMerchantPickupPoint(input: {
  merchantId: string;
  pickupPointId: string;
  actorId?: string | undefined;
}, client: Db = prisma) {
  return updateMerchantPickupPoint({
    merchantId: input.merchantId,
    pickupPointId: input.pickupPointId,
    actorId: input.actorId,
    patch: { status: PickupPointStatus.APPROVED }
  }, client);
}

export async function rejectMerchantPickupPoint(input: {
  merchantId: string;
  pickupPointId: string;
  reason?: string | null | undefined;
  actorId?: string | undefined;
}, client: Db = prisma) {
  return updateMerchantPickupPoint({
    merchantId: input.merchantId,
    pickupPointId: input.pickupPointId,
    actorId: input.actorId,
    patch: { status: PickupPointStatus.REJECTED, rejectionReason: input.reason }
  }, client);
}

export async function listCourierTaxProfile(courierId: string, client: Db = prisma) {
  const [gstins, locations, activationReadiness] = await Promise.all([
    client.courierGstinRecord.findMany({
      where: { courierId },
      orderBy: [{ verificationStatus: "asc" }, { registeredState: "asc" }, { createdAt: "desc" }]
    }),
    client.courierOperationalLocation.findMany({
      where: { courierId },
      include: { linkedGstin: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }]
    }),
    getCourierActivationReadiness(courierId, client)
  ]);

  return {
    gstinRecords: gstins.map(gstinResponse),
    operationalLocations: locations.map(locationResponse),
    activationReadiness
  };
}

export async function createCourierGstinRecord(input: {
  courierId: string;
  actorId?: string | undefined;
  record: GstinRecordInput;
}, client: Db = prisma) {
  const data = cleanCourierGstinInput(input.record);
  const record = await client.courierGstinRecord.create({
    data: {
      courierId: input.courierId,
      ...data,
      verificationStatus: AccountGstinVerificationStatus.PENDING_REVIEW
    }
  });

  await writeTaxAudit({
    ownerType: "courier",
    ownerId: input.courierId,
    actorId: input.actorId,
    action: "COURIER_GSTIN_ADDED",
    entityType: "courier_gstin_record",
    entityId: record.id,
    metadata: {
      courierId: input.courierId,
      gstin: record.gstin,
      registeredState: record.registeredState,
      source: record.source,
      verificationStatus: record.verificationStatus
    }
  }, client);

  return gstinResponse(record);
}

export async function verifyCourierGstinRecord(input: {
  courierId: string;
  gstinRecordId: string;
  actorId?: string | undefined;
}, client: Db = prisma) {
  const existing = await client.courierGstinRecord.findFirst({
    where: { id: input.gstinRecordId, courierId: input.courierId }
  });
  if (!existing) throw new HttpError(404, "GSTIN_RECORD_NOT_FOUND");

  if (isBlockedGstinRegistrationStatus(existing.registrationStatus)) {
    const record = await holdCourierGstinRecord({
      courierId: input.courierId,
      gstinRecordId: existing.id,
      actorId: input.actorId,
      reason: "GSTIN registration status is inactive, cancelled, suspended, or otherwise blocked.",
      action: "COURIER_GSTIN_REGISTRATION_STATUS_BLOCKED"
    }, client);

    return gstinResponse(record);
  }

  if (await courierGstinNameMismatch({
    courierId: input.courierId,
    legalName: existing.legalName,
    tradeName: existing.tradeName
  }, client)) {
    const record = await holdCourierGstinRecord({
      courierId: input.courierId,
      gstinRecordId: existing.id,
      actorId: input.actorId,
      reason: "GSTIN legal/trade name does not match the courier partner record.",
      action: "COURIER_GSTIN_LEGAL_TRADE_NAME_MISMATCH_HOLD"
    }, client);

    return gstinResponse(record);
  }

  const record = await client.courierGstinRecord.update({
    where: { id: existing.id },
    data: {
      verificationStatus: AccountGstinVerificationStatus.VERIFIED,
      verifiedAt: new Date(),
      verifiedBy: input.actorId || null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null
    }
  });

  const relinked = await client.courierOperationalLocation.updateMany({
    where: {
      courierId: input.courierId,
      state: record.registeredState,
      status: PickupPointStatus.REQUIRE_STATE_GSTIN
    },
    data: {
      linkedGstinId: record.id,
      status: PickupPointStatus.PENDING_REVIEW,
      blockerReason: null
    }
  });

  await writeTaxAudit({
    ownerType: "courier",
    ownerId: input.courierId,
    actorId: input.actorId,
    action: "COURIER_GSTIN_VERIFIED",
    entityType: "courier_gstin_record",
    entityId: record.id,
    metadata: {
      courierId: input.courierId,
      gstin: record.gstin,
      registeredState: record.registeredState,
      relinkedLocationCount: relinked.count
    }
  }, client);

  return gstinResponse(record);
}

export async function rejectCourierGstinRecord(input: {
  courierId: string;
  gstinRecordId: string;
  reason?: string | null | undefined;
  actorId?: string | undefined;
}, client: Db = prisma) {
  const existing = await client.courierGstinRecord.findFirst({
    where: { id: input.gstinRecordId, courierId: input.courierId }
  });
  if (!existing) throw new HttpError(404, "GSTIN_RECORD_NOT_FOUND");

  const reason = normalizeOptionalText(input.reason);
  const record = await client.courierGstinRecord.update({
    where: { id: existing.id },
    data: {
      verificationStatus: AccountGstinVerificationStatus.REJECTED,
      rejectedAt: new Date(),
      rejectedBy: input.actorId || null,
      rejectionReason: reason,
      verifiedAt: null,
      verifiedBy: null
    }
  });

  await client.courierOperationalLocation.updateMany({
    where: { courierId: input.courierId, linkedGstinId: record.id },
    data: {
      linkedGstinId: null,
      status: PickupPointStatus.REQUIRE_STATE_GSTIN,
      blockerReason: blockerForState(record.registeredState)
    }
  });

  await writeTaxAudit({
    ownerType: "courier",
    ownerId: input.courierId,
    actorId: input.actorId,
    action: "COURIER_GSTIN_REJECTED",
    entityType: "courier_gstin_record",
    entityId: record.id,
    metadata: {
      courierId: input.courierId,
      gstin: record.gstin,
      registeredState: record.registeredState,
      reason
    }
  }, client);

  return gstinResponse(record);
}

export async function createCourierOperationalLocation(input: {
  courierId: string;
  actorId?: string | undefined;
  location: LocationInput;
}, client: Db = prisma) {
  const courier = await client.courierPartner.findUnique({
    where: { id: input.courierId },
    select: { id: true, gstin: true }
  });
  if (!courier?.gstin) {
    throw new HttpError(400, "COURIER_GSTIN_REQUIRED");
  }

  const location = cleanLocationInput(input.location);
  const verified = await findVerifiedCourierGstin(input.courierId, location.state, client);
  const status = courierOfficeLinkedStatus(verified?.id);
  const blockerReason = verified ? null : blockerForState(location.state);

  if (location.isDefault) {
    await client.courierOperationalLocation.updateMany({
      where: { courierId: input.courierId },
      data: { isDefault: false }
    });
  }

  const record = await client.courierOperationalLocation.create({
    data: {
      courierId: input.courierId,
      linkedGstinId: verified?.id || null,
      ...location,
      status,
      blockerReason
    },
    include: { linkedGstin: true }
  });

  await writeTaxAudit({
    ownerType: "courier",
    ownerId: input.courierId,
    actorId: input.actorId,
    action: "COURIER_OPERATIONAL_OFFICE_CREATED",
    entityType: "courier_operational_location",
    entityId: record.id,
    metadata: {
      courierId: input.courierId,
      state: record.state,
      pincode: record.pincode,
      status: record.status,
      linkedGstinId: record.linkedGstinId
    }
  }, client);

  if (!verified) {
    await writeTaxAudit({
      ownerType: "courier",
      ownerId: input.courierId,
      actorId: input.actorId,
      action: "COURIER_LOCATION_STATE_GSTIN_MISMATCH",
      entityType: "courier_operational_location",
      entityId: record.id,
      metadata: {
        courierId: input.courierId,
        state: record.state,
        status: record.status,
        blockerReason
      }
    }, client);
  }

  return locationResponse(record);
}

export async function updateCourierOperationalLocation(input: {
  courierId: string;
  locationId: string;
  actorId?: string | undefined;
  patch: LocationPatchInput;
}, client: Db = prisma) {
  const existing = await client.courierOperationalLocation.findFirst({
    where: { id: input.locationId, courierId: input.courierId },
    include: { linkedGstin: true }
  });
  if (!existing) throw new HttpError(404, "COURIER_LOCATION_NOT_FOUND");

  const next = {
    label: input.patch.label !== undefined ? cleanTextRequired(input.patch.label, "PICKUP_LABEL_REQUIRED") : existing.label,
    contactName: input.patch.contactName !== undefined ? cleanTextRequired(input.patch.contactName, "PICKUP_CONTACT_REQUIRED") : existing.contactName,
    phone: input.patch.phone !== undefined ? cleanPhone(input.patch.phone) : existing.phone,
    email: input.patch.email !== undefined ? cleanEmail(input.patch.email) : existing.email,
    addressLine1: input.patch.addressLine1 !== undefined ? cleanTextRequired(input.patch.addressLine1, "PICKUP_ADDRESS_REQUIRED") : existing.addressLine1,
    addressLine2: input.patch.addressLine2 !== undefined ? normalizeOptionalText(input.patch.addressLine2) : existing.addressLine2,
    city: input.patch.city !== undefined ? cleanTextRequired(input.patch.city, "PICKUP_CITY_REQUIRED") : existing.city,
    state: input.patch.state !== undefined ? normalizeState(input.patch.state) : existing.state,
    pincode: input.patch.pincode !== undefined ? normalizePincode(input.patch.pincode) : existing.pincode,
    isDefault: input.patch.isDefault !== undefined ? Boolean(input.patch.isDefault) : existing.isDefault
  };

  const verified = await findVerifiedCourierGstin(input.courierId, next.state, client);
  const requestedStatus = normalizeCourierOfficeStatus(input.patch.status);
  if (requestedStatus === PickupPointStatus.APPROVED && !verified) {
    await writeTaxAudit({
      ownerType: "courier",
      ownerId: input.courierId,
      actorId: input.actorId,
      action: "COURIER_LOCATION_APPROVE_BLOCKED_STATE_GSTIN_MISMATCH",
      entityType: "courier_operational_location",
      entityId: existing.id,
      metadata: {
        courierId: input.courierId,
        state: next.state,
        previousLinkedGstinId: existing.linkedGstinId
      }
    }, client);
    throw new HttpError(400, "COURIER_LOCATION_STATE_GSTIN_REQUIRED");
  }

  const nextStatus = verified
    ? requestedStatus || (existing.status === PickupPointStatus.REQUIRE_STATE_GSTIN || existing.status === PickupPointStatus.PENDING ? PickupPointStatus.PENDING_REVIEW : existing.status)
    : PickupPointStatus.REQUIRE_STATE_GSTIN;
  const blockerReason = verified ? null : blockerForState(next.state);

  if (next.isDefault) {
    await client.courierOperationalLocation.updateMany({
      where: { courierId: input.courierId, id: { not: existing.id } },
      data: { isDefault: false }
    });
  }

  const record = await client.courierOperationalLocation.update({
    where: { id: existing.id },
    data: {
      ...next,
      linkedGstinId: verified?.id || null,
      status: nextStatus,
      blockerReason,
      approvedAt: nextStatus === PickupPointStatus.APPROVED ? new Date() : existing.approvedAt,
      approvedBy: nextStatus === PickupPointStatus.APPROVED ? input.actorId || null : existing.approvedBy,
      rejectedAt: nextStatus === PickupPointStatus.REJECTED ? new Date() : existing.rejectedAt,
      rejectedBy: nextStatus === PickupPointStatus.REJECTED ? input.actorId || null : existing.rejectedBy,
      rejectionReason: nextStatus === PickupPointStatus.REJECTED ? normalizeOptionalText(input.patch.rejectionReason) : existing.rejectionReason
    },
    include: { linkedGstin: true }
  });

  await writeTaxAudit({
    ownerType: "courier",
    ownerId: input.courierId,
    actorId: input.actorId,
    action: "COURIER_OPERATIONAL_OFFICE_UPDATED",
    entityType: "courier_operational_location",
    entityId: record.id,
    metadata: {
      courierId: input.courierId,
      before: {
        state: existing.state,
        status: existing.status,
        linkedGstinId: existing.linkedGstinId
      },
      after: {
        state: record.state,
        status: record.status,
        linkedGstinId: record.linkedGstinId
      },
      linkedGstinChanged: existing.linkedGstinId !== record.linkedGstinId
    }
  }, client);

  if (existing.status !== record.status && record.status === PickupPointStatus.APPROVED) {
    await writeTaxAudit({
      ownerType: "courier",
      ownerId: input.courierId,
      actorId: input.actorId,
      action: "COURIER_OPERATIONAL_OFFICE_APPROVED",
      entityType: "courier_operational_location",
      entityId: record.id,
      metadata: {
        courierId: input.courierId,
        state: record.state,
        linkedGstinId: record.linkedGstinId
      }
    }, client);
  }

  if (existing.status !== record.status && record.status === PickupPointStatus.REJECTED) {
    await writeTaxAudit({
      ownerType: "courier",
      ownerId: input.courierId,
      actorId: input.actorId,
      action: "COURIER_OPERATIONAL_OFFICE_REJECTED",
      entityType: "courier_operational_location",
      entityId: record.id,
      metadata: {
        courierId: input.courierId,
        state: record.state,
        linkedGstinId: record.linkedGstinId,
        reason: record.rejectionReason
      }
    }, client);
  }

  if (existing.status !== record.status && record.status === PickupPointStatus.HOLD) {
    await writeTaxAudit({
      ownerType: "courier",
      ownerId: input.courierId,
      actorId: input.actorId,
      action: "COURIER_OPERATIONAL_OFFICE_HELD",
      entityType: "courier_operational_location",
      entityId: record.id,
      metadata: {
        courierId: input.courierId,
        state: record.state,
        linkedGstinId: record.linkedGstinId
      }
    }, client);
  }

  if (!verified) {
    await writeTaxAudit({
      ownerType: "courier",
      ownerId: input.courierId,
      actorId: input.actorId,
      action: "COURIER_LOCATION_STATE_GSTIN_MISMATCH",
      entityType: "courier_operational_location",
      entityId: record.id,
      metadata: {
        courierId: input.courierId,
        state: record.state,
        status: record.status,
        blockerReason
      }
    }, client);
  }

  return locationResponse(record);
}

export async function getCourierActivationReadiness(courierId: string, client: Db = prisma) {
  const [courier, gstins, locations, rateCardCount, serviceablePincodeCount] = await Promise.all([
    client.courierPartner.findUnique({
      where: { id: courierId },
      select: { id: true, gstin: true, bookingMode: true }
    }),
    client.courierGstinRecord.findMany({
      where: { courierId },
      orderBy: [{ verificationStatus: "asc" }, { registeredState: "asc" }, { createdAt: "desc" }]
    }),
    client.courierOperationalLocation.findMany({
      where: { courierId },
      include: { linkedGstin: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }]
    }),
    client.rateCard.count({ where: { courierId } }),
    client.courierServiceablePincode.count({ where: { courierId, active: true } })
  ]);

  const issues: Array<{
    code: string;
    message: string;
    entityId?: string;
  }> = [];
  if (!courier?.gstin) {
    issues.push({
      code: "COURIER_GSTIN_REQUIRED",
      message: "Courier partner GSTIN is mandatory."
    });
  }

  const verifiedGstins = gstins.filter((record) => (
    record.verificationStatus === AccountGstinVerificationStatus.VERIFIED &&
    !isBlockedGstinRegistrationStatus(record.registrationStatus)
  ));
  if (!verifiedGstins.length) {
    issues.push({
      code: "COURIER_VERIFIED_GSTIN_REQUIRED",
      message: "At least one courier GSTIN must be verified and active."
    });
  }

  const blockedVerifiedGstins = gstins.filter((record) => (
    record.verificationStatus === AccountGstinVerificationStatus.VERIFIED &&
    isBlockedGstinRegistrationStatus(record.registrationStatus)
  ));
  for (const record of blockedVerifiedGstins) {
    issues.push({
      code: "COURIER_GSTIN_REGISTRATION_STATUS_BLOCKED",
      message: "Verified GSTIN has inactive, cancelled, or suspended registration status.",
      entityId: record.id
    });
  }

  const approvedLocations = locations.filter((location) => location.status === PickupPointStatus.APPROVED);
  if (!approvedLocations.length) {
    issues.push({
      code: "COURIER_APPROVED_OPERATIONAL_OFFICE_REQUIRED",
      message: "At least one operational office must be approved."
    });
  }

  for (const location of approvedLocations) {
    if (
      !location.linkedGstinId ||
      !location.linkedGstin ||
      location.linkedGstin.verificationStatus !== AccountGstinVerificationStatus.VERIFIED ||
      location.linkedGstin.registeredState !== location.state ||
      isBlockedGstinRegistrationStatus(location.linkedGstin.registrationStatus)
    ) {
      issues.push({
        code: "COURIER_ACTIVE_OFFICE_STATE_GSTIN_REQUIRED",
        message: "Every active courier operational office must link to a same-state verified GSTIN.",
        entityId: location.id
      });
    }
  }

  if (!rateCardCount) {
    issues.push({
      code: "COURIER_RATE_CARD_REQUIRED",
      message: "At least one courier rate card must exist before LIVE activation."
    });
  }

  if (!serviceablePincodeCount) {
    issues.push({
      code: "COURIER_SERVICEABLE_PINCODES_REQUIRED",
      message: "At least one active serviceable pincode must exist before LIVE activation."
    });
  }

  if (!courier?.bookingMode) {
    issues.push({
      code: "COURIER_BOOKING_MODE_REQUIRED",
      message: "Courier booking mode must be selected before LIVE activation."
    });
  }

  return {
    ready: issues.length === 0,
    issues,
    verifiedGstinCount: verifiedGstins.length,
    approvedOfficeCount: approvedLocations.length,
    rateCardCount,
    serviceablePincodeCount,
    bookingMode: courier?.bookingMode || null
  };
}
