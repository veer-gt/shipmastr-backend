import {
  type PlatformCredentialVault
} from "../platformIntegrations/credentials/platform-credentials.crypto.js";
import { createEnvEncryptionVaultProvider } from "./providers/env-encryption-vault.provider.js";
import { createKmsInterfaceVaultProvider } from "./providers/kms-vault.provider.js";
import { createLocalMockVaultProvider } from "./providers/local-mock-vault.provider.js";
import { getCredentialVaultRuntime } from "./credential-vault.providers.js";

export type ShipmastrCredentialVault = PlatformCredentialVault;

export function createConfiguredCredentialVault(): ShipmastrCredentialVault {
  const runtime = getCredentialVaultRuntime();
  if (runtime.provider === "ENV_ENCRYPTION_KEY" || runtime.provider === "LOCAL_ENCRYPTED") {
    return createEnvEncryptionVaultProvider();
  }
  if (runtime.provider === "KMS_INTERFACE" || runtime.provider === "KMS_PLACEHOLDER") {
    return createKmsInterfaceVaultProvider();
  }
  return createLocalMockVaultProvider();
}
