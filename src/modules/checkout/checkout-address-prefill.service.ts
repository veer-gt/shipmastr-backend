import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { HttpError } from "../../lib/httpError.js";
import { requireVerifiedCheckoutSession, type VerifiedCheckoutSessionContext } from "./checkout-address-session.service.js";
import { upsertShopperIdentityFromVerifiedSession } from "./checkout-address-graph.service.js";
import { recordAddressEventSafely, type AddressEventInput } from "./checkout-address-telemetry.service.js";

type DbClient = typeof prisma | any;
type VerifiedSessionResolver = (sessionToken: string) => Promise<VerifiedCheckoutSessionContext>;
type ShopperIdentityResolver = (ctx: VerifiedCheckoutSessionContext) => Promise<{ id: string }>;
type AddressTelemetryRecorder = (input: AddressEventInput) => Promise<unknown>;

function cleanRequiredText(value: unknown, code: string, max = 180) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new HttpError(400, code);
  return text;
}

function isoDate(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value ?? ""));
  if (Number.isNaN(parsed.getTime())) return new Date(0).toISOString();
  return parsed.toISOString();
}

function maskLine1(line1: unknown) {
  const text = String(line1 ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "Address...";
  const prefixLength = Math.min(10, Math.max(1, text.length - 1));
  return `${text.slice(0, prefixLength)}...`;
}

function serializeSummary(address: any) {
  return {
    id: address.id,
    fullName: address.fullName,
    maskedLine1: maskLine1(address.line1),
    pincode: address.pincode,
    city: address.city,
    state: address.state,
    lastUsedAt: isoDate(address.lastUsedAt),
    quality: address.quality,
    useCount: address.useCount
  };
}

function serializeSelectedAddress(address: any) {
  return {
    id: address.id,
    fullName: address.fullName,
    line1: address.line1,
    line2: address.line2 ?? null,
    landmark: address.landmark ?? null,
    pincode: address.pincode,
    city: address.city,
    state: address.state,
    source: address.source,
    quality: address.quality
  };
}

export class CheckoutAddressPrefillService {
  constructor(
    private readonly client: DbClient = prisma,
    private readonly verifiedSessionResolver: VerifiedSessionResolver = requireVerifiedCheckoutSession,
    private readonly shopperIdentityResolver: ShopperIdentityResolver = upsertShopperIdentityFromVerifiedSession,
    private readonly telemetryRecorder: AddressTelemetryRecorder = recordAddressEventSafely,
    private readonly now: () => Date = () => new Date()
  ) {}

  async getSameMerchantAddressBook(sessionToken: string) {
    const ctx = await this.verifiedSessionResolver(sessionToken);
    const shopper = await this.shopperIdentityResolver(ctx);
    const addresses = await this.client.shopperAddress.findMany({
      where: {
        shopperId: shopper.id,
        firstMerchantId: ctx.merchantId
      },
      orderBy: { lastUsedAt: "desc" }
    });

    if (addresses.length > 0) {
      await this.recordTelemetry({
        sessionId: ctx.sessionId,
        shopperId: shopper.id,
        merchantId: ctx.merchantId,
        event: "graph_hit_merchant",
        meta: { count: addresses.length, status: "hit" }
      });
      await this.recordTelemetry({
        sessionId: ctx.sessionId,
        shopperId: shopper.id,
        merchantId: ctx.merchantId,
        event: "prefill_offered",
        meta: { count: addresses.length, status: "offered" }
      });
    } else {
      await this.recordTelemetry({
        sessionId: ctx.sessionId,
        shopperId: shopper.id,
        merchantId: ctx.merchantId,
        event: "graph_miss",
        meta: { count: 0, status: "miss", reason: "same_merchant_address_not_found" }
      });
    }

    return {
      addresses: addresses.map(serializeSummary)
    };
  }

  async selectSameMerchantAddress(sessionToken: string, addressId: string) {
    const ctx = await this.verifiedSessionResolver(sessionToken);
    const shopper = await this.shopperIdentityResolver(ctx);
    const id = cleanRequiredText(addressId, "CHECKOUT_ADDRESS_ID_REQUIRED", 180);
    const address = await this.client.shopperAddress.findUnique({ where: { id } });

    if (!address || address.shopperId !== shopper.id || address.firstMerchantId !== ctx.merchantId) {
      throw new HttpError(404, "CHECKOUT_ADDRESS_PREFILL_NOT_FOUND");
    }

    const updated = await this.client.shopperAddress.update({
      where: { id: address.id },
      data: {
        useCount: { increment: 1 },
        lastUsedAt: this.now()
      }
    });

    await this.recordTelemetry({
      sessionId: ctx.sessionId,
      shopperId: shopper.id,
      merchantId: ctx.merchantId,
      event: "prefill_accepted",
      meta: { status: "accepted" }
    });

    return {
      address: serializeSelectedAddress(updated)
    };
  }

  async recordPrefillEditedForAddress(sessionToken: string, addressId: string) {
    const ctx = await this.verifiedSessionResolver(sessionToken);
    const shopper = await this.shopperIdentityResolver(ctx);
    const id = cleanRequiredText(addressId, "CHECKOUT_ADDRESS_ID_REQUIRED", 180);
    const address = await this.client.shopperAddress.findUnique({ where: { id } });
    if (!address || address.shopperId !== shopper.id || address.firstMerchantId !== ctx.merchantId) {
      throw new HttpError(404, "CHECKOUT_ADDRESS_PREFILL_NOT_FOUND");
    }
    await this.recordTelemetry({
      sessionId: ctx.sessionId,
      shopperId: shopper.id,
      merchantId: ctx.merchantId,
      event: "prefill_edited",
      meta: { status: "edited" }
    });
  }

  private async recordTelemetry(input: AddressEventInput) {
    try {
      await this.telemetryRecorder(input);
    } catch {
      logger.warn({ event: input.event }, "checkout_address_prefill_telemetry_failed");
    }
  }
}

export const checkoutAddressPrefillService = new CheckoutAddressPrefillService();
