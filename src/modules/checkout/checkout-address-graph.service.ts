import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { logger } from "../../lib/logger.js";
import { addressPincodeService, type AddressPincodeResponse } from "../address/pincode.service.js";
import { requireVerifiedCheckoutSession, type VerifiedCheckoutSessionContext } from "./checkout-address-session.service.js";
import { recordAddressEventSafely, type AddressEventInput } from "./checkout-address-telemetry.service.js";

type DbClient = typeof prisma | any;
type VerifiedSessionResolver = (sessionToken: string) => Promise<VerifiedCheckoutSessionContext>;
type PincodeLookupService = { lookup(inputPin: unknown): Promise<AddressPincodeResponse> };
type AddressTelemetryRecorder = (input: AddressEventInput) => Promise<unknown>;

export const CHECKOUT_ADDRESS_SOURCES = ["manual", "places", "truecaller", "network_prefill"] as const;
export type CheckoutAddressSource = (typeof CHECKOUT_ADDRESS_SOURCES)[number];

export const ADDRESS_CONSENT_SCOPES = ["merchant", "network"] as const;
export type AddressConsentScope = (typeof ADDRESS_CONSENT_SCOPES)[number];

export type PersistCheckoutAddressPayload = {
  fullName?: unknown;
  line1?: unknown;
  line2?: unknown;
  landmark?: unknown;
  pincode?: unknown;
  city?: unknown;
  state?: unknown;
  lat?: unknown;
  lng?: unknown;
  placeId?: unknown;
  source?: unknown;
  quality?: unknown;
  consentScope?: unknown;
  consentTextVersion?: unknown;
};

export type AddressConsentInput = {
  shopperId: string;
  merchantId: string;
  scope: AddressConsentScope;
  consentTextVersion: string;
  purpose?: string | undefined;
  expiresAt?: Date | null | undefined;
};

function cleanRequiredText(value: unknown, code: string, max = 240) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new HttpError(400, code);
  return text;
}

function cleanOptionalText(value: unknown, max = 240) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new HttpError(400, "CHECKOUT_ADDRESS_FIELD_INVALID");
  return text;
}

function cleanPincode(value: unknown) {
  const pincode = String(value ?? "").trim();
  if (!/^\d{6}$/.test(pincode)) throw new HttpError(400, "CHECKOUT_ADDRESS_PINCODE_INVALID");
  return pincode;
}

function cleanSource(value: unknown): CheckoutAddressSource {
  const source = String(value ?? "manual").trim();
  if (!CHECKOUT_ADDRESS_SOURCES.includes(source as CheckoutAddressSource)) {
    throw new HttpError(400, "CHECKOUT_ADDRESS_SOURCE_INVALID");
  }
  return source as CheckoutAddressSource;
}

function cleanConsentScope(value: unknown): AddressConsentScope {
  const scope = String(value ?? "merchant").trim();
  if (!ADDRESS_CONSENT_SCOPES.includes(scope as AddressConsentScope)) {
    throw new HttpError(400, "CHECKOUT_ADDRESS_CONSENT_SCOPE_INVALID");
  }
  return scope as AddressConsentScope;
}

function cleanQuality(value: unknown) {
  if (value === undefined || value === null || value === "") return 0;
  const quality = Number(value);
  if (!Number.isInteger(quality) || quality < 0 || quality > 3) {
    throw new HttpError(400, "CHECKOUT_ADDRESS_QUALITY_INVALID");
  }
  return quality;
}

function cleanCoordinate(value: unknown, code: string, min: number, max: number) {
  if (value === undefined || value === null || value === "") return null;
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate) || coordinate < min || coordinate > max) {
    throw new HttpError(400, code);
  }
  return coordinate;
}

function assertNoIdentityPayload(payload: Record<string, unknown>) {
  for (const field of ["phone", "rawPhone", "e164", "phoneHash", "phoneLast2"]) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new HttpError(400, "CHECKOUT_ADDRESS_IDENTITY_PAYLOAD_FORBIDDEN");
    }
  }
}

export function normalizeCheckoutAddressLine1(value: unknown) {
  return cleanRequiredText(value, "CHECKOUT_ADDRESS_LINE1_REQUIRED", 500)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=_`~()[\]\\|+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPincodeNotFound(error: unknown) {
  return error instanceof HttpError && error.status === 404 && error.message === "PINCODE_NOT_FOUND";
}

async function resolvePincode(
  pincodeLookup: PincodeLookupService,
  pincode: string,
  cityInput: unknown,
  stateInput: unknown
) {
  const city = cleanOptionalText(cityInput, 120);
  const state = cleanOptionalText(stateInput, 120);

  try {
    const record = await pincodeLookup.lookup(pincode);
    return {
      city: city ?? record.city,
      state: state ?? record.state
    };
  } catch (error) {
    if (!isPincodeNotFound(error)) throw error;
    if (!city || !state) throw new HttpError(400, "CHECKOUT_ADDRESS_CITY_STATE_REQUIRED");
    return { city, state };
  }
}

function activeConsentWhere(shopperId: string, now: Date) {
  return {
    shopperId,
    scope: "network",
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
  };
}

export class CheckoutAddressGraphService {
  constructor(
    private readonly client: DbClient = prisma,
    private readonly verifiedSessionResolver: VerifiedSessionResolver = requireVerifiedCheckoutSession,
    private readonly pincodeLookup: PincodeLookupService = addressPincodeService,
    private readonly now: () => Date = () => new Date(),
    private readonly telemetryRecorder: AddressTelemetryRecorder = recordAddressEventSafely
  ) {}

  async upsertShopperIdentityFromVerifiedSession(ctx: VerifiedCheckoutSessionContext) {
    return this.upsertShopperIdentityWithClient(this.client, ctx);
  }

  async persistCheckoutAddress(sessionToken: string, payload: PersistCheckoutAddressPayload) {
    const ctx = await this.verifiedSessionResolver(sessionToken);
    const cleanPayload = this.validateAddressPayload(payload);
    const resolvedPincode = await resolvePincode(this.pincodeLookup, cleanPayload.pincode, payload.city, payload.state);

    const result = await this.withTransaction(async (client) => {
      const shopper = await this.upsertShopperIdentityWithClient(client, ctx);
      await this.createAddressConsentWithClient(client, {
        shopperId: shopper.id,
        merchantId: ctx.merchantId,
        scope: cleanPayload.consentScope,
        consentTextVersion: cleanPayload.consentTextVersion
      });
      const persisted = await this.persistAddressWithClient(client, shopper.id, ctx.merchantId, cleanPayload, resolvedPincode);
      return { ...persisted, shopperId: shopper.id };
    });

    try {
      await this.telemetryRecorder({
        sessionId: ctx.sessionId,
        shopperId: result.shopperId,
        merchantId: ctx.merchantId,
        event: "manual_completed",
        meta: {
          source: cleanPayload.source,
          quality: cleanPayload.quality,
          consentScope: cleanPayload.consentScope,
          deduped: result.deduped,
          pincode: cleanPayload.pincode
        }
      });
    } catch {
      logger.warn({ event: "manual_completed" }, "checkout_address_telemetry_record_failed");
    }

    return {
      addressId: result.addressId,
      deduped: result.deduped
    };
  }

  async createAddressConsent(input: AddressConsentInput) {
    return this.createAddressConsentWithClient(this.client, input);
  }

  async getActiveNetworkConsent(shopperId: string) {
    return this.client.addressConsent.findFirst({
      where: activeConsentWhere(shopperId, this.now()),
      orderBy: { grantedAt: "desc" }
    });
  }

  async isNetworkEligible(shopperId: string, merchantId: string) {
    const consent = await this.getActiveNetworkConsent(shopperId);
    return Boolean(consent && consent.merchantId !== merchantId);
  }

  async findNetworkEligibleAddressesForShopper(shopperId: string, currentMerchantId: string) {
    const consent = await this.getActiveNetworkConsent(shopperId);
    if (!consent || consent.merchantId === currentMerchantId) return [];

    return this.client.shopperAddress.findMany({
      where: {
        shopperId,
        firstMerchantId: { not: currentMerchantId }
      },
      orderBy: { lastUsedAt: "desc" }
    });
  }

  private validateAddressPayload(payload: PersistCheckoutAddressPayload) {
    const record = (payload ?? {}) as Record<string, unknown>;
    assertNoIdentityPayload(record);

    return {
      fullName: cleanRequiredText(record.fullName, "CHECKOUT_ADDRESS_FULL_NAME_REQUIRED", 180),
      line1: cleanRequiredText(record.line1, "CHECKOUT_ADDRESS_LINE1_REQUIRED", 500),
      line1Norm: normalizeCheckoutAddressLine1(record.line1),
      line2: cleanOptionalText(record.line2, 500),
      landmark: cleanOptionalText(record.landmark, 240),
      pincode: cleanPincode(record.pincode),
      lat: cleanCoordinate(record.lat, "CHECKOUT_ADDRESS_LAT_INVALID", -90, 90),
      lng: cleanCoordinate(record.lng, "CHECKOUT_ADDRESS_LNG_INVALID", -180, 180),
      placeId: cleanOptionalText(record.placeId, 240),
      source: cleanSource(record.source),
      quality: cleanQuality(record.quality),
      consentScope: cleanConsentScope(record.consentScope),
      consentTextVersion: cleanRequiredText(record.consentTextVersion, "CHECKOUT_ADDRESS_CONSENT_TEXT_VERSION_REQUIRED", 120)
    };
  }

  private async upsertShopperIdentityWithClient(client: DbClient, ctx: VerifiedCheckoutSessionContext) {
    return client.shopperIdentity.upsert({
      where: { phoneHash: ctx.phoneHash },
      create: {
        phoneHash: ctx.phoneHash,
        phoneLast2: ctx.phoneLast2,
        tcVerified: false
      },
      update: {
        phoneLast2: ctx.phoneLast2,
        lastSeenAt: this.now()
      }
    });
  }

  private async createAddressConsentWithClient(client: DbClient, input: AddressConsentInput) {
    return client.addressConsent.create({
      data: {
        shopperId: input.shopperId,
        merchantId: cleanRequiredText(input.merchantId, "CHECKOUT_ADDRESS_MERCHANT_REQUIRED", 160),
        scope: cleanConsentScope(input.scope),
        purpose: input.purpose ?? "checkout_prefill",
        consentTextVersion: cleanRequiredText(input.consentTextVersion, "CHECKOUT_ADDRESS_CONSENT_TEXT_VERSION_REQUIRED", 120),
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
        grantedAt: this.now()
      }
    });
  }

  private async persistAddressWithClient(
    client: DbClient,
    shopperId: string,
    merchantId: string,
    payload: ReturnType<CheckoutAddressGraphService["validateAddressPayload"]>,
    resolvedPincode: { city: string; state: string }
  ) {
    const existingRows = await client.shopperAddress.findMany({
      where: {
        shopperId,
        pincode: payload.pincode
      },
      orderBy: { lastUsedAt: "desc" }
    });
    const existing = existingRows.find((row: any) => row.line1Norm === payload.line1Norm);

    if (existing) {
      const updateData: Record<string, unknown> = {
        fullName: payload.fullName,
        city: resolvedPincode.city,
        state: resolvedPincode.state,
        source: payload.source,
        quality: Math.max(existing.quality ?? 0, payload.quality),
        useCount: { increment: 1 },
        lastUsedAt: this.now()
      };
      if (payload.line2 !== null) updateData.line2 = payload.line2;
      if (payload.landmark !== null) updateData.landmark = payload.landmark;
      if (payload.lat !== null) updateData.lat = payload.lat;
      if (payload.lng !== null) updateData.lng = payload.lng;
      if (payload.placeId !== null) updateData.placeId = payload.placeId;

      const updated = await client.shopperAddress.update({
        where: { id: existing.id },
        data: updateData
      });
      return { addressId: updated.id, deduped: true };
    }

    const created = await client.shopperAddress.create({
      data: {
        shopperId,
        fullName: payload.fullName,
        line1: payload.line1,
        line1Norm: payload.line1Norm,
        line2: payload.line2,
        landmark: payload.landmark,
        pincode: payload.pincode,
        city: resolvedPincode.city,
        state: resolvedPincode.state,
        lat: payload.lat,
        lng: payload.lng,
        placeId: payload.placeId,
        source: payload.source,
        quality: payload.quality,
        useCount: 1,
        lastUsedAt: this.now(),
        firstMerchantId: merchantId
      }
    });
    return { addressId: created.id, deduped: false };
  }

  private async withTransaction<T>(callback: (client: DbClient) => Promise<T>) {
    if (this.client.$transaction) return this.client.$transaction(callback);
    return callback(this.client);
  }
}

export const checkoutAddressGraphService = new CheckoutAddressGraphService();

export function upsertShopperIdentityFromVerifiedSession(ctx: VerifiedCheckoutSessionContext) {
  return checkoutAddressGraphService.upsertShopperIdentityFromVerifiedSession(ctx);
}

export function persistCheckoutAddress(sessionToken: string, payload: PersistCheckoutAddressPayload) {
  return checkoutAddressGraphService.persistCheckoutAddress(sessionToken, payload);
}

export function createAddressConsent(input: AddressConsentInput) {
  return checkoutAddressGraphService.createAddressConsent(input);
}

export function getActiveNetworkConsent(shopperId: string) {
  return checkoutAddressGraphService.getActiveNetworkConsent(shopperId);
}

export function isNetworkEligible(shopperId: string, merchantId: string) {
  return checkoutAddressGraphService.isNetworkEligible(shopperId, merchantId);
}

export function findNetworkEligibleAddressesForShopper(shopperId: string, currentMerchantId: string) {
  return checkoutAddressGraphService.findNetworkEligibleAddressesForShopper(shopperId, currentMerchantId);
}
