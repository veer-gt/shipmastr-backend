import {
  createLocalPlatformCredentialVault,
  type PlatformCredentialVault
} from "../platformIntegrations/credentials/platform-credentials.crypto.js";

export type ShipmastrCredentialVault = PlatformCredentialVault;

export function createConfiguredCredentialVault(): ShipmastrCredentialVault {
  return createLocalPlatformCredentialVault();
}
