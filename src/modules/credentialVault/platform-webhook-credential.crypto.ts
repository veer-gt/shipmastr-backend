import crypto from "node:crypto";
import { HttpError } from "../../lib/httpError.js";

export const PLATFORM_WEBHOOK_SIGNATURE_PURPOSE = "PLATFORM_WEBHOOK_SIGNATURE" as const;
export const PLATFORM_WEBHOOK_ENVELOPE_VERSION = "h2a-aes-256-gcm-v1" as const;
export const PLATFORM_WEBHOOK_KEY_VERSION = "platform-credential-key-v1" as const;

export type PlatformWebhookCredentialContext = {
  merchantId: string;
  connectionId: string;
  platform: "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO";
  purpose: typeof PLATFORM_WEBHOOK_SIGNATURE_PURPOSE;
};

export type EncryptedPlatformWebhookCredential = {
  encryptedValue: string;
  nonce: string;
  authTag: string;
  encryptionKeyVersion: string;
};

export type PlatformWebhookCredentialVault = {
  encrypt(secret: string, context: PlatformWebhookCredentialContext): EncryptedPlatformWebhookCredential;
  decrypt(envelope: EncryptedPlatformWebhookCredential, context: PlatformWebhookCredentialContext): string;
};

type Source = Record<string, unknown>;

function safeError(code: string) {
  return new HttpError(500, code);
}

function parseKeyMaterial(source: Source, keyOverride?: Buffer) {
  if (keyOverride) {
    if (keyOverride.length !== 32) throw safeError("PLATFORM_CREDENTIAL_ENCRYPTION_KEY_INVALID");
    return Buffer.from(keyOverride);
  }

  const raw = String(source.PLATFORM_CREDENTIAL_ENCRYPTION_KEY ?? "").trim();
  if (!raw) throw safeError("PLATFORM_CREDENTIAL_ENCRYPTION_KEY_MISSING");

  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  }

  throw safeError("PLATFORM_CREDENTIAL_ENCRYPTION_KEY_INVALID");
}

function canonicalAad(context: PlatformWebhookCredentialContext) {
  return JSON.stringify({
    schemaVersion: PLATFORM_WEBHOOK_ENVELOPE_VERSION,
    merchantId: context.merchantId,
    connectionId: context.connectionId,
    platform: context.platform,
    purpose: context.purpose
  });
}

function assertContext(context: PlatformWebhookCredentialContext) {
  if (
    !context.merchantId
    || !context.connectionId
    || !["SHOPIFY", "WOOCOMMERCE", "MAGENTO"].includes(context.platform)
    || context.purpose !== PLATFORM_WEBHOOK_SIGNATURE_PURPOSE
  ) {
    throw safeError("PLATFORM_WEBHOOK_CREDENTIAL_CONTEXT_INVALID");
  }
}

export function validatePlatformWebhookEncryptionKey(source: Source = process.env, keyOverride?: Buffer) {
  return parseKeyMaterial(source, keyOverride);
}

export function createPlatformWebhookCredentialVault(
  source: Source = process.env,
  keyOverride?: Buffer
): PlatformWebhookCredentialVault {
  const key = parseKeyMaterial(source, keyOverride);
  const encryptionKeyVersion = String(
    source.PLATFORM_CREDENTIAL_ENCRYPTION_KEY_VERSION || PLATFORM_WEBHOOK_KEY_VERSION
  ).trim() || PLATFORM_WEBHOOK_KEY_VERSION;

  return {
    encrypt(secret, context) {
      assertContext(context);
      if (typeof secret !== "string" || !secret.trim() || Buffer.byteLength(secret, "utf8") > 4096) {
        throw new HttpError(400, "PLATFORM_WEBHOOK_CREDENTIAL_SECRET_INVALID");
      }
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(canonicalAad(context), "utf8"));
      const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return {
        encryptedValue: ciphertext.toString("base64"),
        nonce: nonce.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        encryptionKeyVersion
      };
    },

    decrypt(envelope, context) {
      try {
        assertContext(context);
        if (
          envelope.encryptionKeyVersion !== encryptionKeyVersion
          || !envelope.encryptedValue
          || !envelope.nonce
          || !envelope.authTag
        ) {
          throw new Error("invalid envelope");
        }
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(envelope.nonce, "base64")
        );
        decipher.setAAD(Buffer.from(canonicalAad(context), "utf8"));
        decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(envelope.encryptedValue, "base64")),
          decipher.final()
        ]).toString("utf8");
      } catch {
        throw safeError("PLATFORM_WEBHOOK_CREDENTIAL_DECRYPTION_FAILED");
      }
    }
  };
}
