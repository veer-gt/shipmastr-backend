import {
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformCredentialType,
  Prisma,
  StorePlatform,
  type PlatformConnection
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  attachCredentialToConnection,
  createPlatformCredential,
  revokePlatformCredential,
  rotatePlatformCredential
} from "../platformIntegrations/credentials/platform-credentials.service.js";
import {
  createConfiguredCredentialVault,
  type ShipmastrCredentialVault
} from "./credential-vault.crypto.js";
import { getCredentialVaultRuntime } from "./credential-vault.providers.js";
import { serializeConnectionCredentialReadiness } from "./credential-vault.serializer.js";
import type {
  ConnectionCredentialReadinessStatus,
  SafeConnectionCredentialSummary
} from "./credential-vault.types.js";
import type {
  RotateConnectionCredentialInput,
  UpsertConnectionCredentialInput
} from "./credential-vault.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function providerForPlatform(platform: StorePlatform) {
  return platform as unknown as PlatformCredentialProvider;
}

function defaultCredentialTypeForPlatform(platform: StorePlatform) {
  if (platform === StorePlatform.SHOPIFY) return PlatformCredentialType.SHOPIFY_CUSTOM_APP_TOKEN;
  if (platform === StorePlatform.WOOCOMMERCE) return PlatformCredentialType.WOOCOMMERCE_REST_KEYS;
  if (platform === StorePlatform.MAGENTO) return PlatformCredentialType.MAGENTO_INTEGRATION_TOKEN;
  return PlatformCredentialType.CUSTOM_API_KEY;
}

function credentialIdFromRef(value: string | null | undefined) {
  const ref = String(value || "");
  return ref.startsWith("platform-credential:") ? ref.replace(/^platform-credential:/, "") : null;
}

async function findConnection(merchantId: string, connectionId: string, client: Db) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId }
  });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  return connection;
}

async function findCredentialByRef(merchantId: string, connection: PlatformConnection, client: Db) {
  const credentialId = credentialIdFromRef(connection.credentialsRef);
  if (!credentialId) return null;
  return client.platformCredential.findFirst({
    where: { id: credentialId, merchantId }
  });
}

async function findSecret(credentialId: string, client: Db) {
  return client.platformCredentialSecret.findUnique({
    where: { credentialId }
  });
}

function isExpired(expiresAt: Date | null | undefined) {
  return Boolean(expiresAt && expiresAt.getTime() <= Date.now());
}

function readinessMessage(status: ConnectionCredentialReadinessStatus) {
  const messages: Record<ConnectionCredentialReadinessStatus, string> = {
    READY: "Credential is ready for internal read-only platform use.",
    NOT_READY: "No secure credential is attached to this store connection.",
    REVOKED: "Attached credential has been revoked.",
    EXPIRED: "Attached credential has expired and should be rotated.",
    PLATFORM_MISMATCH: "Attached credential platform does not match this store connection.",
    MISSING_SECRET: "Credential metadata exists, but encrypted vault data is missing.",
    RESOLUTION_FAILED: "Credential could not be resolved by the vault. Rotate it before use."
  };
  return messages[status];
}

function credentialSummary(credential: NonNullable<Awaited<ReturnType<typeof findCredentialByRef>>>): SafeConnectionCredentialSummary {
  return {
    credential_id: credential.id,
    platform: credential.platform,
    credential_type: credential.credentialType,
    status: credential.status,
    safe_metadata: (credential.safeMetadata as Record<string, unknown> | null) ?? null,
    last_used_at: credential.lastUsedAt,
    expires_at: credential.expiresAt,
    rotated_at: credential.rotatedAt,
    revoked_at: credential.revokedAt
  };
}

async function buildReadiness(
  merchantId: string,
  connection: PlatformConnection,
  client: Db,
  options: { testResolution?: boolean; vault?: ShipmastrCredentialVault } = {}
) {
  const credential = await findCredentialByRef(merchantId, connection, client);
  let status: ConnectionCredentialReadinessStatus = "NOT_READY";
  if (credential) {
    if (credential.platform !== providerForPlatform(connection.platform)) status = "PLATFORM_MISMATCH";
    else if (credential.status === PlatformCredentialStatus.REVOKED) status = "REVOKED";
    else if (isExpired(credential.expiresAt)) status = "EXPIRED";
    else {
      const secret = await findSecret(credential.id, client);
      if (!secret) status = "MISSING_SECRET";
      else if (options.testResolution) {
        try {
          const vault = options.vault ?? createConfiguredCredentialVault();
          vault.readSecretForInternalUse({
            encryptedValue: secret.encryptedValue,
            encryptionVersion: secret.encryptionVersion
          });
          await client.platformCredential.update({
            where: { id: credential.id },
            data: { lastUsedAt: new Date() }
          });
          credential.lastUsedAt = new Date();
          status = "READY";
        } catch {
          status = "RESOLUTION_FAILED";
        }
      } else {
        status = "READY";
      }
    }
  }

  return serializeConnectionCredentialReadiness({
    connection_id: connection.id,
    platform: connection.platform,
    status,
    ready: status === "READY",
    message: readinessMessage(status),
    credential: credential ? credentialSummary(credential) : null,
    vault: getCredentialVaultRuntime(),
    actions: {
      can_create: true,
      can_rotate: Boolean(credential && status !== "REVOKED"),
      can_revoke: Boolean(credential && status !== "REVOKED"),
      can_test_readiness: Boolean(credential && status !== "REVOKED")
    }
  });
}

export async function getConnectionCredentialStatus(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const connection = await findConnection(merchantId, connectionId, client);
  return buildReadiness(merchantId, connection, client);
}

export async function upsertConnectionCredential(
  merchantId: string,
  connectionId: string,
  input: UpsertConnectionCredentialInput,
  client: Db = prisma,
  vault: ShipmastrCredentialVault = createConfiguredCredentialVault()
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const credentialType = input.credentialType ?? defaultCredentialTypeForPlatform(connection.platform);
  const created = await createPlatformCredential(merchantId, {
    platform: providerForPlatform(connection.platform),
    credentialType,
    name: input.name ?? `${connection.storeName || connection.platform} credential`,
    credentials: input.credentials,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {})
  }, client, vault);
  await attachCredentialToConnection(merchantId, connection.id, created.credential_id, client);
  const refreshed = await findConnection(merchantId, connection.id, client);
  return buildReadiness(merchantId, refreshed, client, { testResolution: true, vault });
}

export async function rotateConnectionCredential(
  merchantId: string,
  connectionId: string,
  input: RotateConnectionCredentialInput,
  client: Db = prisma,
  vault: ShipmastrCredentialVault = createConfiguredCredentialVault()
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const credentialId = credentialIdFromRef(connection.credentialsRef);
  if (!credentialId) throw new HttpError(409, "PLATFORM_CONNECTION_CREDENTIAL_NOT_ATTACHED");
  const rotated = await rotatePlatformCredential(merchantId, credentialId, input, client, vault);
  await client.platformConnection.update({
    where: { id: connection.id },
    data: {
      credentialsMeta: toJson({
        credential_id: rotated.credential_id,
        credential_type: rotated.credential_type,
        credential_status: rotated.status,
        safe_metadata: rotated.safe_metadata
      })
    }
  });
  const refreshed = await findConnection(merchantId, connection.id, client);
  return buildReadiness(merchantId, refreshed, client, { testResolution: true, vault });
}

export async function revokeConnectionCredential(
  merchantId: string,
  connectionId: string,
  client: Db = prisma,
  vault: ShipmastrCredentialVault = createConfiguredCredentialVault()
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const credentialId = credentialIdFromRef(connection.credentialsRef);
  if (!credentialId) throw new HttpError(409, "PLATFORM_CONNECTION_CREDENTIAL_NOT_ATTACHED");
  await revokePlatformCredential(merchantId, credentialId, client, vault);
  return buildReadiness(merchantId, connection, client);
}

export async function testConnectionCredentialReadiness(
  merchantId: string,
  connectionId: string,
  client: Db = prisma,
  vault: ShipmastrCredentialVault = createConfiguredCredentialVault()
) {
  const connection = await findConnection(merchantId, connectionId, client);
  return buildReadiness(merchantId, connection, client, { testResolution: true, vault });
}
