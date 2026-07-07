import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { HttpError } from "../../lib/httpError.js";

const TOKEN_VERSION = "a2";
const DEV_TOKEN_SECRET = "checkout-address-session-token-secret-development-only";

export type CheckoutAddressSessionTokenPayload = {
  v: typeof TOKEN_VERSION;
  sid: string;
  exp: string;
  nonce: string;
};

function isRelaxedNodeEnv() {
  return process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development" || !process.env.NODE_ENV;
}

function checkoutAddressSessionTokenSecret() {
  const secret = process.env.CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET?.trim();
  if (secret) return secret;
  if (isRelaxedNodeEnv()) return DEV_TOKEN_SECRET;
  throw new HttpError(500, "CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET_REQUIRED");
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signPayload(payload: string) {
  return createHmac("sha256", checkoutAddressSessionTokenSecret()).update(payload).digest("base64url");
}

export function hashCheckoutAddressSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createCheckoutAddressSessionToken(input: {
  sessionId: string;
  expiresAt: Date;
  nonce?: string | undefined;
}) {
  const payload = base64urlJson({
    v: TOKEN_VERSION,
    sid: input.sessionId,
    exp: input.expiresAt.toISOString(),
    nonce: input.nonce || randomUUID()
  } satisfies CheckoutAddressSessionTokenPayload);
  return `${payload}.${signPayload(payload)}`;
}

export function verifyCheckoutAddressSessionToken(token: string): CheckoutAddressSessionTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;
  const expected = signPayload(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CheckoutAddressSessionTokenPayload;
    if (parsed.v !== TOKEN_VERSION || !parsed.sid || !parsed.exp || !parsed.nonce) return null;
    const expiresAt = new Date(parsed.exp);
    if (Number.isNaN(expiresAt.getTime())) return null;
    return parsed;
  } catch {
    return null;
  }
}
