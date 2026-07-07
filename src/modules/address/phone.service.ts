import { createHash } from "node:crypto";

import { HttpError } from "../../lib/httpError.js";

const DEV_ADDRESS_PHONE_PEPPER = "address-phone-pepper-development-only";

function isRelaxedNodeEnv() {
  return process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development" || !process.env.NODE_ENV;
}

export function getAddressPhonePepper() {
  const pepper = process.env.ADDRESS_PHONE_PEPPER?.trim();
  if (pepper) return pepper;
  if (isRelaxedNodeEnv()) return DEV_ADDRESS_PHONE_PEPPER;
  throw new HttpError(500, "ADDRESS_PHONE_PEPPER_REQUIRED");
}

export function normalizeIndianPhone(input: unknown) {
  const compact = String(input ?? "").trim().replace(/[\s().-]/g, "");
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;

  let national = digits;
  if (/^91\d{10}$/.test(digits)) national = digits.slice(2);

  if (!/^[6-9]\d{9}$/.test(national)) {
    throw new HttpError(400, "ADDRESS_PHONE_INVALID");
  }

  return `+91${national}`;
}

export function hashAddressPhone(e164: string, pepper = getAddressPhonePepper()) {
  return createHash("sha256").update(`${e164}${pepper}`).digest("hex");
}

export function getPhoneLast2(e164: string) {
  const digits = e164.replace(/\D/g, "");
  if (digits.length < 2) throw new HttpError(400, "ADDRESS_PHONE_INVALID");
  return digits.slice(-2);
}
