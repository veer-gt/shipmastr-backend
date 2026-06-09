import { env } from "../../../config/env.js";
import { HttpError } from "../../../lib/httpError.js";
import { createLocalPlatformCredentialVault } from "../../platformIntegrations/credentials/platform-credentials.crypto.js";
import type { ShipmastrCredentialVault } from "../credential-vault.crypto.js";

function hasEncryptionKey() {
  return Boolean(env.CREDENTIAL_VAULT_ENCRYPTION_KEY?.trim() || env.SHIPMASTR_CREDENTIAL_VAULT_KEY?.trim());
}

export function createKmsInterfaceVaultProvider(): ShipmastrCredentialVault {
  if (!env.CREDENTIAL_VAULT_KMS_KEY_ID?.trim()) {
    throw new HttpError(500, "CREDENTIAL_VAULT_KMS_KEY_ID_MISSING");
  }
  if (!hasEncryptionKey()) {
    throw new HttpError(500, "CREDENTIAL_VAULT_ENCRYPTION_KEY_MISSING");
  }
  return createLocalPlatformCredentialVault();
}
