import crypto from "crypto";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../lib/httpError.js";

const ENCRYPTION_VERSION = "local-aes-256-gcm-v1";
const TEST_VAULT_KEY = "shipmastr-phase18-test-credential-vault-key";

export type StoredSecret = {
  encryptedValue: string;
  encryptionVersion: string;
};

export interface PlatformCredentialVault {
  storeSecret(secret: unknown): StoredSecret;
  readSecretForInternalUse(stored: StoredSecret): unknown;
  rotateSecret(secret: unknown): StoredSecret;
  revokeSecret(): void;
  fingerprintSecret(secret: unknown): string;
  maskSecret(secret: string): string;
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    ordered[key] = (value as Record<string, unknown>)[key];
  }
  return JSON.stringify(ordered);
}

function keyMaterial() {
  const configured = env.CREDENTIAL_VAULT_ENCRYPTION_KEY?.trim() || env.SHIPMASTR_CREDENTIAL_VAULT_KEY?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "test") return TEST_VAULT_KEY;
  if (env.APP_ENV === "development") return `${env.APP_SECRET_PEPPER}:local-platform-credential-vault`;
  throw new HttpError(500, "PLATFORM_CREDENTIAL_VAULT_KEY_MISSING");
}

function encryptionKey() {
  return crypto.createHash("sha256").update(keyMaterial()).digest();
}

export function createLocalPlatformCredentialVault(): PlatformCredentialVault {
  return {
    storeSecret(secret: unknown) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
      const ciphertext = Buffer.concat([
        cipher.update(stableStringify(secret), "utf8"),
        cipher.final()
      ]);
      const tag = cipher.getAuthTag();
      return {
        encryptedValue: [
          ENCRYPTION_VERSION,
          iv.toString("base64"),
          tag.toString("base64"),
          ciphertext.toString("base64")
        ].join(":"),
        encryptionVersion: ENCRYPTION_VERSION
      };
    },

    readSecretForInternalUse(stored: StoredSecret) {
      const [version, ivRaw, tagRaw, ciphertextRaw] = stored.encryptedValue.split(":");
      if (version !== ENCRYPTION_VERSION || !ivRaw || !tagRaw || !ciphertextRaw) {
        throw new HttpError(500, "PLATFORM_CREDENTIAL_SECRET_INVALID");
      }
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64"));
      decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, "base64")),
        decipher.final()
      ]).toString("utf8");
      return JSON.parse(plaintext);
    },

    rotateSecret(secret: unknown) {
      return this.storeSecret(secret);
    },

    revokeSecret() {
      return undefined;
    },

    fingerprintSecret(secret: unknown) {
      return crypto
        .createHash("sha256")
        .update(`${env.APP_SECRET_PEPPER}:platform-credential:${stableStringify(secret)}`)
        .digest("hex")
        .slice(0, 24);
    },

    maskSecret(secret: string) {
      const trimmed = String(secret || "").trim();
      if (!trimmed) return "";
      if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}...`;
      return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
    }
  };
}
