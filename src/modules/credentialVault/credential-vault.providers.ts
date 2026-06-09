import { env } from "../../config/env.js";
import type { CredentialVaultProviderMode, SafeCredentialVaultRuntime } from "./credential-vault.types.js";

type Source = Record<string, unknown>;

function boolValue(source: Source, key: string, fallback = false) {
  const value = source[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disabled", ""].includes(normalized)) return false;
  }
  return fallback;
}

function stringValue(source: Source, key: string, fallback = "") {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

export function normalizeCredentialVaultProvider(value: unknown): CredentialVaultProviderMode {
  const normalized = String(value || "LOCAL_MOCK").trim().toUpperCase();
  if (normalized === "ENV_ENCRYPTION_KEY") return "ENV_ENCRYPTION_KEY";
  if (normalized === "LOCAL_ENCRYPTED") return "LOCAL_ENCRYPTED";
  if (normalized === "KMS_INTERFACE") return "KMS_INTERFACE";
  if (normalized === "KMS_PLACEHOLDER") return "KMS_PLACEHOLDER";
  return "LOCAL_MOCK";
}

function providerMode(provider: CredentialVaultProviderMode): SafeCredentialVaultRuntime["mode"] {
  if (provider === "KMS_INTERFACE") return "KMS_INTERFACE";
  if (provider === "KMS_PLACEHOLDER") return "KMS_PLACEHOLDER";
  if (provider === "LOCAL_ENCRYPTED" || provider === "ENV_ENCRYPTION_KEY") return "LOCAL_ENCRYPTED";
  return "MOCK";
}

export function getCredentialVaultRuntime(source: Source = env): SafeCredentialVaultRuntime {
  const provider = normalizeCredentialVaultProvider(stringValue(source, "CREDENTIAL_VAULT_PROVIDER", "LOCAL_MOCK"));
  const nodeEnv = stringValue(source, "NODE_ENV", "development");
  const appEnv = stringValue(source, "APP_ENV", "development");
  const encryptionKeyConfigured = Boolean(
    stringValue(source, "CREDENTIAL_VAULT_ENCRYPTION_KEY")
    || stringValue(source, "SHIPMASTR_CREDENTIAL_VAULT_KEY")
  );
  const kmsKeyConfigured = Boolean(stringValue(source, "CREDENTIAL_VAULT_KMS_KEY_ID"));
  const localFallbackAvailable = nodeEnv === "test" || appEnv === "development";
  const effectiveEncryptionConfigured = encryptionKeyConfigured || (
    (provider === "LOCAL_MOCK" || provider === "LOCAL_ENCRYPTED") && localFallbackAvailable
  );
  const configured = provider === "LOCAL_MOCK"
    ? true
    : provider === "KMS_PLACEHOLDER"
      ? kmsKeyConfigured
      : provider === "KMS_INTERFACE"
        ? kmsKeyConfigured && effectiveEncryptionConfigured
        : effectiveEncryptionConfigured;
  const requiresLiveForPilot = boolValue(source, "CREDENTIAL_VAULT_REQUIRE_LIVE_FOR_PILOT", true);
  const localMockOverrideForPilot = boolValue(source, "CREDENTIAL_VAULT_ALLOW_LOCAL_MOCK_FOR_PILOT", false);
  const localMock = provider === "LOCAL_MOCK";
  const liveReady = configured && !localMock && provider !== "KMS_PLACEHOLDER";
  const pilotReady = configured && (!requiresLiveForPilot || !localMock || localMockOverrideForPilot);

  return {
    provider,
    mode: providerMode(provider),
    configured,
    kms_key_configured: kmsKeyConfigured,
    encryption_key_configured: effectiveEncryptionConfigured,
    rotation_enabled: boolValue(source, "CREDENTIAL_VAULT_ROTATION_ENABLED", false),
    production_kms_ready: provider === "KMS_INTERFACE" && kmsKeyConfigured && effectiveEncryptionConfigured,
    live_ready: liveReady,
    pilot_ready: pilotReady,
    requires_live_for_pilot: requiresLiveForPilot,
    local_mock_override_for_pilot: localMockOverrideForPilot,
    local_mock: localMock
  };
}
