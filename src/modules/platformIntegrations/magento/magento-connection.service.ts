import {
  PlatformConnectionStatus,
  PlatformSyncDirection,
  StorePlatform,
  MagentoInstallMode,
  MagentoWebhookStatus,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { serializeMagentoConnection } from "./magento.serializers.js";
import type {
  CreateMagentoConnectionInput,
  ListMagentoRecordsQueryInput,
  UpdateMagentoConnectionInput
} from "./magento.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

const secretKeyPattern = /(access[_-]?token|accesstoken|integration[_-]?token|integrationtoken|bearer[_-]?token|bearertoken|application[_-]?password|password|secret|token|api[_-]?key|client[_-]?secret|private[_-]?key)/i;
const secretValuePattern = /(bearer\s+|oauth_token|access_token|integration_token|admin_token|sk_live|sk_test|whsec_|magentotoken_|adobe_token_)/i;
const safeEnumKeys = new Set(["installMode", "webhookStatus"]);

export function assertNoRawMagentoSecrets(value: unknown, path = "body") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoRawMagentoSecrets(child, `${path}.${index}`));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = `${path}.${key}`;
    if (secretKeyPattern.test(key)) {
      throw new HttpError(400, "MAGENTO_RAW_SECRET_REJECTED", {
        field: keyPath,
        message: "Do not submit raw Magento/Adobe Commerce tokens or passwords here. Store secrets in the approved secret manager/credential vault."
      });
    }
    if (typeof child === "string" && !safeEnumKeys.has(key) && secretValuePattern.test(child)) {
      throw new HttpError(400, "MAGENTO_RAW_SECRET_REJECTED", {
        field: keyPath,
        message: "Do not submit raw Magento/Adobe Commerce tokens or passwords here. Store secrets in the approved secret manager/credential vault."
      });
    }
    assertNoRawMagentoSecrets(child, keyPath);
  }
}

function assertMagentoBaseUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "MAGENTO_BASE_URL_INVALID");
  }

  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!["https:", "http:"].includes(url.protocol) || (url.protocol !== "https:" && !local)) {
    throw new HttpError(400, "MAGENTO_BASE_URL_INVALID");
  }
  return url.toString();
}

export async function getMagentoConnectionRecord(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId, platform: StorePlatform.MAGENTO }
  });
  if (!connection) throw new HttpError(404, "MAGENTO_CONNECTION_NOT_FOUND");
  const state = await client.magentoConnectionState.findUnique({
    where: { connectionId: connection.id }
  });
  return { connection, state };
}

export async function createMagentoConnectionFoundation(
  merchantId: string,
  input: CreateMagentoConnectionInput,
  client: Db = prisma
) {
  assertNoRawMagentoSecrets(input);
  const baseUrl = assertMagentoBaseUrl(input.baseUrl);
  const apiVersion = input.apiVersion ?? null;
  const installMode = (input.installMode ?? MagentoInstallMode.INTEGRATION_TOKEN_PLACEHOLDER) as MagentoInstallMode;

  const connection = await client.platformConnection.create({
    data: {
      merchantId,
      platform: StorePlatform.MAGENTO,
      storeName: input.storeName ?? null,
      storeUrl: baseUrl,
      status: PlatformConnectionStatus.DRAFT,
      syncDirection: PlatformSyncDirection.IMPORT_ONLY,
      credentialsRef: input.credentialsRef ?? null,
      credentialsMeta: {
        base_url: baseUrl,
        store_view_code: input.storeViewCode ?? null,
        website_code: input.websiteCode ?? null,
        api_version: apiVersion,
        install_mode: installMode,
        foundation: "phase17_magento_native"
      }
    }
  });
  const state = await client.magentoConnectionState.create({
    data: {
      connectionId: connection.id,
      baseUrl,
      storeViewCode: input.storeViewCode ?? null,
      websiteCode: input.websiteCode ?? null,
      apiVersion,
      installMode,
      webhookStatus: MagentoWebhookStatus.NOT_CONFIGURED
    }
  });

  return serializeMagentoConnection(connection, state);
}

export async function getMagentoConnectionFoundation(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const { connection, state } = await getMagentoConnectionRecord(merchantId, connectionId, client);
  return serializeMagentoConnection(connection, state);
}

export async function listMagentoConnections(
  merchantId: string,
  query: ListMagentoRecordsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const where: Prisma.PlatformConnectionWhereInput = {
    merchantId,
    platform: StorePlatform.MAGENTO,
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
  const states = await client.magentoConnectionState.findMany({
    where: { connectionId: { in: connections.map((connection) => connection.id) } }
  });
  const statesByConnection = new Map(states.map((state) => [state.connectionId, state]));

  return {
    connections: connections.map((connection) => serializeMagentoConnection(connection, statesByConnection.get(connection.id) ?? null)),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function updateMagentoConnectionMetadata(
  merchantId: string,
  connectionId: string,
  input: UpdateMagentoConnectionInput,
  client: Db = prisma
) {
  assertNoRawMagentoSecrets(input);
  const { connection, state } = await getMagentoConnectionRecord(merchantId, connectionId, client);
  const connectionData: Prisma.PlatformConnectionUncheckedUpdateInput = {};
  if (input.storeName !== undefined) connectionData.storeName = input.storeName ?? null;
  if (input.baseUrl !== undefined) connectionData.storeUrl = assertMagentoBaseUrl(input.baseUrl);

  const updatedConnection = Object.keys(connectionData).length
    ? await client.platformConnection.update({ where: { id: connection.id }, data: connectionData })
    : connection;

  const stateData: Prisma.MagentoConnectionStateUncheckedUpdateInput = {};
  if (input.baseUrl !== undefined) stateData.baseUrl = assertMagentoBaseUrl(input.baseUrl);
  if (input.storeViewCode !== undefined) stateData.storeViewCode = input.storeViewCode ?? null;
  if (input.websiteCode !== undefined) stateData.websiteCode = input.websiteCode ?? null;
  if (input.apiVersion !== undefined) stateData.apiVersion = input.apiVersion ?? null;
  if (input.installMode !== undefined) stateData.installMode = input.installMode as MagentoInstallMode;
  if (input.webhookStatus !== undefined) stateData.webhookStatus = input.webhookStatus as MagentoWebhookStatus;

  const updatedState = state
    ? (Object.keys(stateData).length
      ? await client.magentoConnectionState.update({ where: { connectionId: connection.id }, data: stateData })
      : state)
    : await client.magentoConnectionState.create({
      data: {
        connectionId: connection.id,
        baseUrl: input.baseUrl ? assertMagentoBaseUrl(input.baseUrl) : connection.storeUrl,
        storeViewCode: input.storeViewCode ?? null,
        websiteCode: input.websiteCode ?? null,
        apiVersion: input.apiVersion ?? null,
        installMode: (input.installMode ?? MagentoInstallMode.INTEGRATION_TOKEN_PLACEHOLDER) as MagentoInstallMode,
        webhookStatus: (input.webhookStatus ?? MagentoWebhookStatus.NOT_CONFIGURED) as MagentoWebhookStatus
      }
    });

  return serializeMagentoConnection(updatedConnection, updatedState);
}

export async function disableMagentoConnection(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const { connection, state } = await getMagentoConnectionRecord(merchantId, connectionId, client);
  const updatedConnection = await client.platformConnection.update({
    where: { id: connection.id },
    data: {
      status: PlatformConnectionStatus.DISABLED,
      disabledAt: new Date()
    }
  });
  const updatedState = state
    ? await client.magentoConnectionState.update({
      where: { connectionId: connection.id },
      data: { webhookStatus: MagentoWebhookStatus.DISABLED }
    })
    : null;
  return serializeMagentoConnection(updatedConnection, updatedState);
}
