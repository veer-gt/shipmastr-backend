import type { SerializedPlatformCredential } from "./platform-credentials.types.js";

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

export function serializePlatformCredential(record: {
  id: string;
  platform: string;
  credentialType: string;
  name: string;
  status: string;
  safeMetadata?: unknown;
  lastUsedAt?: Date | string | null;
  expiresAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  rotatedAt?: Date | string | null;
  revokedAt?: Date | string | null;
}): SerializedPlatformCredential {
  return {
    credential_id: record.id,
    platform: record.platform as SerializedPlatformCredential["platform"],
    credential_type: record.credentialType as SerializedPlatformCredential["credential_type"],
    name: record.name,
    status: record.status as SerializedPlatformCredential["status"],
    safe_metadata: (record.safeMetadata as SerializedPlatformCredential["safe_metadata"]) ?? null,
    last_used_at: timestamp(record.lastUsedAt),
    expires_at: timestamp(record.expiresAt),
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt),
    rotated_at: timestamp(record.rotatedAt),
    revoked_at: timestamp(record.revokedAt)
  };
}

export function serializeCredentialShapeValidation(input: {
  platform: string;
  credentialType: string;
  safeMetadata: unknown;
}) {
  return {
    platform: input.platform,
    credential_type: input.credentialType,
    valid: true,
    safe_metadata: input.safeMetadata
  };
}
