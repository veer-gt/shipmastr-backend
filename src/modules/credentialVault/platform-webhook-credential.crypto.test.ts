import crypto from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPlatformWebhookCredentialVault,
  PLATFORM_WEBHOOK_SIGNATURE_PURPOSE,
  validatePlatformWebhookEncryptionKey,
  type PlatformWebhookCredentialContext
} from "./platform-webhook-credential.crypto.js";

const context: PlatformWebhookCredentialContext = {
  merchantId: "merchant_a",
  connectionId: "connection_a",
  platform: "SHOPIFY",
  purpose: PLATFORM_WEBHOOK_SIGNATURE_PURPOSE
};

function key() {
  return crypto.randomBytes(32);
}

describe("H2A platform webhook credential envelope", () => {
  it("round-trips with AES-256-GCM and uses a unique nonce", () => {
    const vault = createPlatformWebhookCredentialVault({}, key());
    const first = vault.encrypt("fixture-webhook-secret-current", context);
    const second = vault.encrypt("fixture-webhook-secret-current", context);
    assert.equal(vault.decrypt(first, context), "fixture-webhook-secret-current");
    assert.notEqual(first.nonce, second.nonce);
    assert.notEqual(first.encryptedValue, second.encryptedValue);
  });

  it("fails closed for wrong key, ciphertext, nonce, tag, and AAD", () => {
    const originalKey = key();
    const vault = createPlatformWebhookCredentialVault({}, originalKey);
    const encrypted = vault.encrypt("fixture-webhook-secret-current", context);
    const wrongKeyVault = createPlatformWebhookCredentialVault({}, key());
    assert.throws(() => wrongKeyVault.decrypt(encrypted, context), /PLATFORM_WEBHOOK_CREDENTIAL_DECRYPTION_FAILED/);
    const modifiedCiphertext = Buffer.from(encrypted.encryptedValue, "base64");
    modifiedCiphertext[0] = (modifiedCiphertext[0] ?? 0) ^ 1;
    assert.throws(() => vault.decrypt({ ...encrypted, encryptedValue: modifiedCiphertext.toString("base64") }, context), /PLATFORM_WEBHOOK_CREDENTIAL_DECRYPTION_FAILED/);
    assert.throws(() => vault.decrypt({ ...encrypted, nonce: Buffer.from(key().subarray(0, 12)).toString("base64") }, context), /PLATFORM_WEBHOOK_CREDENTIAL_DECRYPTION_FAILED/);
    assert.throws(() => vault.decrypt({ ...encrypted, authTag: Buffer.from(key().subarray(0, 16)).toString("base64") }, context), /PLATFORM_WEBHOOK_CREDENTIAL_DECRYPTION_FAILED/);
    assert.throws(() => vault.decrypt(encrypted, { ...context, merchantId: "merchant_b" }), /PLATFORM_WEBHOOK_CREDENTIAL_DECRYPTION_FAILED/);
  });

  it("requires exactly 32 random key bytes and never silently generates one", () => {
    assert.equal(validatePlatformWebhookEncryptionKey({}, key()).length, 32);
    assert.equal(validatePlatformWebhookEncryptionKey({ PLATFORM_CREDENTIAL_ENCRYPTION_KEY: key().toString("hex") }).length, 32);
    assert.equal(validatePlatformWebhookEncryptionKey({ PLATFORM_CREDENTIAL_ENCRYPTION_KEY: key().toString("base64") }).length, 32);
    assert.throws(() => validatePlatformWebhookEncryptionKey({}), /PLATFORM_CREDENTIAL_ENCRYPTION_KEY_MISSING/);
    assert.throws(() => validatePlatformWebhookEncryptionKey({ PLATFORM_CREDENTIAL_ENCRYPTION_KEY: "too-short" }), /PLATFORM_CREDENTIAL_ENCRYPTION_KEY_INVALID/);
  });
});
