import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { HttpError } from "../../lib/httpError.js";

export type PhoneVerificationProvider = "otp" | "truecaller";

export type VerificationHandle = {
  provider: PhoneVerificationProvider;
  verificationHandle: string;
  expiresAt: Date;
};

export type VerifiedPhone = {
  e164?: string | undefined;
  phoneHash: string;
  phoneLast2: string;
  profile?: { name?: string | undefined; email?: string | undefined } | undefined;
  provider: PhoneVerificationProvider;
};

export type PhoneVerifierStartContext = {
  phoneHash: string;
  phoneLast2: string;
  now: Date;
  expiresAt: Date;
};

export type PhoneVerifierConfirmContext = {
  phoneHash: string;
  phoneLast2: string;
  now: Date;
  expiresAt: Date;
};

export interface PhoneVerifier {
  start(phone: string, ctx: PhoneVerifierStartContext): Promise<VerificationHandle>;
  confirm(handle: string, proof: string, ctx: PhoneVerifierConfirmContext): Promise<VerifiedPhone>;
}

const OTP_HANDLE_VERSION = "a2-otp";
const DEV_OTP_HANDLE_SECRET = "checkout-address-otp-handle-secret-development-only";

function isRelaxedNodeEnv() {
  return process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development" || !process.env.NODE_ENV;
}

function handleSecret() {
  const secret = process.env.CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET?.trim();
  if (secret) return secret;
  if (isRelaxedNodeEnv()) return DEV_OTP_HANDLE_SECRET;
  throw new HttpError(500, "CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET_REQUIRED");
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signPayload(payload: string) {
  return createHmac("sha256", handleSecret()).update(payload).digest("base64url");
}

function verifySignedPayload(handle: string) {
  const parts = handle.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;
  const expected = signPayload(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function hashVerificationHandle(handle: string) {
  return createHash("sha256").update(handle).digest("hex");
}

function expectedOtpProof() {
  const configured = process.env.CHECKOUT_DEV_OTP_CODE?.trim();
  if (configured) return configured;
  if (isRelaxedNodeEnv()) return "000000";
  throw new HttpError(503, "CHECKOUT_OTP_NOT_CONFIGURED");
}

export class OtpVerifier implements PhoneVerifier {
  private readonly consumedHandleHashes = new Set<string>();

  async start(_phone: string, ctx: PhoneVerifierStartContext): Promise<VerificationHandle> {
    const payload = base64urlJson({
      v: OTP_HANDLE_VERSION,
      provider: "otp",
      phoneHash: ctx.phoneHash,
      phoneLast2: ctx.phoneLast2,
      exp: ctx.expiresAt.toISOString(),
      nonce: randomUUID()
    });
    return {
      provider: "otp",
      verificationHandle: `${payload}.${signPayload(payload)}`,
      expiresAt: ctx.expiresAt
    };
  }

  async confirm(handle: string, proof: string, ctx: PhoneVerifierConfirmContext): Promise<VerifiedPhone> {
    const handleHash = hashVerificationHandle(handle);
    if (this.consumedHandleHashes.has(handleHash)) throw new HttpError(409, "CHECKOUT_VERIFICATION_HANDLE_CONSUMED");

    const payload = verifySignedPayload(handle);
    if (!payload || payload.v !== OTP_HANDLE_VERSION || payload.provider !== "otp") {
      throw new HttpError(400, "CHECKOUT_VERIFICATION_HANDLE_INVALID");
    }
    if (payload.phoneHash !== ctx.phoneHash || payload.phoneLast2 !== ctx.phoneLast2) {
      throw new HttpError(400, "CHECKOUT_VERIFICATION_HANDLE_INVALID");
    }

    const expiresAt = new Date(String(payload.exp ?? ""));
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= ctx.now.getTime() || ctx.expiresAt.getTime() <= ctx.now.getTime()) {
      throw new HttpError(410, "CHECKOUT_VERIFICATION_HANDLE_EXPIRED");
    }

    if (proof.trim() !== expectedOtpProof()) {
      throw new HttpError(400, "CHECKOUT_OTP_INVALID");
    }

    this.consumedHandleHashes.add(handleHash);
    return {
      provider: "otp",
      phoneHash: ctx.phoneHash,
      phoneLast2: ctx.phoneLast2
    };
  }
}

export class TruecallerVerifier implements PhoneVerifier {
  externalCalls = 0;

  async start(_phone: string, _ctx: PhoneVerifierStartContext): Promise<VerificationHandle> {
    throw new HttpError(503, "TRUECALLER_NOT_CONFIGURED", { fallbackAvailable: true });
  }

  async confirm(_handle: string, _proof: string, _ctx: PhoneVerifierConfirmContext): Promise<VerifiedPhone> {
    throw new HttpError(503, "TRUECALLER_NOT_CONFIGURED", { fallbackAvailable: true });
  }
}
