import {
  PlatformConnectionStatus,
  PlatformSyncDirection,
  StorePlatform,
  WooCommerceInstallMode,
  WooCommerceWebhookStatus,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { serializeWooCommerceConnection } from "./woocommerce.serializers.js";
import type {
  CreateWooCommerceConnectionInput,
  ListWooCommerceRecordsQueryInput,
  UpdateWooCommerceConnectionInput
} from "./woocommerce.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

const secretKeyPattern = /(consumer[_-]?key|consumerkey|consumer[_-]?secret|consumersecret|application[_-]?password|password|secret|token|api[_-]?key|access[_-]?key)/i;
const secretValuePattern = /(ck_|cs_|whsec_|sk_live|sk_test|access_token|consumer_secret|consumer_key)/i;

export function assertNoRawWooCommerceSecrets(value: unknown, path = "body") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoRawWooCommerceSecrets(child, `${path}.${index}`));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = `${path}.${key}`;
    if (secretKeyPattern.test(key)) {
      throw new HttpError(400, "WOOCOMMERCE_RAW_SECRET_REJECTED", {
        field: keyPath,
        message: "Do not submit raw WooCommerce consumer keys or secrets here. Store secrets in the approved secret manager/credential vault."
      });
    }
    if (typeof child === "string" && secretValuePattern.test(child)) {
      throw new HttpError(400, "WOOCOMMERCE_RAW_SECRET_REJECTED", {
        field: keyPath,
        message: "Do not submit raw WooCommerce consumer keys or secrets here. Store secrets in the approved secret manager/credential vault."
      });
    }
    assertNoRawWooCommerceSecrets(child, keyPath);
  }
}

function assertWooCommerceSiteUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "WOOCOMMERCE_SITE_URL_INVALID");
  }

  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!["https:", "http:"].includes(url.protocol) || (url.protocol !== "https:" && !local)) {
    throw new HttpError(400, "WOOCOMMERCE_SITE_URL_INVALID");
  }
  return url.toString();
}

export async function getWooCommerceConnectionRecord(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId, platform: StorePlatform.WOOCOMMERCE }
  });
  if (!connection) throw new HttpError(404, "WOOCOMMERCE_CONNECTION_NOT_FOUND");
  const state = await client.wooCommerceConnectionState.findUnique({
    where: { connectionId: connection.id }
  });
  return { connection, state };
}

export async function createWooCommerceConnectionFoundation(
  merchantId: string,
  input: CreateWooCommerceConnectionInput,
  client: Db = prisma
) {
  assertNoRawWooCommerceSecrets(input);
  const siteUrl = assertWooCommerceSiteUrl(input.siteUrl);
  const apiVersion = input.apiVersion ?? "wc/v3";
  const installMode = (input.installMode ?? WooCommerceInstallMode.REST_KEY_PLACEHOLDER) as WooCommerceInstallMode;

  const connection = await client.platformConnection.create({
    data: {
      merchantId,
      platform: StorePlatform.WOOCOMMERCE,
      storeName: input.storeName ?? null,
      storeUrl: siteUrl,
      status: PlatformConnectionStatus.DRAFT,
      syncDirection: PlatformSyncDirection.IMPORT_ONLY,
      credentialsRef: input.credentialsRef ?? null,
      credentialsMeta: {
        site_url: siteUrl,
        api_version: apiVersion,
        install_mode: installMode,
        foundation: "phase16_woocommerce_native"
      }
    }
  });
  const state = await client.wooCommerceConnectionState.create({
    data: {
      connectionId: connection.id,
      siteUrl,
      apiVersion,
      installMode,
      webhookStatus: WooCommerceWebhookStatus.NOT_CONFIGURED
    }
  });

  return serializeWooCommerceConnection(connection, state);
}

export async function getWooCommerceConnectionFoundation(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const { connection, state } = await getWooCommerceConnectionRecord(merchantId, connectionId, client);
  return serializeWooCommerceConnection(connection, state);
}

export async function listWooCommerceConnections(
  merchantId: string,
  query: ListWooCommerceRecordsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const where: Prisma.PlatformConnectionWhereInput = {
    merchantId,
    platform: StorePlatform.WOOCOMMERCE,
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
  const states = await client.wooCommerceConnectionState.findMany({
    where: { connectionId: { in: connections.map((connection) => connection.id) } }
  });
  const statesByConnection = new Map(states.map((state) => [state.connectionId, state]));

  return {
    connections: connections.map((connection) => serializeWooCommerceConnection(connection, statesByConnection.get(connection.id) ?? null)),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function updateWooCommerceConnectionMetadata(
  merchantId: string,
  connectionId: string,
  input: UpdateWooCommerceConnectionInput,
  client: Db = prisma
) {
  assertNoRawWooCommerceSecrets(input);
  const { connection, state } = await getWooCommerceConnectionRecord(merchantId, connectionId, client);
  const connectionData: Prisma.PlatformConnectionUncheckedUpdateInput = {};
  if (input.storeName !== undefined) connectionData.storeName = input.storeName ?? null;
  if (input.siteUrl !== undefined) connectionData.storeUrl = assertWooCommerceSiteUrl(input.siteUrl);

  const updatedConnection = Object.keys(connectionData).length
    ? await client.platformConnection.update({ where: { id: connection.id }, data: connectionData })
    : connection;

  const stateData: Prisma.WooCommerceConnectionStateUncheckedUpdateInput = {};
  if (input.siteUrl !== undefined) stateData.siteUrl = assertWooCommerceSiteUrl(input.siteUrl);
  if (input.apiVersion !== undefined) stateData.apiVersion = input.apiVersion ?? null;
  if (input.installMode !== undefined) stateData.installMode = input.installMode as WooCommerceInstallMode;
  if (input.webhookStatus !== undefined) stateData.webhookStatus = input.webhookStatus as WooCommerceWebhookStatus;

  const updatedState = state
    ? (Object.keys(stateData).length
      ? await client.wooCommerceConnectionState.update({ where: { connectionId: connection.id }, data: stateData })
      : state)
    : await client.wooCommerceConnectionState.create({
      data: {
        connectionId: connection.id,
        siteUrl: input.siteUrl ? assertWooCommerceSiteUrl(input.siteUrl) : connection.storeUrl,
        apiVersion: input.apiVersion ?? "wc/v3",
        installMode: (input.installMode ?? WooCommerceInstallMode.REST_KEY_PLACEHOLDER) as WooCommerceInstallMode,
        webhookStatus: (input.webhookStatus ?? WooCommerceWebhookStatus.NOT_CONFIGURED) as WooCommerceWebhookStatus
      }
    });

  return serializeWooCommerceConnection(updatedConnection, updatedState);
}

export async function disableWooCommerceConnection(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const { connection, state } = await getWooCommerceConnectionRecord(merchantId, connectionId, client);
  const updatedConnection = await client.platformConnection.update({
    where: { id: connection.id },
    data: {
      status: PlatformConnectionStatus.DISABLED,
      disabledAt: new Date()
    }
  });
  const updatedState = state
    ? await client.wooCommerceConnectionState.update({
      where: { connectionId: connection.id },
      data: { webhookStatus: WooCommerceWebhookStatus.DISABLED }
    })
    : null;
  return serializeWooCommerceConnection(updatedConnection, updatedState);
}
