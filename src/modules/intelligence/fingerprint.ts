import { createHash } from "node:crypto";
import { env } from "../../config/env.js";

export type FingerprintOrder = {
  buyerPhone: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  pincode: string;
};

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
}

export function phoneHash(value: string) {
  return hash(`${normalizePhone(value)}${env.APP_SECRET_PEPPER}`);
}

export function normalizedAddress(order: FingerprintOrder) {
  return [
    order.addressLine1,
    order.addressLine2 || "",
    order.city,
    order.state,
    order.pincode
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function addressHash(order: FingerprintOrder) {
  return hash(`address:${normalizedAddress(order)}`);
}
