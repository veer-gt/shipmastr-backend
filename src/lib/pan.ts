import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { HttpError } from "./httpError.js";

export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PAN_TEXT_PATTERN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi;

function encryptionKey() {
  return createHash("sha256")
    .update(`${env.APP_SECRET_PEPPER}:${env.JWT_SECRET}:seller-pan-v1`)
    .digest();
}

export function normalizeOptionalPan(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const normalized = trimmed.toUpperCase();
  if (!PAN_PATTERN.test(normalized)) {
    throw new HttpError(400, "INVALID_PAN");
  }

  return normalized;
}

export function maskPan(value: string) {
  return `*****${value.slice(5)}`;
}

export function encryptPan(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

  return {
    panEncrypted: encrypted.toString("base64"),
    panIv: iv.toString("base64"),
    panAuthTag: cipher.getAuthTag().toString("base64"),
    panMasked: maskPan(value)
  };
}

export function decryptPan(input: {
  panEncrypted: string;
  panIv: string;
  panAuthTag: string;
}) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(input.panIv, "base64"));
  decipher.setAuthTag(Buffer.from(input.panAuthTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(input.panEncrypted, "base64")),
    decipher.final()
  ]).toString("utf8");
}

export function redactPanText(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  return trimmed.replace(PAN_TEXT_PATTERN, "[redacted-pan]");
}
