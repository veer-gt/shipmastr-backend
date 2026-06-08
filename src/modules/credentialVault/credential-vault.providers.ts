import { env } from "../../config/env.js";
import type { SafeCredentialVaultRuntime } from "./credential-vault.types.js";

export function getCredentialVaultRuntime(): SafeCredentialVaultRuntime {
  const provider = env.CREDENTIAL_VAULT_PROVIDER;
  const encryptionKeyConfigured = Boolean(env.CREDENTIAL_VAULT_ENCRYPTION_KEY || env.SHIPMASTR_CREDENTIAL_VAULT_KEY);
  const localFallbackAvailable = env.NODE_ENV === "test" || env.APP_ENV === "development";
  return {
    provider,
    kms_key_configured: Boolean(env.CREDENTIAL_VAULT_KMS_KEY_ID),
    encryption_key_configured: encryptionKeyConfigured || localFallbackAvailable,
    rotation_enabled: env.CREDENTIAL_VAULT_ROTATION_ENABLED,
    production_kms_ready: provider === "KMS_PLACEHOLDER" && Boolean(env.CREDENTIAL_VAULT_KMS_KEY_ID),
    local_mock: provider === "LOCAL_MOCK"
  };
}
