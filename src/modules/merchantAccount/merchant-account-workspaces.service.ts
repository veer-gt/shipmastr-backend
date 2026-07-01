import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { markAddressForGeocoding } from "../addressGeocoding/address-geocoding.service.js";
import { listMerchantTaxProfile } from "../taxCompliance/tax-compliance.service.js";

type DbClient = typeof prisma | Record<string, any>;

type WarehouseInput = {
  name: string;
  contactName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string | null | undefined;
  city: string;
  state: string;
  pincode: string;
  country?: string | null | undefined;
  notes?: string | null | undefined;
  isPrimary?: boolean | undefined;
  isActive?: boolean | undefined;
  googlePlaceId?: string | null | undefined;
};

type CustomerInput = {
  name: string;
  phone: string;
  email?: string | null | undefined;
  addressLine1: string;
  addressLine2?: string | null | undefined;
  city: string;
  state: string;
  pincode: string;
  country?: string | null | undefined;
  isActive?: boolean | undefined;
};

type WarehousePatch = Record<string, unknown>;
type CustomerPatch = Record<string, unknown>;

function cleanText(value: unknown, code: string, max = 240) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) throw new HttpError(400, code);
  return cleaned.slice(0, max);
}

function cleanOptionalText(value: unknown, max = 500) {
  const cleaned = String(value ?? "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function cleanPhone(value: unknown) {
  const phone = String(value ?? "").replace(/[^\d+]/g, "").trim();
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) throw new HttpError(400, "MERCHANT_PHONE_INVALID");
  return phone.slice(0, 20);
}

function cleanPincode(value: unknown) {
  const pincode = String(value ?? "").trim();
  if (!/^\d{6}$/.test(pincode)) throw new HttpError(400, "MERCHANT_PINCODE_INVALID");
  return pincode;
}

function cleanCountry(value: unknown) {
  const country = String(value || "IN").trim().toUpperCase();
  return country === "INDIA" ? "IN" : country.slice(0, 2) || "IN";
}

function cleanEmail(value: unknown) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "MERCHANT_CUSTOMER_EMAIL_INVALID");
  return email.slice(0, 240);
}

function cleanWarehouse(input: WarehouseInput) {
  return {
    name: cleanText(input.name, "MERCHANT_WAREHOUSE_NAME_REQUIRED"),
    contactName: cleanText(input.contactName, "MERCHANT_WAREHOUSE_CONTACT_REQUIRED"),
    phone: cleanPhone(input.phone),
    addressLine1: cleanText(input.addressLine1, "MERCHANT_WAREHOUSE_ADDRESS_REQUIRED", 500),
    addressLine2: cleanOptionalText(input.addressLine2, 500),
    city: cleanText(input.city, "MERCHANT_WAREHOUSE_CITY_REQUIRED", 160),
    state: cleanText(input.state, "MERCHANT_WAREHOUSE_STATE_REQUIRED", 120),
    pincode: cleanPincode(input.pincode),
    country: cleanCountry(input.country),
    notes: cleanOptionalText(input.notes, 800),
    isPrimary: Boolean(input.isPrimary),
    isActive: input.isActive !== undefined ? Boolean(input.isActive) : true,
    googlePlaceId: cleanOptionalText(input.googlePlaceId, 240)
  };
}

function cleanCustomer(input: CustomerInput) {
  return {
    name: cleanText(input.name, "MERCHANT_CUSTOMER_NAME_REQUIRED"),
    phone: cleanPhone(input.phone),
    email: cleanEmail(input.email),
    addressLine1: cleanText(input.addressLine1, "MERCHANT_CUSTOMER_ADDRESS_REQUIRED", 500),
    addressLine2: cleanOptionalText(input.addressLine2, 500),
    city: cleanText(input.city, "MERCHANT_CUSTOMER_CITY_REQUIRED", 160),
    state: cleanText(input.state, "MERCHANT_CUSTOMER_STATE_REQUIRED", 120),
    pincode: cleanPincode(input.pincode),
    country: cleanCountry(input.country),
    isActive: input.isActive !== undefined ? Boolean(input.isActive) : true
  };
}

function warehouseResponse(record: any) {
  return {
    id: record.id,
    name: record.name,
    contactName: record.contactName,
    phone: record.phone,
    addressLine1: record.addressLine1,
    addressLine2: record.addressLine2,
    city: record.city,
    state: record.state,
    pincode: record.pincode,
    country: record.country,
    notes: record.notes,
    isPrimary: record.isPrimary,
    isActive: record.isActive,
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

function customerResponse(record: any) {
  return {
    id: record.id,
    name: record.name,
    phone: record.phone,
    email: record.email,
    addressLine1: record.addressLine1,
    addressLine2: record.addressLine2,
    city: record.city,
    state: record.state,
    pincode: record.pincode,
    country: record.country,
    isActive: record.isActive,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export async function listMerchantWarehouses(merchantId: string, client: DbClient = prisma) {
  const rows = await (client as any).merchantWarehouse.findMany({
    where: { merchantId },
    orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }]
  });
  return rows.map(warehouseResponse);
}

export async function createMerchantWarehouse(merchantId: string, input: WarehouseInput, client: DbClient = prisma) {
  const data = cleanWarehouse(input);
  const { googlePlaceId, ...warehouseData } = data;
  if (data.isPrimary) {
    await (client as any).merchantWarehouse.updateMany({
      where: { merchantId },
      data: { isPrimary: false }
    });
  }
  const row = await (client as any).merchantWarehouse.create({
    data: { merchantId, ...warehouseData, googleGeocodePlaceId: googlePlaceId }
  });
  const geocodeState = await markAddressForGeocoding({
    entityType: "MERCHANT_WAREHOUSE",
    entityId: row.id,
    merchantId,
    address: {
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      state: row.state,
      pincode: row.pincode,
      country: row.country,
      googlePlaceId
    },
    previousAddressFingerprint: null
  }, client);
  return warehouseResponse({
    ...row,
    geocodeStatus: geocodeState.status,
    addressFingerprint: geocodeState.addressFingerprint
  });
}

export async function updateMerchantWarehouse(merchantId: string, warehouseId: string, input: WarehousePatch, client: DbClient = prisma) {
  const existing = await (client as any).merchantWarehouse.findFirst({
    where: { id: warehouseId, merchantId }
  });
  if (!existing) throw new HttpError(404, "MERCHANT_WAREHOUSE_NOT_FOUND");

  const data = cleanWarehouse({
    name: input.name ?? existing.name,
    contactName: input.contactName ?? existing.contactName,
    phone: input.phone ?? existing.phone,
    addressLine1: input.addressLine1 ?? existing.addressLine1,
    addressLine2: input.addressLine2 !== undefined ? input.addressLine2 : existing.addressLine2,
    city: input.city ?? existing.city,
    state: input.state ?? existing.state,
    pincode: input.pincode ?? existing.pincode,
    country: input.country ?? existing.country,
    notes: input.notes !== undefined ? input.notes : existing.notes,
    isPrimary: input.isPrimary !== undefined ? Boolean(input.isPrimary) : existing.isPrimary,
    isActive: input.isActive !== undefined ? Boolean(input.isActive) : existing.isActive,
    googlePlaceId: input.googlePlaceId !== undefined ? input.googlePlaceId as string | null | undefined : existing.googleGeocodePlaceId
  } as WarehouseInput);
  const { googlePlaceId, ...warehouseData } = data;

  if (data.isPrimary) {
    await (client as any).merchantWarehouse.updateMany({
      where: { merchantId, id: { not: existing.id } },
      data: { isPrimary: false }
    });
  }
  const row = await (client as any).merchantWarehouse.update({
    where: { id: existing.id },
    data: { ...warehouseData, googleGeocodePlaceId: googlePlaceId }
  });
  const geocodeState = await markAddressForGeocoding({
    entityType: "MERCHANT_WAREHOUSE",
    entityId: row.id,
    merchantId,
    address: {
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      state: row.state,
      pincode: row.pincode,
      country: row.country,
      googlePlaceId
    },
    previousAddressFingerprint: existing.addressFingerprint
  }, client);
  return warehouseResponse({
    ...row,
    geocodeStatus: geocodeState.status,
    addressFingerprint: geocodeState.addressFingerprint
  });
}

export async function listMerchantCustomers(merchantId: string, client: DbClient = prisma) {
  const rows = await (client as any).merchantCustomer.findMany({
    where: { merchantId },
    orderBy: [{ updatedAt: "desc" }]
  });
  return rows.map(customerResponse);
}

export async function createMerchantCustomer(merchantId: string, input: CustomerInput, client: DbClient = prisma) {
  const row = await (client as any).merchantCustomer.create({
    data: { merchantId, ...cleanCustomer(input) }
  });
  return customerResponse(row);
}

export async function updateMerchantCustomer(merchantId: string, customerId: string, input: CustomerPatch, client: DbClient = prisma) {
  const existing = await (client as any).merchantCustomer.findFirst({
    where: { id: customerId, merchantId }
  });
  if (!existing) throw new HttpError(404, "MERCHANT_CUSTOMER_NOT_FOUND");

  const row = await (client as any).merchantCustomer.update({
    where: { id: existing.id },
    data: cleanCustomer({
      name: input.name ?? existing.name,
      phone: input.phone ?? existing.phone,
      email: input.email !== undefined ? input.email : existing.email,
      addressLine1: input.addressLine1 ?? existing.addressLine1,
      addressLine2: input.addressLine2 !== undefined ? input.addressLine2 : existing.addressLine2,
      city: input.city ?? existing.city,
      state: input.state ?? existing.state,
      pincode: input.pincode ?? existing.pincode,
      country: input.country ?? existing.country,
      isActive: input.isActive !== undefined ? Boolean(input.isActive) : existing.isActive
    } as CustomerInput)
  });
  return customerResponse(row);
}

export async function buildMerchantSetupWorkspace(merchantId: string, client: DbClient = prisma) {
  const [merchant, taxProfile, warehouses, customers] = await Promise.all([
    (client as any).merchant.findUnique({
      where: { id: merchantId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        gstin: true,
        onboardingStatus: true,
        pickupAddressStatus: true,
        kycStatus: true,
        bankStatus: true,
        sellerKycStatus: true
      }
    }),
    listMerchantTaxProfile(merchantId, client as any),
    listMerchantWarehouses(merchantId, client),
    listMerchantCustomers(merchantId, client)
  ]);

  const pickupPoints = taxProfile.pickupPoints || [];
  const readiness = {
    businessProfile: merchant?.name ? "ready" : "needs_setup",
    kycTax: merchant?.kycStatus || merchant?.sellerKycStatus || "PENDING",
    bankCod: merchant?.bankStatus || "PENDING",
    pickups: pickupPoints.length > 0 ? "ready" : "needs_setup",
    warehouses: warehouses.length > 0 ? "ready" : "needs_setup",
    customers: customers.length > 0 ? "ready" : "needs_setup",
    roles: "read_only"
  };

  return {
    merchant: {
      id: merchantId,
      name: merchant?.name || "Shipmastr Merchant",
      email: merchant?.email || null,
      phone: merchant?.phone || null,
      gstin: merchant?.gstin || null,
      onboardingStatus: merchant?.onboardingStatus || null
    },
    readiness,
    counts: {
      pickupPoints: pickupPoints.length,
      warehouses: warehouses.length,
      customers: customers.length
    },
    pickupPoints,
    warehouses,
    customers
  };
}

export function assertMerchantWorkspaceResponseSafe(value: unknown) {
  const serialized = JSON.stringify(value);
  if (/(courierPartner|providerPickupId|providerCode|uploadUrl|signedUrl|objectKey|bucket|storage\.googleapis\.com|Bearer|DATABASE_URL|secret|token|cookie|auth header)/i.test(serialized)) {
    throw new Error("MERCHANT_WORKSPACE_UNSAFE_RESPONSE");
  }
}
