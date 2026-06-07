import type {
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformCredentialType
} from "@prisma/client";

export type CredentialPlaintext = Record<string, unknown>;

export type SafeCredentialMetadata = Record<string, unknown>;

export type SerializedPlatformCredential = {
  credential_id: string;
  platform: PlatformCredentialProvider;
  credential_type: PlatformCredentialType;
  name: string;
  status: PlatformCredentialStatus;
  secret_fingerprint: string;
  safe_metadata: SafeCredentialMetadata | null;
  last_used_at: Date | string | null;
  expires_at: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  rotated_at: Date | string | null;
  revoked_at: Date | string | null;
};

export type CredentialShapeResult = {
  platform: PlatformCredentialProvider;
  credentialType: PlatformCredentialType;
  plaintext: CredentialPlaintext;
  safeMetadata: SafeCredentialMetadata;
  primarySecret: string;
};
