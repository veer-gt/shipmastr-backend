import {
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  Prisma,
  StorePlatform,
  type PlatformConnection
} from "@prisma/client";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import {
  createLocalPlatformCredentialVault,
  type PlatformCredentialVault
} from "../credentials/platform-credentials.crypto.js";
import { mapPlatformOrder } from "../platform-integrations.service.js";
import { PLATFORM_READ_ERRORS } from "./platform-order-fetch.errors.js";
import { buildFetchedOrderPreview, sanitizePlatformFetchDetails } from "./platform-order-fetch.sanitizer.js";
import type {
  PlatformOrderReadClient,
  PlatformReadHttpClient,
  PlatformReadOrderFetchRequest,
  ReadableStorePlatform
} from "./platform-order-fetch.types.js";
import { createMagentoReadOrderClient } from "./magento-read-order-client.js";
import { createShopifyReadOrderClient } from "./shopify-read-order-client.js";
import { createWooCommerceReadOrderClient } from "./woocommerce-read-order-client.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type PlatformReadOrderFetchOptions = {
  client?: Db;
  vault?: PlatformCredentialVault;
  readClients?: Partial<Record<StorePlatform, PlatformOrderReadClient>>;
  realReadsEnabled?: boolean;
  httpClient?: PlatformReadHttpClient;
};

const supportedReadPlatforms = new Set<StorePlatform>([
  StorePlatform.SHOPIFY,
  StorePlatform.WOOCOMMERCE,
  StorePlatform.MAGENTO
]);

const defaultReadClients: Partial<Record<StorePlatform, PlatformOrderReadClient>> = {
  [StorePlatform.SHOPIFY]: createShopifyReadOrderClient(),
  [StorePlatform.WOOCOMMERCE]: createWooCommerceReadOrderClient(),
  [StorePlatform.MAGENTO]: createMagentoReadOrderClient()
};

function providerForPlatform(platform: StorePlatform) {
  return platform as unknown as PlatformCredentialProvider;
}

function credentialIdFromRef(value: string | null | undefined) {
  const ref = String(value || "");
  return ref.startsWith("platform-credential:") ? ref.replace(/^platform-credential:/, "") : null;
}

async function findConnection(merchantId: string, connectionId: string, client: Db) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId }
  });
  if (!connection) throw new HttpError(404, PLATFORM_READ_ERRORS.CONNECTION_NOT_FOUND);
  return connection;
}

async function resolveCredential(
  merchantId: string,
  connection: PlatformConnection,
  client: Db,
  vault: PlatformCredentialVault
) {
  const credentialId = credentialIdFromRef(connection.credentialsRef);
  if (!credentialId) throw new HttpError(409, PLATFORM_READ_ERRORS.CONNECTION_NOT_READY);
  const credential = await client.platformCredential.findFirst({
    where: { id: credentialId, merchantId }
  });
  if (!credential) throw new HttpError(404, PLATFORM_READ_ERRORS.CREDENTIAL_NOT_FOUND);
  if (credential.status !== PlatformCredentialStatus.ACTIVE && credential.status !== PlatformCredentialStatus.ROTATED) {
    throw new HttpError(409, PLATFORM_READ_ERRORS.CREDENTIAL_INACTIVE);
  }
  if (credential.platform !== providerForPlatform(connection.platform)) {
    throw new HttpError(409, PLATFORM_READ_ERRORS.CREDENTIAL_PLATFORM_MISMATCH);
  }
  const secret = await client.platformCredentialSecret.findUnique({
    where: { credentialId: credential.id }
  });
  if (!secret) throw new HttpError(409, PLATFORM_READ_ERRORS.CREDENTIAL_SECRET_MISSING);
  return {
    credential,
    plaintext: vault.readSecretForInternalUse({
      encryptedValue: secret.encryptedValue,
      encryptionVersion: secret.encryptionVersion
    })
  };
}

function assertSupportedPlatform(platform: StorePlatform) {
  if (!supportedReadPlatforms.has(platform)) {
    throw new HttpError(400, PLATFORM_READ_ERRORS.UNSUPPORTED_PLATFORM);
  }
  return platform as ReadableStorePlatform;
}

export async function fetchPlatformOrdersReadOnly(
  request: PlatformReadOrderFetchRequest,
  options: PlatformReadOrderFetchOptions = {}
) {
  const client = options.client ?? prisma;
  const vault = options.vault ?? createLocalPlatformCredentialVault();
  const realReadsEnabled = options.realReadsEnabled ?? env.PLATFORM_INTEGRATIONS_ENABLE_REAL_READS;
  const connection = await findConnection(request.merchantId, request.connectionId, client);
  const platform = assertSupportedPlatform(connection.platform);
  if (platform !== request.platform) {
    throw new HttpError(400, PLATFORM_READ_ERRORS.UNSUPPORTED_PLATFORM);
  }
  const resolved = await resolveCredential(request.merchantId, connection, client, vault);
  const readClient = options.readClients?.[platform] ?? defaultReadClients[platform];
  if (!readClient) throw new HttpError(500, PLATFORM_READ_ERRORS.CLIENT_NOT_CONFIGURED);

  const rawResult = await readClient.fetchOrdersReadOnly({
    platform,
    connectionId: connection.id,
    storeUrl: connection.storeUrl,
    storeName: connection.storeName,
    safeMetadata: (resolved.credential.safeMetadata as Record<string, unknown> | null) ?? null,
    credentialType: resolved.credential.credentialType,
    credentialSecret: resolved.plaintext,
    realReadsEnabled,
    ...(options.httpClient ? { httpClient: options.httpClient } : {})
  }, {
    ...request,
    platform
  });

  const orders = [];
  const warnings = [...rawResult.warnings];
  for (const rawOrder of rawResult.rawOrders) {
    try {
      const normalized = await mapPlatformOrder(platform, rawOrder);
      orders.push({
        normalized,
        preview: buildFetchedOrderPreview(normalized, rawOrder)
      });
    } catch {
      warnings.push("A platform order could not be mapped safely and was skipped.");
    }
  }

  return {
    platform,
    connectionId: connection.id,
    fetchedCount: rawResult.rawOrders.length,
    nextCursor: rawResult.nextCursor ?? null,
    hasMore: rawResult.hasMore,
    orders: orders.map((item) => item.preview),
    rawOrders: rawResult.rawOrders,
    warnings,
    requestedLimit: rawResult.requestedLimit,
    effectiveLimit: rawResult.effectiveLimit,
    rateLimitWarnings: rawResult.rateLimitWarnings,
    retryAfterSeconds: rawResult.retryAfterSeconds ?? null,
    safeDetails: sanitizePlatformFetchDetails({
      ...rawResult.safeDetails,
      fetchedCount: rawResult.rawOrders.length,
      mappedCount: orders.length,
      hasMore: rawResult.hasMore,
      nextCursor: rawResult.nextCursor ?? null
    }) as Record<string, unknown>
  };
}
