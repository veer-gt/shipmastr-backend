import { createLocalPlatformCredentialVault } from "../../platformIntegrations/credentials/platform-credentials.crypto.js";
import type { ShipmastrCredentialVault } from "../credential-vault.crypto.js";

export function createLocalMockVaultProvider(): ShipmastrCredentialVault {
  return createLocalPlatformCredentialVault();
}
