import {
  PlatformCredentialPurpose,
  Prisma,
  StorePlatform,
  type PlatformConnection
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  createPlatformWebhookCredentialVault,
  PLATFORM_WEBHOOK_SIGNATURE_PURPOSE,
  type EncryptedPlatformWebhookCredential,
  type PlatformWebhookCredentialContext,
  type PlatformWebhookCredentialVault
} from "./platform-webhook-credential.crypto.js";
import type {
  ConfigurePlatformWebhookCredentialInput,
  RotatePlatformWebhookCredentialInput
} from "./credential-vault.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;
type SupportedPlatform = Extract<StorePlatform, "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO">;
const MAX_ROTATION_GRACE_SECONDS = 7 * 24 * 60 * 60;

export type PlatformWebhookCredentialStatus = {
  configured: boolean;
  platform: SupportedPlatform;
  purpose: typeof PLATFORM_WEBHOOK_SIGNATURE_PURPOSE;
  configuredAt: Date | null;
  rotatedAt: Date | null;
  previousValidUntil: Date | null;
  encryptionKeyVersion: string | null;
  revoked: boolean;
};

export type PlatformWebhookCredentialCandidates = {
  current: string | null;
  previous: string | null;
};

function toSupportedPlatform(value: StorePlatform | string): SupportedPlatform {
  if (value === StorePlatform.SHOPIFY || value === "SHOPIFY") return "SHOPIFY";
  if (value === StorePlatform.WOOCOMMERCE || value === "WOOCOMMERCE") return "WOOCOMMERCE";
  if (value === StorePlatform.MAGENTO || value === "MAGENTO") return "MAGENTO";
  throw new HttpError(400, "PLATFORM_WEBHOOK_CREDENTIAL_PLATFORM_UNSUPPORTED");
}

function contextFor(connection: PlatformConnection, merchantId: string): PlatformWebhookCredentialContext {
  return {
    merchantId,
    connectionId: connection.id,
    platform: toSupportedPlatform(connection.platform),
    purpose: PLATFORM_WEBHOOK_SIGNATURE_PURPOSE
  };
}

async function findOwnedConnection(merchantId: string, connectionId: string, client: Db) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId }
  });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  if (connection.status === "DISABLED") throw new HttpError(409, "PLATFORM_CONNECTION_DISABLED");
  return connection;
}

function encryptedEnvelopeFromRow(row: {
  encryptedCurrentValue: string | null;
  currentNonce: string | null;
  currentAuthTag: string | null;
  encryptionKeyVersion: string | null;
}): EncryptedPlatformWebhookCredential | null {
  const fields = [row.encryptedCurrentValue, row.currentNonce, row.currentAuthTag, row.encryptionKeyVersion];
  if (fields.every((value) => !value)) return null;
  if (fields.some((value) => !value)) throw new HttpError(500, "PLATFORM_WEBHOOK_CREDENTIAL_DECRYPTION_FAILED");
  return {
    encryptedValue: row.encryptedCurrentValue!,
    nonce: row.currentNonce!,
    authTag: row.currentAuthTag!,
    encryptionKeyVersion: row.encryptionKeyVersion!
  };
}

function previousEnvelopeFromRow(row: {
  encryptedPreviousValue: string | null;
  previousNonce: string | null;
  previousAuthTag: string | null;
  encryptionKeyVersion: string | null;
}): EncryptedPlatformWebhookCredential | null {
  const fields = [row.encryptedPreviousValue, row.previousNonce, row.previousAuthTag];
  if (fields.every((value) => !value)) return null;
  if (fields.some((value) => !value) || !row.encryptionKeyVersion) throw new HttpError(500, "PLATFORM_WEBHOOK_CREDENTIAL_DECRYPTION_FAILED");
  return {
    encryptedValue: row.encryptedPreviousValue!,
    nonce: row.previousNonce!,
    authTag: row.previousAuthTag!,
    encryptionKeyVersion: row.encryptionKeyVersion!
  };
}

function safeStatus(row: {
  platform: StorePlatform;
  configuredAt: Date;
  rotatedAt: Date | null;
  previousValidUntil: Date | null;
  encryptionKeyVersion: string | null;
  revokedAt: Date | null;
} | null, platform: SupportedPlatform): PlatformWebhookCredentialStatus {
  return {
    configured: Boolean(row && !row.revokedAt && row.encryptionKeyVersion),
    platform,
    purpose: PLATFORM_WEBHOOK_SIGNATURE_PURPOSE,
    configuredAt: row?.configuredAt ?? null,
    rotatedAt: row?.rotatedAt ?? null,
    previousValidUntil: row?.previousValidUntil ?? null,
    encryptionKeyVersion: row?.encryptionKeyVersion ?? null,
    revoked: Boolean(row?.revokedAt)
  };
}

export async function getPlatformWebhookCredentialStatus(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const connection = await findOwnedConnection(merchantId, connectionId, client);
  const platform = toSupportedPlatform(connection.platform);
  const row = await client.platformWebhookCredential.findUnique({
    where: {
      connectionId_purpose: {
        connectionId: connection.id,
        purpose: PlatformCredentialPurpose.PLATFORM_WEBHOOK_SIGNATURE
      }
    }
  });
  return safeStatus(row, platform);
}

export async function configurePlatformWebhookCredential(
  merchantId: string,
  connectionId: string,
  input: ConfigurePlatformWebhookCredentialInput,
  client: Db = prisma,
  vault: PlatformWebhookCredentialVault = createPlatformWebhookCredentialVault()
) {
  const connection = await findOwnedConnection(merchantId, connectionId, client);
  const platform = toSupportedPlatform(connection.platform);
  if (input.platform !== platform) throw new HttpError(400, "PLATFORM_WEBHOOK_CREDENTIAL_PLATFORM_MISMATCH");
  const encrypted = vault.encrypt(input.secret, contextFor(connection, merchantId));
  const row = await client.platformWebhookCredential.upsert({
    where: {
      connectionId_purpose: {
        connectionId: connection.id,
        purpose: PlatformCredentialPurpose.PLATFORM_WEBHOOK_SIGNATURE
      }
    },
    create: {
      merchantId,
      connectionId: connection.id,
      platform: platform as StorePlatform,
      purpose: PlatformCredentialPurpose.PLATFORM_WEBHOOK_SIGNATURE,
      encryptedCurrentValue: encrypted.encryptedValue,
      currentNonce: encrypted.nonce,
      currentAuthTag: encrypted.authTag,
      encryptionKeyVersion: encrypted.encryptionKeyVersion,
      configuredAt: new Date(),
      rotatedAt: null,
      revokedAt: null,
      encryptedPreviousValue: null,
      previousNonce: null,
      previousAuthTag: null,
      previousValidUntil: null
    },
    update: {
      merchantId,
      platform: platform as StorePlatform,
      encryptedCurrentValue: encrypted.encryptedValue,
      currentNonce: encrypted.nonce,
      currentAuthTag: encrypted.authTag,
      encryptionKeyVersion: encrypted.encryptionKeyVersion,
      configuredAt: new Date(),
      rotatedAt: null,
      revokedAt: null,
      encryptedPreviousValue: null,
      previousNonce: null,
      previousAuthTag: null,
      previousValidUntil: null
    }
  });
  return safeStatus(row, platform);
}

async function runTransaction<T>(client: Db, fn: (tx: Db) => Promise<T>) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await (client as typeof prisma).$transaction(
          (tx) => fn(tx),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (attempt === 0 && error && typeof error === "object" && "code" in error && error.code === "P2034") continue;
        throw error;
      }
    }
  }
  return fn(client);
}

export async function rotatePlatformWebhookCredential(
  merchantId: string,
  connectionId: string,
  input: RotatePlatformWebhookCredentialInput,
  client: Db = prisma,
  vault: PlatformWebhookCredentialVault = createPlatformWebhookCredentialVault()
) {
  if (!Number.isInteger(input.gracePeriodSeconds) || input.gracePeriodSeconds < 0 || input.gracePeriodSeconds > MAX_ROTATION_GRACE_SECONDS) {
    throw new HttpError(400, "PLATFORM_WEBHOOK_CREDENTIAL_GRACE_PERIOD_INVALID");
  }
  const connection = await findOwnedConnection(merchantId, connectionId, client);
  const platform = toSupportedPlatform(connection.platform);
  return runTransaction(client, async (tx) => {
    const row = await tx.platformWebhookCredential.findUnique({
      where: {
        connectionId_purpose: {
          connectionId: connection.id,
          purpose: PlatformCredentialPurpose.PLATFORM_WEBHOOK_SIGNATURE
        }
      }
    });
    const current = row ? encryptedEnvelopeFromRow(row) : null;
    if (!row || !current || row.revokedAt) throw new HttpError(409, "PLATFORM_WEBHOOK_CREDENTIAL_NOT_CONFIGURED");
    const replacement = vault.encrypt(input.replacementSecret, contextFor(connection, merchantId));
    const now = new Date();
    const previousValidUntil = new Date(now.getTime() + input.gracePeriodSeconds * 1000);
    const updated = await tx.platformWebhookCredential.update({
      where: { id: row.id },
      data: {
        merchantId,
        platform: platform as StorePlatform,
        encryptedCurrentValue: replacement.encryptedValue,
        currentNonce: replacement.nonce,
        currentAuthTag: replacement.authTag,
        encryptionKeyVersion: replacement.encryptionKeyVersion,
        rotatedAt: now,
        revokedAt: null,
        encryptedPreviousValue: current.encryptedValue,
        previousNonce: current.nonce,
        previousAuthTag: current.authTag,
        previousValidUntil
      }
    });
    return safeStatus(updated, platform);
  });
}

export async function revokePlatformWebhookCredential(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const connection = await findOwnedConnection(merchantId, connectionId, client);
  const platform = toSupportedPlatform(connection.platform);
  const row = await client.platformWebhookCredential.findUnique({
    where: {
      connectionId_purpose: {
        connectionId: connection.id,
        purpose: PlatformCredentialPurpose.PLATFORM_WEBHOOK_SIGNATURE
      }
    }
  });
  if (!row) return safeStatus(null, platform);
  const updated = await client.platformWebhookCredential.update({
    where: { id: row.id },
    data: {
      encryptedCurrentValue: null,
      currentNonce: null,
      currentAuthTag: null,
      encryptionKeyVersion: null,
      encryptedPreviousValue: null,
      previousNonce: null,
      previousAuthTag: null,
      previousValidUntil: new Date(),
      revokedAt: new Date()
    }
  });
  return safeStatus(updated, platform);
}

export async function resolvePlatformWebhookCredentialCandidates(
  input: {
    merchantId: string;
    connectionId: string;
    platform: SupportedPlatform;
    purpose: typeof PLATFORM_WEBHOOK_SIGNATURE_PURPOSE;
  },
  client: Db = prisma,
  vault?: PlatformWebhookCredentialVault
): Promise<PlatformWebhookCredentialCandidates> {
  if (input.purpose !== PLATFORM_WEBHOOK_SIGNATURE_PURPOSE) return { current: null, previous: null };
  const connection = await client.platformConnection.findFirst({
    where: { id: input.connectionId, merchantId: input.merchantId }
  });
  if (!connection || connection.status === "DISABLED" || toSupportedPlatform(connection.platform) !== input.platform) {
    return { current: null, previous: null };
  }
  if (!("platformWebhookCredential" in client) || !client.platformWebhookCredential) {
    return { current: null, previous: null };
  }
  const row = await client.platformWebhookCredential.findUnique({
    where: {
      connectionId_purpose: {
        connectionId: input.connectionId,
        purpose: PlatformCredentialPurpose.PLATFORM_WEBHOOK_SIGNATURE
      }
    }
  });
  if (!row || row.revokedAt) return { current: null, previous: null };
  const context = contextFor(connection, input.merchantId);
  const activeVault = vault ?? createPlatformWebhookCredentialVault();
  const currentEnvelope = encryptedEnvelopeFromRow(row);
  const current = currentEnvelope ? activeVault.decrypt(currentEnvelope, context) : null;
  const previousEnvelope = previousEnvelopeFromRow(row);
  const previous = previousEnvelope && row.previousValidUntil && row.previousValidUntil.getTime() > Date.now()
    ? activeVault.decrypt(previousEnvelope, context)
    : null;
  return { current, previous };
}
