import crypto from "crypto";
import {
  PlatformConnectionStatus,
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformCredentialType,
  Prisma,
  StorePlatform
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { serializePlatformConnection } from "../platform-integrations.serializers.js";
import {
  createLocalPlatformCredentialVault,
  type PlatformCredentialVault
} from "./platform-credentials.crypto.js";
import {
  serializeCredentialShapeValidation,
  serializePlatformCredential
} from "./platform-credentials.serializers.js";
import type {
  CreatePlatformCredentialInput,
  ListPlatformCredentialsQueryInput,
  RotatePlatformCredentialInput,
  ValidateCredentialShapeInput
} from "./platform-credentials.validation.js";
import type { CredentialPlaintext, CredentialShapeResult } from "./platform-credentials.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown) {
  const result = stringValue(value);
  return result || null;
}

function assertMinSecret(value: unknown, field: string) {
  const secret = stringValue(value);
  if (secret.length < 8) {
    throw new HttpError(400, "PLATFORM_CREDENTIAL_SECRET_INVALID", {
      field,
      message: "Credential value is missing or too short."
    });
  }
  return secret;
}

function assertUrl(value: unknown, code = "PLATFORM_CREDENTIAL_URL_INVALID") {
  const rawUrl = stringValue(value);
  try {
    const parsed = new URL(rawUrl);
    const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (!["https:", "http:"].includes(parsed.protocol) || (parsed.protocol !== "https:" && !local)) {
      throw new Error("unsafe protocol");
    }
    return parsed.toString();
  } catch {
    throw new HttpError(400, code);
  }
}

function assertShopDomain(value: unknown) {
  const domain = stringValue(value).toLowerCase();
  if (!domain || !/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new HttpError(400, "PLATFORM_CREDENTIAL_SHOP_DOMAIN_INVALID");
  }
  return domain;
}

function assertApiVersion(value: unknown, field: string, shopify = false) {
  const version = optionalString(value);
  if (!version) return null;
  const pattern = shopify ? /^\d{4}-\d{2}$/ : /^[A-Za-z0-9._/-]{1,40}$/;
  if (!pattern.test(version)) {
    throw new HttpError(400, "PLATFORM_CREDENTIAL_API_VERSION_INVALID", { field });
  }
  return version;
}

function assertSafeSlug(value: unknown) {
  const slug = optionalString(value);
  if (!slug) return null;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(slug)) {
    throw new HttpError(400, "PLATFORM_CREDENTIAL_METADATA_INVALID", { field: "storeViewCode" });
  }
  return slug;
}

function assertHeaderName(value: unknown) {
  const header = optionalString(value) || "Authorization";
  if (!/^[A-Za-z0-9-]{1,80}$/.test(header)) {
    throw new HttpError(400, "PLATFORM_CREDENTIAL_METADATA_INVALID", { field: "headerName" });
  }
  return header;
}

function ensurePlatformTypeMatch(platform: string, credentialType: string) {
  const allowed: Record<string, string[]> = {
    SHOPIFY: ["SHOPIFY_CUSTOM_APP_TOKEN", "SHOPIFY_OAUTH_PLACEHOLDER"],
    WOOCOMMERCE: ["WOOCOMMERCE_REST_KEYS"],
    MAGENTO: ["MAGENTO_INTEGRATION_TOKEN"],
    CUSTOM: ["CUSTOM_API_KEY", "WEBHOOK_SECRET"]
  };
  if (!allowed[platform]?.includes(credentialType)) {
    throw new HttpError(400, "PLATFORM_CREDENTIAL_TYPE_MISMATCH");
  }
}

export function validateCredentialShape(
  input: ValidateCredentialShapeInput | CreatePlatformCredentialInput,
  vault: PlatformCredentialVault = createLocalPlatformCredentialVault()
): CredentialShapeResult {
  ensurePlatformTypeMatch(input.platform, input.credentialType);
  const credentials = input.credentials as CredentialPlaintext;

  switch (input.credentialType) {
    case PlatformCredentialType.SHOPIFY_CUSTOM_APP_TOKEN:
    case PlatformCredentialType.SHOPIFY_OAUTH_PLACEHOLDER: {
      const shopDomain = assertShopDomain(credentials.shopDomain);
      const apiVersion = assertApiVersion(credentials.apiVersion, "apiVersion", true);
      const token = assertMinSecret(credentials.accessToken, "accessToken");
      return {
        platform: PlatformCredentialProvider.SHOPIFY,
        credentialType: input.credentialType as PlatformCredentialType,
        plaintext: { shopDomain, apiVersion, accessToken: token },
        primarySecret: token,
        safeMetadata: {
          shop_domain: shopDomain,
          api_version: apiVersion,
          token_prefix: vault.maskSecret(token)
        }
      };
    }
    case PlatformCredentialType.WOOCOMMERCE_REST_KEYS: {
      const siteUrl = assertUrl(credentials.siteUrl);
      const apiVersion = assertApiVersion(credentials.apiVersion, "apiVersion");
      const consumerKey = assertMinSecret(credentials.consumerKey, "consumerKey");
      const consumerSecret = assertMinSecret(credentials.consumerSecret, "consumerSecret");
      return {
        platform: PlatformCredentialProvider.WOOCOMMERCE,
        credentialType: PlatformCredentialType.WOOCOMMERCE_REST_KEYS,
        plaintext: { siteUrl, apiVersion, consumerKey, consumerSecret },
        primarySecret: `${consumerKey}:${consumerSecret}`,
        safeMetadata: {
          site_url: siteUrl,
          api_version: apiVersion,
          consumer_key_prefix: vault.maskSecret(consumerKey)
        }
      };
    }
    case PlatformCredentialType.MAGENTO_INTEGRATION_TOKEN: {
      const baseUrl = assertUrl(credentials.baseUrl);
      const storeViewCode = assertSafeSlug(credentials.storeViewCode);
      const apiVersion = assertApiVersion(credentials.apiVersion, "apiVersion");
      const token = assertMinSecret(credentials.integrationToken, "integrationToken");
      return {
        platform: PlatformCredentialProvider.MAGENTO,
        credentialType: PlatformCredentialType.MAGENTO_INTEGRATION_TOKEN,
        plaintext: { baseUrl, storeViewCode, apiVersion, integrationToken: token },
        primarySecret: token,
        safeMetadata: {
          base_url: baseUrl,
          store_view_code: storeViewCode,
          api_version: apiVersion,
          token_prefix: vault.maskSecret(token)
        }
      };
    }
    case PlatformCredentialType.CUSTOM_API_KEY:
    case PlatformCredentialType.WEBHOOK_SECRET: {
      const baseUrl = assertUrl(credentials.baseUrl);
      const headerName = assertHeaderName(credentials.headerName);
      const apiKey = assertMinSecret(credentials.apiKey, "apiKey");
      return {
        platform: PlatformCredentialProvider.CUSTOM,
        credentialType: input.credentialType as PlatformCredentialType,
        plaintext: { baseUrl, headerName, apiKey },
        primarySecret: apiKey,
        safeMetadata: {
          base_url: baseUrl,
          header_name: headerName,
          api_key_prefix: vault.maskSecret(apiKey)
        }
      };
    }
    default:
      throw new HttpError(400, "PLATFORM_CREDENTIAL_TYPE_UNSUPPORTED");
  }
}

async function findCredential(merchantId: string, credentialId: string, client: Db) {
  const credential = await client.platformCredential.findFirst({
    where: { id: credentialId, merchantId }
  });
  if (!credential) throw new HttpError(404, "PLATFORM_CREDENTIAL_NOT_FOUND");
  return credential;
}

async function findConnection(merchantId: string, connectionId: string, client: Db) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId }
  });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  return connection;
}

export async function createPlatformCredential(
  merchantId: string,
  input: CreatePlatformCredentialInput,
  client: Db = prisma,
  vault: PlatformCredentialVault = createLocalPlatformCredentialVault()
) {
  const shape = validateCredentialShape(input, vault);
  const stored = vault.storeSecret(shape.plaintext);
  const credential = await client.platformCredential.create({
    data: {
      merchantId,
      platform: shape.platform,
      credentialType: shape.credentialType,
      name: input.name,
      status: PlatformCredentialStatus.ACTIVE,
      secretRef: `vault://platform-credentials/${crypto.randomBytes(16).toString("hex")}`,
      secretFingerprint: vault.fingerprintSecret(shape.primarySecret),
      safeMetadata: toJson(shape.safeMetadata),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null
    }
  });
  await client.platformCredentialSecret.create({
    data: {
      credentialId: credential.id,
      encryptedValue: stored.encryptedValue,
      encryptionVersion: stored.encryptionVersion
    }
  });
  return serializePlatformCredential(credential);
}

export async function listPlatformCredentials(
  merchantId: string,
  query: ListPlatformCredentialsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const where: Prisma.PlatformCredentialWhereInput = {
    merchantId,
    ...(query.platform ? { platform: query.platform as PlatformCredentialProvider } : {}),
    ...(query.status ? { status: query.status as PlatformCredentialStatus } : {})
  };
  const [credentials, total] = await Promise.all([
    client.platformCredential.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.platformCredential.count({ where })
  ]);
  return {
    credentials: credentials.map(serializePlatformCredential),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getPlatformCredential(
  merchantId: string,
  credentialId: string,
  client: Db = prisma
) {
  return serializePlatformCredential(await findCredential(merchantId, credentialId, client));
}

export async function rotatePlatformCredential(
  merchantId: string,
  credentialId: string,
  input: RotatePlatformCredentialInput,
  client: Db = prisma,
  vault: PlatformCredentialVault = createLocalPlatformCredentialVault()
) {
  const credential = await findCredential(merchantId, credentialId, client);
  if (credential.status === PlatformCredentialStatus.REVOKED) {
    throw new HttpError(409, "PLATFORM_CREDENTIAL_REVOKED");
  }
  const shape = validateCredentialShape({
    platform: credential.platform,
    credentialType: credential.credentialType,
    credentials: input.credentials
  }, vault);
  const stored = vault.rotateSecret(shape.plaintext);
  await client.platformCredentialSecret.upsert({
    where: { credentialId: credential.id },
    create: {
      credentialId: credential.id,
      encryptedValue: stored.encryptedValue,
      encryptionVersion: stored.encryptionVersion
    },
    update: {
      encryptedValue: stored.encryptedValue,
      encryptionVersion: stored.encryptionVersion
    }
  });
  const updated = await client.platformCredential.update({
    where: { id: credential.id },
    data: {
      status: PlatformCredentialStatus.ROTATED,
      secretFingerprint: vault.fingerprintSecret(shape.primarySecret),
      safeMetadata: toJson(shape.safeMetadata),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : credential.expiresAt,
      rotatedAt: new Date()
    }
  });
  return serializePlatformCredential(updated);
}

export async function revokePlatformCredential(
  merchantId: string,
  credentialId: string,
  client: Db = prisma,
  vault: PlatformCredentialVault = createLocalPlatformCredentialVault()
) {
  const credential = await findCredential(merchantId, credentialId, client);
  vault.revokeSecret();
  const updated = await client.platformCredential.update({
    where: { id: credential.id },
    data: {
      status: PlatformCredentialStatus.REVOKED,
      revokedAt: new Date()
    }
  });
  return serializePlatformCredential(updated);
}

function providerToStorePlatform(provider: PlatformCredentialProvider) {
  return provider as unknown as StorePlatform;
}

export async function attachCredentialToConnection(
  merchantId: string,
  connectionId: string,
  credentialId: string,
  client: Db = prisma
) {
  const [connection, credential] = await Promise.all([
    findConnection(merchantId, connectionId, client),
    findCredential(merchantId, credentialId, client)
  ]);
  if (credential.status === PlatformCredentialStatus.REVOKED) {
    throw new HttpError(409, "PLATFORM_CREDENTIAL_REVOKED");
  }
  if (connection.platform !== providerToStorePlatform(credential.platform)) {
    throw new HttpError(400, "PLATFORM_CREDENTIAL_PLATFORM_MISMATCH");
  }
  const updated = await client.platformConnection.update({
    where: { id: connection.id },
    data: {
      status: connection.status === PlatformConnectionStatus.DRAFT ? PlatformConnectionStatus.ACTIVE : connection.status,
      credentialsRef: `platform-credential:${credential.id}`,
      credentialsMeta: toJson({
        credential_id: credential.id,
        credential_type: credential.credentialType,
        credential_status: credential.status,
        safe_metadata: credential.safeMetadata ?? null
      })
    }
  });
  return serializePlatformConnection(updated);
}

export async function detachCredentialFromConnection(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const updated = await client.platformConnection.update({
    where: { id: connection.id },
    data: {
      credentialsRef: null,
      credentialsMeta: Prisma.JsonNull
    }
  });
  return serializePlatformConnection(updated);
}

export function validateCredentialShapeForResponse(
  input: ValidateCredentialShapeInput,
  vault: PlatformCredentialVault = createLocalPlatformCredentialVault()
) {
  const result = validateCredentialShape(input, vault);
  return serializeCredentialShapeValidation({
    platform: result.platform,
    credentialType: result.credentialType,
    safeMetadata: result.safeMetadata
  });
}
