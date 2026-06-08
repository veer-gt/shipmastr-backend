import type {
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformCredentialType,
  StorePlatform
} from "@prisma/client";

export type CredentialVaultProviderMode = "LOCAL_MOCK" | "LOCAL_ENCRYPTED" | "KMS_PLACEHOLDER";

export type ConnectionCredentialReadinessStatus =
  | "READY"
  | "NOT_READY"
  | "REVOKED"
  | "EXPIRED"
  | "PLATFORM_MISMATCH"
  | "MISSING_SECRET"
  | "RESOLUTION_FAILED";

export type SafeCredentialVaultRuntime = {
  provider: CredentialVaultProviderMode;
  kms_key_configured: boolean;
  encryption_key_configured: boolean;
  rotation_enabled: boolean;
  production_kms_ready: boolean;
  local_mock: boolean;
};

export type SafeConnectionCredentialSummary = {
  credential_id: string;
  platform: PlatformCredentialProvider;
  credential_type: PlatformCredentialType;
  status: PlatformCredentialStatus;
  safe_metadata: Record<string, unknown> | null;
  last_used_at: Date | string | null;
  expires_at: Date | string | null;
  rotated_at: Date | string | null;
  revoked_at: Date | string | null;
};

export type ConnectionCredentialReadiness = {
  connection_id: string;
  platform: StorePlatform;
  status: ConnectionCredentialReadinessStatus;
  ready: boolean;
  message: string;
  credential: SafeConnectionCredentialSummary | null;
  vault: SafeCredentialVaultRuntime;
  actions: {
    can_create: boolean;
    can_rotate: boolean;
    can_revoke: boolean;
    can_test_readiness: boolean;
  };
};
