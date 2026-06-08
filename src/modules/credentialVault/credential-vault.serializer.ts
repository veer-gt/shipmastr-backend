import type {
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformCredentialType
} from "@prisma/client";
import type { ConnectionCredentialReadiness } from "./credential-vault.types.js";

const unsafeKeyPattern = /secret|token|password|encrypted|raw|authorization|api[_-]?key|consumer|fingerprint|hash|ref/i;
const unsafeStringPattern = /shpat_|ck_|cs_|magentotoken_|bearer\s+|basic\s+|sk_live|sk_test|whsec_|token|secret/i;

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

function sanitizeMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (unsafeKeyPattern.test(key)) {
      if (!/(prefix|masked)/i.test(key)) continue;
    }
    if (typeof item === "string" && unsafeStringPattern.test(item) && !/(^.{1,8}\.\.\..{0,8}$)/.test(item)) continue;
    safe[key] = item;
  }
  return safe;
}

export function serializeConnectionCredentialReadiness(
  input: Omit<ConnectionCredentialReadiness, "credential"> & {
    credential?: {
      credential_id: string;
      platform: string;
      credential_type: string;
      status: string;
      safe_metadata?: unknown;
      last_used_at?: Date | string | null;
      expires_at?: Date | string | null;
      rotated_at?: Date | string | null;
      revoked_at?: Date | string | null;
    } | null;
  }
): ConnectionCredentialReadiness {
  return {
    connection_id: input.connection_id,
    platform: input.platform,
    status: input.status,
    ready: input.ready,
    message: input.message,
    credential: input.credential ? {
      credential_id: input.credential.credential_id,
      platform: input.credential.platform as PlatformCredentialProvider,
      credential_type: input.credential.credential_type as PlatformCredentialType,
      status: input.credential.status as PlatformCredentialStatus,
      safe_metadata: sanitizeMetadata(input.credential.safe_metadata),
      last_used_at: timestamp(input.credential.last_used_at),
      expires_at: timestamp(input.credential.expires_at),
      rotated_at: timestamp(input.credential.rotated_at),
      revoked_at: timestamp(input.credential.revoked_at)
    } : null,
    vault: input.vault,
    actions: input.actions
  };
}
