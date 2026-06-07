import {
  PlatformConnectionStatus,
  PlatformSyncDirection,
  ShopifyInstallMode,
  ShopifyWebhookStatus,
  StorePlatform,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { serializeShopifyConnection } from "./shopify.serializers.js";
import type {
  CreateShopifyConnectionInput,
  ListShopifyRecordsQueryInput,
  UpdateShopifyConnectionInput
} from "./shopify.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

const tokenKeyPattern = /(access[_-]?token|accesstoken|token|password|secret|api[_-]?key|client[_-]?secret|private[_-]?app)/i;
const tokenValuePattern = /(shpat_|shpua_|shppa_|shpss_|xox|sk_live|sk_test|whsec_|access_token)/i;

export function assertNoRawShopifyTokens(value: unknown, path = "body") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoRawShopifyTokens(child, `${path}.${index}`));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = `${path}.${key}`;
    if (tokenKeyPattern.test(key)) {
      throw new HttpError(400, "SHOPIFY_RAW_TOKEN_REJECTED", {
        field: keyPath,
        message: "Do not submit raw Shopify access tokens here. Store secrets in the approved secret manager/credential vault."
      });
    }
    if (typeof child === "string" && tokenValuePattern.test(child)) {
      throw new HttpError(400, "SHOPIFY_RAW_TOKEN_REJECTED", {
        field: keyPath,
        message: "Do not submit raw Shopify access tokens here. Store secrets in the approved secret manager/credential vault."
      });
    }
    assertNoRawShopifyTokens(child, keyPath);
  }
}

export function normalizeShopDomain(rawDomain: string) {
  const trimmed = rawDomain.trim().toLowerCase();
  const hostname = trimmed.includes("://")
    ? new URL(trimmed).hostname
    : trimmed.split("/")[0] ?? "";
  const domain = hostname.replace(/\.$/, "");
  const isDomain = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain);
  if (!isDomain || ["localhost", "127.0.0.1", "::1"].includes(domain)) {
    throw new HttpError(400, "SHOPIFY_SHOP_DOMAIN_INVALID");
  }
  return domain;
}

function assertShopifyStoreUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "SHOPIFY_STORE_URL_INVALID");
  }

  if (url.protocol !== "https:") {
    throw new HttpError(400, "SHOPIFY_STORE_URL_INVALID");
  }
  return url.toString();
}

export async function getShopifyConnectionRecord(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId, platform: StorePlatform.SHOPIFY }
  });
  if (!connection) throw new HttpError(404, "SHOPIFY_CONNECTION_NOT_FOUND");
  const state = await client.shopifyConnectionState.findUnique({
    where: { connectionId: connection.id }
  });
  return { connection, state };
}

export async function createShopifyConnectionFoundation(
  merchantId: string,
  input: CreateShopifyConnectionInput,
  client: Db = prisma
) {
  assertNoRawShopifyTokens(input);
  const shopDomain = normalizeShopDomain(input.shopDomain);
  const installMode = (input.installMode ?? ShopifyInstallMode.CUSTOM_APP) as ShopifyInstallMode;
  const apiVersion = input.apiVersion ?? null;

  const connection = await client.platformConnection.create({
    data: {
      merchantId,
      platform: StorePlatform.SHOPIFY,
      storeName: input.storeName ?? null,
      storeUrl: assertShopifyStoreUrl(input.storeUrl),
      status: PlatformConnectionStatus.DRAFT,
      syncDirection: PlatformSyncDirection.IMPORT_ONLY,
      credentialsRef: input.credentialsRef ?? null,
      credentialsMeta: {
        shop_domain: shopDomain,
        api_version: apiVersion,
        install_mode: installMode,
        foundation: "phase15_shopify_native"
      }
    }
  });
  const state = await client.shopifyConnectionState.create({
    data: {
      connectionId: connection.id,
      shopDomain,
      apiVersion,
      installMode,
      webhookStatus: ShopifyWebhookStatus.NOT_CONFIGURED
    }
  });

  return serializeShopifyConnection(connection, state);
}

export async function getShopifyConnectionFoundation(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const { connection, state } = await getShopifyConnectionRecord(merchantId, connectionId, client);
  return serializeShopifyConnection(connection, state);
}

export async function listShopifyConnections(
  merchantId: string,
  query: ListShopifyRecordsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const where: Prisma.PlatformConnectionWhereInput = {
    merchantId,
    platform: StorePlatform.SHOPIFY,
    ...(query.status ? { status: query.status as PlatformConnectionStatus } : {})
  };
  const [connections, total] = await Promise.all([
    client.platformConnection.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.platformConnection.count({ where })
  ]);
  const states = await client.shopifyConnectionState.findMany({
    where: { connectionId: { in: connections.map((connection) => connection.id) } }
  });
  const statesByConnection = new Map(states.map((state) => [state.connectionId, state]));

  return {
    connections: connections.map((connection) => serializeShopifyConnection(connection, statesByConnection.get(connection.id) ?? null)),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function updateShopifyConnectionMetadata(
  merchantId: string,
  connectionId: string,
  input: UpdateShopifyConnectionInput,
  client: Db = prisma
) {
  assertNoRawShopifyTokens(input);
  const { connection, state } = await getShopifyConnectionRecord(merchantId, connectionId, client);
  const connectionData: Prisma.PlatformConnectionUncheckedUpdateInput = {};
  if (input.storeName !== undefined) connectionData.storeName = input.storeName ?? null;
  if (input.storeUrl !== undefined) connectionData.storeUrl = assertShopifyStoreUrl(input.storeUrl);

  const updatedConnection = Object.keys(connectionData).length
    ? await client.platformConnection.update({ where: { id: connection.id }, data: connectionData })
    : connection;

  const stateData: Prisma.ShopifyConnectionStateUncheckedUpdateInput = {};
  if (input.shopDomain !== undefined) stateData.shopDomain = normalizeShopDomain(input.shopDomain);
  if (input.apiVersion !== undefined) stateData.apiVersion = input.apiVersion ?? null;
  if (input.installMode !== undefined) stateData.installMode = input.installMode as ShopifyInstallMode;
  if (input.webhookStatus !== undefined) stateData.webhookStatus = input.webhookStatus as ShopifyWebhookStatus;

  const updatedState = state
    ? (Object.keys(stateData).length
      ? await client.shopifyConnectionState.update({ where: { connectionId: connection.id }, data: stateData })
      : state)
    : await client.shopifyConnectionState.create({
      data: {
        connectionId: connection.id,
        shopDomain: input.shopDomain ? normalizeShopDomain(input.shopDomain) : new URL(connection.storeUrl).hostname,
        apiVersion: input.apiVersion ?? null,
        installMode: (input.installMode ?? ShopifyInstallMode.CUSTOM_APP) as ShopifyInstallMode,
        webhookStatus: (input.webhookStatus ?? ShopifyWebhookStatus.NOT_CONFIGURED) as ShopifyWebhookStatus
      }
    });

  return serializeShopifyConnection(updatedConnection, updatedState);
}

export async function disableShopifyConnection(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const { connection, state } = await getShopifyConnectionRecord(merchantId, connectionId, client);
  const updatedConnection = await client.platformConnection.update({
    where: { id: connection.id },
    data: {
      status: PlatformConnectionStatus.DISABLED,
      disabledAt: new Date()
    }
  });
  const updatedState = state
    ? await client.shopifyConnectionState.update({
      where: { connectionId: connection.id },
      data: { webhookStatus: ShopifyWebhookStatus.DISABLED }
    })
    : null;
  return serializeShopifyConnection(updatedConnection, updatedState);
}
