import type {
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformCredentialType,
  StorePlatform
} from "@prisma/client";

export type CredentialVaultProviderMode =
  | "LOCAL_MOCK"
  | "LOCAL_ENCRYPTED"
  | "ENV_ENCRYPTION_KEY"
  | "KMS_PLACEHOLDER"
  | "KMS_INTERFACE";

export type CredentialVaultReadinessStatus =
  | "READY"
  | "MOCK_ONLY"
  | "NOT_CONFIGURED"
  | "BLOCKED"
  | "TEST_FAILED";

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
  mode: "MOCK" | "LOCAL_ENCRYPTED" | "KMS_INTERFACE" | "KMS_PLACEHOLDER";
  configured: boolean;
  kms_key_configured: boolean;
  encryption_key_configured: boolean;
  rotation_enabled: boolean;
  production_kms_ready: boolean;
  live_ready: boolean;
  pilot_ready: boolean;
  requires_live_for_pilot: boolean;
  local_mock_override_for_pilot: boolean;
  local_mock: boolean;
};

export type CredentialVaultReadiness = {
  status: CredentialVaultReadinessStatus;
  ready: boolean;
  message: string;
  runtime: SafeCredentialVaultRuntime;
  checks: Array<{
    key: string;
    label: string;
    status: "PASS" | "WARNING" | "BLOCKED";
    safe_value: string | boolean | number | null;
    recommendation: string;
  }>;
  warnings: string[];
};

export type CredentialVaultProviderTestResult = {
  status: CredentialVaultReadinessStatus;
  ready: boolean;
  message: string;
  runtime: SafeCredentialVaultRuntime;
  checked_at: string;
  safe_details: {
    provider_round_trip: boolean;
    internal_resolution_only: boolean;
    plaintext_exposed: false;
    encrypted_value_exposed: false;
  };
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
