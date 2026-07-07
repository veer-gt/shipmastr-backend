import { randomUUID } from "node:crypto";

import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { logger } from "../../lib/logger.js";
import { env } from "../../config/env.js";
import { getAddressPhonePepper, getPhoneLast2, hashAddressPhone, normalizeIndianPhone } from "../address/phone.service.js";
import {
  createCheckoutAddressSessionToken,
  hashCheckoutAddressSessionToken,
  verifyCheckoutAddressSessionToken
} from "./checkout-address-session-token.js";
import {
  hashVerificationHandle,
  OtpVerifier,
  TruecallerVerifier,
  type PhoneVerificationProvider,
  type PhoneVerifier
} from "./checkout-phone-verifier.js";
import { recordAddressEventSafely, type AddressEventInput } from "./checkout-address-telemetry.service.js";
import { runAddressNetworkShadowLookupForVerifiedSession } from "./checkout-address-network.service.js";

type DbClient = typeof prisma | any;
type AddressNetworkShadowLookup = (ctx: VerifiedCheckoutSessionContext) => Promise<unknown>;

export const CHECKOUT_ADDRESS_SESSION_STATUSES = ["created", "verification_started", "verified", "expired"] as const;
export type CheckoutAddressSessionStatus = (typeof CHECKOUT_ADDRESS_SESSION_STATUSES)[number];

export const CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER = "x-checkout-session-token";
export const CHECKOUT_ADDRESS_SESSION_TTL_MS = 30 * 60 * 1000;
export const CHECKOUT_ADDRESS_VERIFICATION_TTL_MS = 5 * 60 * 1000;
export const CHECKOUT_ADDRESS_MAX_VERIFICATION_ATTEMPTS = 5;

export type CreateCheckoutAddressSessionInput = {
  merchantId: string;
  cartId?: string | undefined;
};

export type StartCheckoutPhoneVerificationInput = {
  sessionToken: string;
  phone: string;
  provider: PhoneVerificationProvider;
};

export type ConfirmCheckoutPhoneVerificationInput = {
  sessionToken: string;
  verificationHandle: string;
  proof: string;
};

export type VerifiedCheckoutSessionContext = {
  sessionId: string;
  merchantId: string;
  cartId: string | null;
  phoneHash: string;
  phoneLast2: string;
  profileName: string | null;
};

export type CheckoutAddressSessionContext = {
  sessionId: string;
  merchantId: string;
  cartId: string | null;
  status: CheckoutAddressSessionStatus;
};

type AddressTelemetryRecorder = (input: AddressEventInput) => Promise<unknown>;

function cleanRequiredText(value: unknown, code: string, max = 180) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new HttpError(400, code);
  return text;
}

function cleanOptionalText(value: unknown, max = 180) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > max) throw new HttpError(400, "CHECKOUT_ADDRESS_SESSION_FIELD_INVALID");
  return text;
}

function ensureStatus(value: string): CheckoutAddressSessionStatus {
  if (!CHECKOUT_ADDRESS_SESSION_STATUSES.includes(value as CheckoutAddressSessionStatus)) {
    throw new HttpError(500, "CHECKOUT_ADDRESS_SESSION_STATUS_INVALID");
  }
  return value as CheckoutAddressSessionStatus;
}

export class CheckoutAddressSessionService {
  constructor(
    private readonly client: DbClient = prisma,
    private readonly now: () => Date = () => new Date(),
    private readonly otpVerifier: PhoneVerifier = new OtpVerifier(),
    private readonly truecallerVerifier: PhoneVerifier = new TruecallerVerifier(),
    private readonly telemetryRecorder: AddressTelemetryRecorder = recordAddressEventSafely,
    private readonly addressNetworkShadowLookup: AddressNetworkShadowLookup = runAddressNetworkShadowLookupForVerifiedSession,
    private readonly addressNetworkShadowEnabled: () => boolean = () => env.ADDRESS_NETWORK_SHADOW_ENABLED
  ) {}

  async createSession(input: CreateCheckoutAddressSessionInput) {
    const merchantId = cleanRequiredText(input.merchantId, "CHECKOUT_ADDRESS_MERCHANT_REQUIRED", 160);
    const cartId = cleanOptionalText(input.cartId, 160);
    if (this.client.merchant?.findUnique) {
      const merchant = await this.client.merchant.findUnique({ where: { id: merchantId }, select: { id: true } });
      if (!merchant) throw new HttpError(404, "MERCHANT_NOT_FOUND");
    }

    const sessionId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + CHECKOUT_ADDRESS_SESSION_TTL_MS);
    const sessionToken = createCheckoutAddressSessionToken({ sessionId, expiresAt });

    await this.client.checkoutAddressSession.create({
      data: {
        id: sessionId,
        tokenHash: hashCheckoutAddressSessionToken(sessionToken),
        merchantId,
        cartId,
        status: "created",
        expiresAt
      }
    });

    return {
      sessionToken,
      expiresAt,
      status: "created" as const
    };
  }

  async startPhoneVerification(input: StartCheckoutPhoneVerificationInput) {
    const session = await this.requireActiveSession(input.sessionToken);

    if (input.provider === "truecaller") {
      return {
        provider: "truecaller" as const,
        available: false,
        error: "TRUECALLER_NOT_CONFIGURED",
        fallbackAvailable: true
      };
    }

    if (input.provider !== "otp") throw new HttpError(400, "CHECKOUT_PHONE_PROVIDER_INVALID");

    const e164 = normalizeIndianPhone(input.phone);
    const phoneHash = hashAddressPhone(e164, getAddressPhonePepper());
    const phoneLast2 = getPhoneLast2(e164);
    const expiresAt = new Date(this.now().getTime() + CHECKOUT_ADDRESS_VERIFICATION_TTL_MS);
    const handle = await this.otpVerifier.start(e164, {
      phoneHash,
      phoneLast2,
      now: this.now(),
      expiresAt
    });

    await this.client.checkoutAddressSession.update({
      where: { id: session.id },
      data: {
        status: "verification_started",
        provider: "otp",
        verificationHandleHash: hashVerificationHandle(handle.verificationHandle),
        verificationExpiresAt: handle.expiresAt,
        verificationAttempts: 0,
        phoneHash,
        phoneLast2,
        profileName: null,
        verifiedAt: null
      }
    });

    return {
      verificationHandle: handle.verificationHandle,
      provider: handle.provider,
      expiresAt: handle.expiresAt,
      fallbackAvailable: true
    };
  }

  async confirmPhoneVerification(input: ConfirmCheckoutPhoneVerificationInput) {
    const session = await this.requireActiveSession(input.sessionToken);
    if (ensureStatus(session.status) !== "verification_started") {
      throw new HttpError(409, "CHECKOUT_VERIFICATION_NOT_STARTED");
    }
    if (!session.phoneHash || !session.phoneLast2 || !session.verificationHandleHash || !session.verificationExpiresAt) {
      throw new HttpError(409, "CHECKOUT_VERIFICATION_NOT_STARTED");
    }
    if (session.verificationAttempts >= CHECKOUT_ADDRESS_MAX_VERIFICATION_ATTEMPTS) {
      throw new HttpError(429, "CHECKOUT_VERIFICATION_ATTEMPTS_EXCEEDED");
    }
    if (session.verificationExpiresAt.getTime() <= this.now().getTime()) {
      await this.markExpired(session.id);
      throw new HttpError(410, "CHECKOUT_VERIFICATION_HANDLE_EXPIRED");
    }
    if (hashVerificationHandle(input.verificationHandle) !== session.verificationHandleHash) {
      await this.incrementAttempts(session);
      throw new HttpError(400, "CHECKOUT_VERIFICATION_HANDLE_INVALID");
    }

    try {
      const verified = await this.otpVerifier.confirm(input.verificationHandle, input.proof, {
        phoneHash: session.phoneHash,
        phoneLast2: session.phoneLast2,
        now: this.now(),
        expiresAt: session.verificationExpiresAt
      });
      const profileName = cleanOptionalText(verified.profile?.name, 180);
      await this.client.checkoutAddressSession.update({
        where: { id: session.id },
        data: {
          status: "verified",
          provider: verified.provider,
          phoneHash: verified.phoneHash,
          phoneLast2: verified.phoneLast2,
          profileName,
          verifiedAt: this.now()
        }
      });
      try {
        await this.telemetryRecorder({
          sessionId: session.id,
          merchantId: session.merchantId,
          event: "phone_verified",
          meta: { provider: verified.provider }
        });
      } catch {
        logger.warn({ event: "phone_verified" }, "checkout_address_telemetry_record_failed");
      }
      await this.runAddressNetworkShadowLookupSafely({
        sessionId: session.id,
        merchantId: session.merchantId,
        cartId: session.cartId ?? null,
        phoneHash: verified.phoneHash,
        phoneLast2: verified.phoneLast2,
        profileName
      });

      return {
        verified: true as const,
        phoneLast2: verified.phoneLast2,
        profile: profileName ? { name: profileName } : undefined
      };
    } catch (error) {
      if (error instanceof HttpError && error.message === "CHECKOUT_OTP_INVALID") {
        await this.incrementAttempts(session);
      }
      throw error;
    }
  }

  async requireCheckoutAddressSession(sessionToken: string): Promise<CheckoutAddressSessionContext> {
    const session = await this.requireActiveSession(sessionToken);
    return {
      sessionId: session.id,
      merchantId: session.merchantId,
      cartId: session.cartId ?? null,
      status: ensureStatus(session.status)
    };
  }

  async requireVerifiedCheckoutSession(sessionToken: string): Promise<VerifiedCheckoutSessionContext> {
    const session = await this.requireActiveSession(sessionToken);
    if (ensureStatus(session.status) !== "verified") throw new HttpError(401, "CHECKOUT_SESSION_NOT_VERIFIED");
    if (!session.phoneHash || !session.phoneLast2) throw new HttpError(409, "CHECKOUT_SESSION_PHONE_NOT_VERIFIED");
    return {
      sessionId: session.id,
      merchantId: session.merchantId,
      cartId: session.cartId ?? null,
      phoneHash: session.phoneHash,
      phoneLast2: session.phoneLast2,
      profileName: session.profileName ?? null
    };
  }

  private async requireActiveSession(sessionToken: string) {
    const token = sessionToken?.trim();
    if (!token) throw new HttpError(401, "CHECKOUT_SESSION_TOKEN_REQUIRED");

    const payload = verifyCheckoutAddressSessionToken(token);
    if (!payload) throw new HttpError(401, "CHECKOUT_SESSION_TOKEN_INVALID");
    if (new Date(payload.exp).getTime() <= this.now().getTime()) {
      throw new HttpError(401, "CHECKOUT_SESSION_EXPIRED");
    }

    const session = await this.client.checkoutAddressSession.findUnique({
      where: { tokenHash: hashCheckoutAddressSessionToken(token) }
    });
    if (!session || session.id !== payload.sid) throw new HttpError(401, "CHECKOUT_SESSION_TOKEN_INVALID");
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      await this.markExpired(session.id);
      throw new HttpError(401, "CHECKOUT_SESSION_EXPIRED");
    }
    if (session.status === "expired") throw new HttpError(401, "CHECKOUT_SESSION_EXPIRED");
    return session;
  }

  private async incrementAttempts(session: { id: string; verificationAttempts: number }) {
    await this.client.checkoutAddressSession.update({
      where: { id: session.id },
      data: { verificationAttempts: session.verificationAttempts + 1 }
    });
  }

  private async markExpired(sessionId: string) {
    await this.client.checkoutAddressSession.update({
      where: { id: sessionId },
      data: { status: "expired" }
    });
  }

  private async runAddressNetworkShadowLookupSafely(ctx: VerifiedCheckoutSessionContext) {
    if (!this.addressNetworkShadowEnabled()) return;
    try {
      await this.addressNetworkShadowLookup(ctx);
    } catch {
      logger.warn("checkout_address_network_shadow_hook_failed");
    }
  }
}

export const checkoutAddressSessionService = new CheckoutAddressSessionService();

export function requireVerifiedCheckoutSession(sessionToken: string) {
  return checkoutAddressSessionService.requireVerifiedCheckoutSession(sessionToken);
}

export function requireCheckoutAddressSession(sessionToken: string) {
  return checkoutAddressSessionService.requireCheckoutAddressSession(sessionToken);
}
